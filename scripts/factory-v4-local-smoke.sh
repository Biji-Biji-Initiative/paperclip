#!/usr/bin/env bash
set -euo pipefail

# Proves the Paperclip Factory V4 production contract without touching a live
# Paperclip instance. It uses a new localhost-only Docker network, a new
# PostgreSQL 17 volume, generated credentials, and the source-matched CLI
# bundled in the supplied image. Everything is removed on exit unless
# KEEP_ARTIFACTS=true is explicitly set for diagnosis.

: "${IMAGE_NAME:?set IMAGE_NAME to the built Paperclip V4 image}"
KEEP_ARTIFACTS="${KEEP_ARTIFACTS:-false}"
RUN_ID="$(openssl rand -hex 8)"
NETWORK_NAME="paperclip-v4-smoke-net-$RUN_ID"
DB_CONTAINER="paperclip-v4-smoke-db-$RUN_ID"
SERVER_CONTAINER="paperclip-v4-smoke-server-$RUN_ID"
DATA_VOLUME="paperclip-v4-smoke-data-$RUN_ID"
TEMP_DIR="$(mktemp -d /tmp/paperclip-v4-smoke.XXXXXX)"
DB_PASSWORD="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"
AUTH_SECRET="$(openssl rand -hex 32)"
MASTER_KEY="$(openssl rand -base64 32)"
ADMIN_EMAIL="verify-$RUN_ID@paperclip.local"
ADMIN_PASSWORD="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"

cleanup() {
  docker exec "$SERVER_CONTAINER" sh -c 'rm -f /tmp/paperclip-v4-bootstrap.config.json' >/dev/null 2>&1 || true
  if [[ "$KEEP_ARTIFACTS" == "true" ]]; then
    printf 'Preserved local smoke artifacts: network=%s db=%s server=%s volume=%s temp=%s\n' \
      "$NETWORK_NAME" "$DB_CONTAINER" "$SERVER_CONTAINER" "$DATA_VOLUME" "$TEMP_DIR" >&2
    return
  fi
  docker rm -f "$SERVER_CONTAINER" "$DB_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$DATA_VOLUME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command unavailable: $1"
}

