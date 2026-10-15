import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stampRuntimePackageVersions } from "./stamp-runtime-package-versions.mjs";

test("release metadata preserves workspace dependencies and third-party versions", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-release-metadata-"));
  try {
    mkdirSync(join(root, "server"));
    const pkg = { name: "@paperclipai/server", version: "0.3.1", dependencies: { "@paperclipai/db": "workspace:*", express: "^5.1.0" } };
    writeFileSync(join(root, "server/package.json"), JSON.stringify(pkg));
    writeFileSync(join(root, "third-party.json"), '{"version":"1.2.3"}');
    const entries = [{ dir: "server", name: pkg.name }];
    const version = "2026.1012.0-factory-sso.2";
    assert.deepEqual(stampRuntimePackageVersions(root, version, "a".repeat(40), entries), { version, commit: "a".repeat(40), packages: 1 });
    assert.deepEqual(JSON.parse(readFileSync(join(root, "server/package.json"))), { ...pkg, version });
    assert.equal(readFileSync(join(root, "third-party.json"), "utf8"), '{"version":"1.2.3"}');
    for (const bad of ["", "latest", "2026.1012"]) {
      assert.throws(() => stampRuntimePackageVersions(root, bad, "a".repeat(40), entries));
    }
    assert.throws(() => stampRuntimePackageVersions(root, version, "short", entries));
    assert.throws(() => stampRuntimePackageVersions(root, version, "a".repeat(40), [{ dir: "..", name: pkg.name }]));
    assert.throws(() => stampRuntimePackageVersions(root, version, "a".repeat(40), [{ dir: "server", name: "wrong" }]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
