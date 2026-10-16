import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.env.PAPERCLIP_RUNNER_SUBSCRIPTIONS_ONLY ?? "false";
if (mode !== "true" && mode !== "false") {
  throw new Error("Invalid PAPERCLIP_RUNNER_SUBSCRIPTIONS_ONLY");
}
const cwd = fileURLToPath(new URL("../", import.meta.url));
const args = ["build", "--release", "--manifest-path", "runner/Cargo.toml", "--locked",
  "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd"];
if (mode === "true") args.push("--no-default-features");
for (const [command, argv] of [["cargo", args], [process.execPath, ["scripts/stage-runner-binary.mjs"]]]) {
  const result = spawnSync(command, argv, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