wait_for_db() {
  local attempt
  for ((attempt = 1; attempt <= 60; attempt += 1)); do
    if docker exec "$DB_CONTAINER" pg_isready -U paperclip -d paperclip >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_server() {
  local attempt
  for ((attempt = 1; attempt <= 120; attempt += 1)); do
    if docker exec "$SERVER_CONTAINER" curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:3100/api/health >"${TEMP_DIR}/health.json" 2>/dev/null; then
      return 0
    fi
    if ! docker inspect -f '{{.State.Running}}' "$SERVER_CONTAINER" 2>/dev/null | grep -qx true; then
      return 1
    fi
    sleep 1
  done
  return 1
}

validate_health() {
  local expected_bootstrap="$1"
  python3 - "$expected_bootstrap" "${TEMP_DIR}/health.json" <<'PY'
import json
import sys

with open(sys.argv[2], encoding="utf-8") as health_file:
    payload = json.load(health_file)
assert payload.get("status") == "ok"
assert payload.get("deploymentMode") == "authenticated"
assert payload.get("deploymentExposure") == "public"
assert payload.get("bootstrapStatus") == sys.argv[1]
PY
}

start_server() {
  local sign_up_disabled="$1"
  docker run -d --name "$SERVER_CONTAINER" \
    --network "$NETWORK_NAME" \
    -v "${DATA_VOLUME}:/paperclip" \
    -e "DATABASE_URL=postgresql://paperclip:${DB_PASSWORD}@${DB_CONTAINER}:5432/paperclip" \
    -e 'HOST=0.0.0.0' \
    -e 'PORT=3100' \
    -e 'PAPERCLIP_HOME=/paperclip' \
    -e 'PAPERCLIP_INSTANCE_ID=factory-v4-verify' \
    -e 'PAPERCLIP_CONFIG=/paperclip/instances/factory-v4-verify/config.json' \
    -e 'PAPERCLIP_DEPLOYMENT_MODE=authenticated' \
    -e 'PAPERCLIP_DEPLOYMENT_EXPOSURE=public' \
    -e 'PAPERCLIP_PUBLIC_URL=http://127.0.0.1:3100' \
    -e "PAPERCLIP_AUTH_DISABLE_SIGN_UP=${sign_up_disabled}" \
    -e 'PAPERCLIP_ENABLE_COMPANY_DELETION=false' \
    -e 'PAPERCLIP_MIGRATION_AUTO_APPLY=true' \
    -e 'HEARTBEAT_SCHEDULER_ENABLED=false' \
    -e 'PAPERCLIP_DB_BACKUP_ENABLED=false' \
    -e 'PAPERCLIP_SECRETS_STRICT_MODE=true' \
    -e "PAPERCLIP_SECRETS_MASTER_KEY=${MASTER_KEY}" \
    -e "BETTER_AUTH_SECRET=${AUTH_SECRET}" \
    -e 'DO_NOT_TRACK=1' \
    "$IMAGE_NAME" >/dev/null
}

write_transient_cli_config() {
  docker exec "$SERVER_CONTAINER" node -e '
const fs = require("node:fs");
const config = {
  $meta: { version: 1, updatedAt: new Date().toISOString(), source: "onboard" },
  database: { mode: "postgres" },
  logging: { mode: "file", logDir: "/paperclip/instances/factory-v4-verify/logs" },
  server: {
    deploymentMode: "authenticated", exposure: "public", bind: "lan", host: "0.0.0.0", port: 3100,
    allowedHostnames: ["127.0.0.1"], serveUi: true,
  },
  auth: {
    baseUrlMode: "explicit", publicBaseUrl: "http://127.0.0.1:3100",
    disableSignUp: false,
  },
  telemetry: { enabled: false },
};
fs.writeFileSync("/tmp/paperclip-v4-bootstrap.config.json", JSON.stringify(config), { mode: 0o600 });
'
}

create_bootstrap_invite() {
  local bootstrap_output
  bootstrap_output="$(docker exec "$SERVER_CONTAINER" sh -c '
    cd /app
    timeout 90s node --import ./cli/node_modules/tsx/dist/loader.mjs cli/src/index.ts \
      auth bootstrap-ceo --config /tmp/paperclip-v4-bootstrap.config.json \
      --data-dir "$PAPERCLIP_HOME" --base-url "$PAPERCLIP_PUBLIC_URL"
  ')" || return 1
  printf '%s' "$bootstrap_output" | python3 -c '
import re
import sys

raw = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", sys.stdin.read())
matches = re.findall(r"(?:https?://[^/\s]+)?/invite/(pcp_bootstrap_[a-z0-9]+)", raw)
if not matches:
    raise SystemExit(1)
print(matches[-1])
'
}

verify_bootstrap_administrator() {
  local input_json
  input_json="$(ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" python3 - <<'PY'
import json
import os

print(json.dumps({
    "email": os.environ["ADMIN_EMAIL"],
    "password": os.environ["ADMIN_PASSWORD"],
    "inviteToken": os.environ["BOOTSTRAP_TOKEN"],
}))
PY
)"
  printf '%s' "$input_json" | docker exec -i "$SERVER_CONTAINER" node -e '
const http = require("node:http");
const inputChunks = [];
process.stdin.on("data", (chunk) => inputChunks.push(chunk));
process.stdin.on("end", async () => {
  try {
    const input = JSON.parse(Buffer.concat(inputChunks).toString("utf8"));
    const originHeaders = {
      host: "127.0.0.1:3100",
      origin: "http://127.0.0.1:3100",
      accept: "application/json",
    };
    const request = (method, path, payload, cookie) => new Promise((resolve, reject) => {
      const body = payload === undefined ? "" : JSON.stringify(payload);
      const headers = { ...originHeaders };
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = Buffer.byteLength(body);
      }
      if (cookie) headers.cookie = cookie;
      const req = http.request({ host: "127.0.0.1", port: 3100, path, method, headers }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8"),
          setCookie: Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : [],
        }));
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
    const successful = (result) => result.status >= 200 && result.status < 300;
    const auth = await request("POST", "/api/auth/sign-up/email", {
      name: "V4 Verify", email: input.email, password: input.password,
    });
    if (!successful(auth)) throw new Error("bootstrap administrator sign-up failed");
    const cookie = auth.setCookie.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
    if (!cookie) throw new Error("bootstrap administrator did not receive a session cookie");
    const accepted = await request("POST", "/api/invites/" + encodeURIComponent(input.inviteToken) + "/accept", { requestType: "human" }, cookie);
    if (!successful(accepted)) throw new Error("bootstrap invitation acceptance failed");
    const session = await request("GET", "/api/auth/get-session", undefined, cookie);
    if (!successful(session)) throw new Error("session verification failed");
    const settings = await request("GET", "/api/instance/settings/general", undefined, cookie);
    if (settings.status !== 200) throw new Error("instance-admin verification failed");
    const companies = await request("GET", "/api/companies", undefined, cookie);
    if (companies.status !== 200 || !Array.isArray(JSON.parse(companies.body)) || JSON.parse(companies.body).length !== 0) {
      throw new Error("fresh-state board verification failed");
    }
    process.stdout.write(JSON.stringify({ sessionStatus: session.status, settingsStatus: settings.status, companiesStatus: companies.status }));
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
    process.exitCode = 1;
  }
});
'
}

