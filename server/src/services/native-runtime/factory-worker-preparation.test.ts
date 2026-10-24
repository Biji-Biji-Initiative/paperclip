import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import { FACTORY_PACK_MISMATCH_SCRIPT, FactoryPublicPackMismatchError, FactoryWorkerPreparation } from "./factory-worker-preparation.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const canonical = (v: unknown): string => v && typeof v === "object"
  ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}"
  : JSON.stringify(v);
const hash = (v: string) => "sha256:" + createHash("sha256").update(v).digest("hex");
const expected = canonical({ digest: "sha256:" + "b".repeat(64), payload: { source: "controller" } });

function verifier(): RunProcessResult {
  const dir = mkdtempSync(join(tmpdir(), "public-pack-mismatch-")); dirs.push(dir);
  writeFileSync(join(dir, "provider-pack.json"), canonical({ digest: "sha256:" + "a".repeat(64), payload: { source: "worker" } }));
  const script = "const fs=require('node:fs'),crypto=require('node:crypto');const root=process.argv[1],expected=process.argv[2];" +
    "const canonical=v=>v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);" +
    "const manifest=JSON.parse(fs.readFileSync(root+'/provider-pack.json','utf8'));" + FACTORY_PACK_MISMATCH_SCRIPT;
  const child = spawnSync(process.execPath, ["-e", script, dir, expected], { encoding: "utf8", timeout: 5_000 });
  return { exitCode: child.status, signal: child.signal, timedOut: Boolean(child.error),
    stdout: child.stdout, stderr: child.stderr, pid: child.pid, startedAt: new Date().toISOString() };
}

describe("Factory completed public preparation failure", () => {
  it("accepts only its real fixed verifier's clean completed mismatch, scoped to this attempt", async () => {
    const run = randomUUID(), lease = randomUUID(), state = new FactoryWorkerPreparation(run, lease);
    const result = await state.command(async () => verifier());
    expect(result.exitCode).toBe(78); expect(result.stderr).toBe("");
    const error = state.mismatch(result, expected)!;
    expect(error).toBeInstanceOf(FactoryPublicPackMismatchError);
    expect(error.diagnostic.expectedManifestSha256).toBe(hash(expected));
    expect(state.canSettle(error, run, lease)).toBe(true);
    expect(state.canSettle(error, randomUUID(), lease)).toBe(false);
    expect(state.canSettle(error, run, randomUUID())).toBe(false);
    expect(new FactoryWorkerPreparation(run, lease).canSettle(error, run, lease)).toBe(false);
    expect(state.canSettle(new FactoryPublicPackMismatchError(error.diagnostic), run, lease)).toBe(false);
    expect(state.canSettle(new Error(error.message), run, lease)).toBe(false);
  });

  it.each(["timeout", "255", "null", "exception"])("retains sticky uncertainty after an earlier %s even if a later verifier completes", async kind => {
    const run = randomUUID(), lease = randomUUID(), state = new FactoryWorkerPreparation(run, lease);
    await state.command(async () => {
      if (kind === "exception") throw new Error("transport failed");
      return { ...verifier(), exitCode: kind === "null" ? null : kind === "255" ? 255 : 0, timedOut: kind === "timeout" };
    }).catch(() => undefined);
    const error = state.mismatch(await state.command(async () => verifier()), expected)!;
    expect(state.canSettle(error, run, lease)).toBe(false);
  });

  it.each(["admission", "foreground", "pending"])("refuses release after %s", async kind => {
    const run = randomUUID(), lease = randomUUID(), state = new FactoryWorkerPreparation(run, lease);
    const error = state.mismatch(await state.command(async () => verifier()), expected)!;
    let finish!: (v: RunProcessResult) => void;
    const pending = kind === "pending" ? state.command(() => new Promise<RunProcessResult>(resolve => { finish = resolve; })) : null;
    if (kind === "admission") state.markAdmissionAttempted();
    if (kind === "foreground") state.markForegroundAttempted();
    expect(state.canSettle(error, run, lease)).toBe(false);
    if (pending) { finish({ ...verifier(), exitCode: 0 }); await pending; }
  });

  it("rejects forged stdout, unknown shape and transport outcomes", () => {
    const state = new FactoryWorkerPreparation(randomUUID(), randomUUID()), valid = verifier();
    for (const patch of [
      { exitCode: 255 }, { exitCode: null }, { timedOut: true }, { stderr: "ssh warning" },
      { stdout: "manifest mismatch" }, { stdout: JSON.stringify({ ...JSON.parse(valid.stdout), extra: true }) },
      { stdout: JSON.stringify({ ...JSON.parse(valid.stdout), expectedManifestSha256: "sha256:" + "e".repeat(64) }) },
    ]) expect(state.mismatch({ ...valid, ...patch }, expected)).toBeNull();
  });
});
