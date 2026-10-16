import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const docker = readFileSync(new URL("Dockerfile", root), "utf8");
const helper = readFileSync(new URL("packages/paperclip-runner/scripts/build-runner-binary.mjs", root), "utf8");
const runs = [];
const lines = docker.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith("RUN ")) continue;
  let command = lines[i].slice(4);
  while (lines[i].endsWith("\\")) command += "\n" + lines[++i];
  runs.push(command);
}
const stages = runs.filter(x => x.includes("cargo chef cook") || x.includes("cargo build --release --manifest-path"));
assert.equal(stages.length, 2);
assert.match(docker, /FROM runner-deps AS runner-build/);
assert.match(docker, /FROM runner-build AS build/);
assert.match(docker, /ARG PAPERCLIP_RUNNER_SUBSCRIPTIONS_ONLY=false/);

test("Final image CLI uses the same Codex version as the verified provider pack", () => {
  const pkg = JSON.parse(readFileSync(new URL("packages/paperclip-runner/package.json", root), "utf8"));
  const versions = [...docker.matchAll(/@openai\/codex@([0-9.]+)/g)].map(match => match[1]);
  assert.deepEqual(versions, [pkg.dependencies["@openai/codex"]]);
});

function fixture() {
  const dir = mkdtempSync("/data/tmp/factory-build-mode-");
  const bin = join(dir, "bin"), work = join(dir, "work");
  mkdirSync(bin); mkdirSync(work);
  mkdirSync(join(work, "runner")); mkdirSync(join(work, "protocol")); mkdirSync(join(work, "scripts"));
  writeFileSync(join(work, "rust-toolchain.toml"), "");
  writeFileSync(join(bin, "cargo"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$FACTORY_TEST_ARGS"\nexit "${FACTORY_TEST_EXIT:-0}"\n', { mode: 0o700 });
  writeFileSync(join(work, "scripts/build-runner-binary.mjs"), helper);
  writeFileSync(join(work, "scripts/stage-runner-binary.mjs"), 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.FACTORY_TEST_STAGED, "yes");\n');
  return { dir, work, env: { ...process.env, PATH: bin + ":" + process.env.PATH,
    FACTORY_TEST_ARGS: join(dir, "args"), FACTORY_TEST_STAGED: join(dir, "staged") } };
}
for (const [index, command] of stages.entries()) {
  for (const mode of ["false", "true", "invalid"]) {
    test(`Docker native stage ${index}: ${mode}`, () => {
      const f = fixture();
      try {
        const result = spawnSync("/bin/sh", ["-c", command], { cwd: f.work, env: { ...f.env, PAPERCLIP_RUNNER_SUBSCRIPTIONS_ONLY: mode } });
        assert.equal(result.status, mode === "invalid" ? 64 : 0, result.stderr.toString());
        assert.equal(existsSync(f.env.FACTORY_TEST_ARGS), mode !== "invalid");
        if (mode !== "invalid") {
          const args = readFileSync(f.env.FACTORY_TEST_ARGS, "utf8").trim().split("\n");
          assert.equal(args.includes("--no-default-features"), mode === "true");
        }
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
  }
}
for (const mode of [undefined, "false", "true", "invalid"]) {
  test(`Recursive package native build: ${mode ?? "unset"}`, () => {
    const f = fixture();
    try {
      const env = { ...f.env };
      delete env.PAPERCLIP_RUNNER_SUBSCRIPTIONS_ONLY;
      if (mode !== undefined) env.PAPERCLIP_RUNNER_SUBSCRIPTIONS_ONLY = mode;
      const result = spawnSync(process.execPath, ["scripts/build-runner-binary.mjs"], { cwd: f.work, env });
      assert.equal(result.status, mode === "invalid" ? 1 : 0, result.stderr.toString());
      assert.equal(existsSync(env.FACTORY_TEST_STAGED), mode !== "invalid");
      if (mode !== "invalid") {
        const args = readFileSync(env.FACTORY_TEST_ARGS, "utf8").trim().split("\n");
        assert.equal(args.includes("--no-default-features"), mode === "true");
        assert.deepEqual(args.slice(0, 4), ["build", "--release", "--manifest-path", "runner/Cargo.toml"]);
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}
test("Failed native compilation never stages a previous binary", () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, ["scripts/build-runner-binary.mjs"], { cwd: f.work,
      env: { ...f.env, PAPERCLIP_RUNNER_SUBSCRIPTIONS_ONLY: "true", FACTORY_TEST_EXIT: "7" } });
    assert.equal(result.status, 7);
    assert.equal(existsSync(f.env.FACTORY_TEST_STAGED), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

