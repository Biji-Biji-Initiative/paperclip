#!/usr/bin/env python3
"""Resolve the real production Compose contract without starting resources."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "xc4zcdntt8nw7kd3vdqkzuo8_paperclip-factory-v4-r1-"


def config(suffix="", missing_image=False):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("PAPERCLIP_", "POSTGRES_", "BETTER_AUTH_"))}
    env.update(DATABASE_URL="postgresql://paperclip:fixture@db:5432/paperclip",
               POSTGRES_PASSWORD="fixture-database-password", PAPERCLIP_SECRETS_MASTER_KEY="fixture-master-key",
               BETTER_AUTH_SECRET="fixture-session-secret", PAPERCLIP_AUTHENTIK_CLIENT_SECRET="fixture-client-secret",
               PAPERCLIP_AUTHENTIK_COMPANY_ID="00000000-0000-4000-8000-000000000001",
               PAPERCLIP_NATIVE_SECCOMP_PATH="/etc/paperclip/factory-native-seccomp.json",
               PAPERCLIP_FACTORY_RECOVERY_SUFFIX=suffix)
    if not missing_image:
        env["PAPERCLIP_FACTORY_IMAGE"] = "sha256:" + "a" * 64
    with tempfile.TemporaryDirectory(prefix="factory-compose-", dir="/data/tmp") as folder:
        empty_env = Path(folder) / "empty.env"
        empty_env.touch(mode=0o600)
        result = subprocess.run(["docker", "compose", "--env-file", str(empty_env), "-f",
                                 str(ROOT / "deploy/factory-v4.coolify.compose.yaml"), "config", "--format", "json"],
                                env=env, capture_output=True, text=True, timeout=30)
    return result


class RecoveryVolumes(unittest.TestCase):
    def test_normal_operation_preserves_both_existing_external_volumes(self):
        result = config()
        self.assertEqual(result.returncode, 0, result.stderr)
        model = json.loads(result.stdout)
        for tail in ("pgdata", "data"):
            self.assertEqual(model["volumes"]["paperclip-factory-v4-r1-" + tail],
                             {"name": PREFIX + tail, "external": True})
        self.assertEqual(model["services"]["server"]["pull_policy"], "never")
        self.assertNotIn("build", model["services"]["server"])

    def test_one_recovery_suffix_selects_a_complete_external_pair(self):
        suffix = "-restore-20261015T191900Z"
        result = config(suffix)
        self.assertEqual(result.returncode, 0, result.stderr)
        model = json.loads(result.stdout)
        for tail in ("pgdata", "data"):
            self.assertEqual(model["volumes"]["paperclip-factory-v4-r1-" + tail],
                             {"name": PREFIX + tail + suffix, "external": True})

    def test_missing_qualified_image_fails_before_any_resource_is_started(self):
        result = config(missing_image=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PAPERCLIP_FACTORY_IMAGE", result.stderr)


if __name__ == "__main__":
    unittest.main()