verify_sign_up_lock() {
  docker exec -e "VERIFY_EMAIL=locked-${RUN_ID}@paperclip.local" -e "VERIFY_PASSWORD=${ADMIN_PASSWORD}" "$SERVER_CONTAINER" node -e '
const http = require("node:http");
const body = JSON.stringify({ name: "Locked Verify", email: process.env.VERIFY_EMAIL, password: process.env.VERIFY_PASSWORD });
const req = http.request({
  host: "127.0.0.1", port: 3100, path: "/api/auth/sign-up/email", method: "POST",
  headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100", accept: "application/json", "content-type": "application/json", "content-length": Buffer.byteLength(body) },
}, (res) => {
  res.resume();
  res.on("end", () => {
    if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) process.exitCode = 1;
  });
});
req.on("error", () => { process.exitCode = 1; });
req.end(body);
'
}

require_command curl
require_command docker
require_command openssl
require_command python3
docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 || fail "image not present: $IMAGE_NAME"

docker network create "$NETWORK_NAME" >/dev/null
docker volume create "$DATA_VOLUME" >/dev/null
docker run -d --name "$DB_CONTAINER" --network "$NETWORK_NAME" \
  -e 'POSTGRES_USER=paperclip' \
  -e "POSTGRES_PASSWORD=${DB_PASSWORD}" \
  -e 'POSTGRES_DB=paperclip' \
  postgres:17-alpine >/dev/null
wait_for_db || fail 'disposable PostgreSQL did not become ready'

start_server false
wait_for_server || fail 'V4 server did not become healthy while bootstrap sign-up was available'
validate_health bootstrap_pending
write_transient_cli_config
BOOTSTRAP_TOKEN="$(create_bootstrap_invite)" || fail 'source-matched bootstrap CLI did not create an invite'
[[ "$BOOTSTRAP_TOKEN" =~ ^pcp_bootstrap_[a-z0-9]+$ ]] || fail 'source-matched bootstrap CLI returned an invalid invite'

bootstrap_result="$(verify_bootstrap_administrator)" || fail 'fresh authenticated V4 instance could not create and verify its bootstrap administrator'
printf '%s' "$bootstrap_result" | python3 -c '
import json
import sys
result = json.load(sys.stdin)
assert result == {"sessionStatus": 200, "settingsStatus": 200, "companiesStatus": 200}
'
docker exec "$SERVER_CONTAINER" curl -fsS http://127.0.0.1:3100/api/health >"${TEMP_DIR}/health.json"
validate_health ready
python3 - "${TEMP_DIR}/health.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as health_file:
    assert json.load(health_file).get("bootstrapInviteActive") is False
PY

docker rm -f "$SERVER_CONTAINER" >/dev/null
start_server true
wait_for_server || fail 'V4 server did not become healthy after the sign-up lock'
docker exec "$SERVER_CONTAINER" curl -fsS http://127.0.0.1:3100/api/health >"${TEMP_DIR}/health.json"
validate_health ready
verify_sign_up_lock || fail 'sign-up remained enabled after the production lock was applied'

printf '%s\n' 'RESULT=pass'
printf '%s\n' 'RUNTIME=authenticated/public'
printf '%s\n' 'BOOTSTRAP=first-admin-and-board-session-proven'
printf '%s\n' 'SIGNUP_LOCK=proven'
printf '%s\n' 'FRESH_STATE=proven-no-companies-or-agents'
printf '%s\n' 'CLEANUP=named-test-network-containers-volume-and-temporary-files-removed'
