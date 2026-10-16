import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFactoryWorkerLeaseDescriptor, FACTORY_COMPANY_ID } from "./factory-worker-lease.js";
import { FACTORY_ADMISSION_NAMESPACE, FACTORY_PROVIDER_MARKER, FACTORY_PROVIDER_POLICY,
  createFactoryControllerAdmission, encodeFactoryControllerAdmission, encodeFactoryProviderLaunch,
  signFactoryControllerAdmission, validateFactoryProviderBinding, type FactoryProviderBinding } from "./factory-provider-admission.js";

function fixture() {
  const workspaceId = randomUUID();
  const descriptor = createFactoryWorkerLeaseDescriptor({ companyId: FACTORY_COMPANY_ID, runId: randomUUID(), leaseId: randomUUID(),
    workspaceId, workspaceRoot: `/workspace/${FACTORY_COMPANY_ID}/${workspaceId}`, sessionId: "worker-session", deadlineUnixMs: Date.now() + 60000 });
  const binding: FactoryProviderBinding = { schema: "factory.provider-worker-binding.v2", provider: "codex", admissionId: randomUUID(),
    capabilityId: randomUUID(), normalizedSessionId: "native-session", runnerInstanceId: "runner-fixture", workerPlanSha256: "a".repeat(64),
    authorization: { schema: "factory.direct-board-wakeup.v1", actorType: "user", actorId: "synthetic-user", actorEmail: "synthetic@example.invalid",
      wakeupRequestId: randomUUID(), agentId: randomUUID(), requestedAtUnixMs: Date.now() - 1000 } };
  const prepared = { protocol: FACTORY_PROVIDER_MARKER, provider: binding.provider, type: "preparation", status: "prepared", companyId: descriptor.companyId,
    runId: descriptor.runId, leaseId: descriptor.leaseId, sessionId: descriptor.sessionId, ownerNonce: "b".repeat(32), bootId: randomUUID(),
    createdUnixMs: Date.now(), deadlineUnixMs: descriptor.deadlineUnixMs, workerPlanSha256: binding.workerPlanSha256, dispatchAttempted: false };
  const command = [`${descriptor.workspaceRoot}/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd`,
    "--run-id", descriptor.runId, "--environment-lease-id", descriptor.leaseId,
    "--session-id", binding.normalizedSessionId, "--runner-id", binding.runnerInstanceId];
  return { descriptor, binding, prepared, command };
}
const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("explicit provider launch and immutable controller record", () => {
  it.each(["codex", "claude"] as const)("requires closed authenticated own-run evidence for %s", provider => {
    const f = fixture(); f.binding.provider = provider; f.prepared.provider = provider;
    for (const authorization of [undefined, null, { ...f.binding.authorization, actorType: "agent" },
      { ...f.binding.authorization, actorId: "" }, { ...f.binding.authorization, actorEmail: "private\nvalue" },
      { ...f.binding.authorization, wakeupRequestId: "foreign" }, { ...f.binding.authorization, requestedAtUnixMs: Date.now() + 60_000 },
      { ...f.binding.authorization, token: "synthetic-extra-denied" }]) {
      expect(() => validateFactoryProviderBinding({ ...f.binding, authorization })).toThrow("factory_provider_admission_invalid");
    }
    const record = createFactoryControllerAdmission(f.descriptor, f.binding, f.prepared);
    expect(record.authorization).toEqual(f.binding.authorization);
    expect(record.authorization).not.toBe(f.binding.authorization);
    const encoded = encodeFactoryControllerAdmission(record).toString();
    expect(encoded.indexOf('"actorEmail"')).toBeLessThan(encoded.indexOf('"actorId"'));
    expect(JSON.parse(encoded).authorization).toEqual(f.binding.authorization);
  });
  it("binds native argv while retaining credential-free environment validation", () => {
    const f = fixture(), bootstrap = "bootstrap_" + randomUUID();
    const header = JSON.parse(encodeFactoryProviderLaunch(f.descriptor, f.binding, f.command,
      { PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: bootstrap }).toString());
    expect(header.protocol).toBe(FACTORY_PROVIDER_MARKER); expect(header.policy).toBe(FACTORY_PROVIDER_POLICY);
    expect(header.providerAdmission).toEqual(f.binding);
    expect(() => encodeFactoryProviderLaunch(f.descriptor, f.binding, [...f.command, "--runner-id", "foreign"])).toThrow();
    expect(() => encodeFactoryProviderLaunch(f.descriptor, f.binding, f.command, { OPENAI_API_KEY: "synthetic-rejected" })).toThrow();
    expect(() => encodeFactoryProviderLaunch(f.descriptor, f.binding, f.command, { PAPERCLIP_CODEX_EXTERNAL_AUTH_FD: "3" })).toThrow();
    const record = createFactoryControllerAdmission(f.descriptor, f.binding, f.prepared);
    const bytes = encodeFactoryControllerAdmission(record);
    expect(bytes.toString()).not.toContain(bootstrap);
    expect(Object.keys(record)).not.toContain("command"); expect(Object.keys(record)).not.toContain("environment");
    expect(bytes.at(-1)).toBe(10);
  });
  it("rejects untrusted prepared nonce, foreign identity, dispatched state and unknown fields", () => {
    const f = fixture();
    for (const changes of [{ ownerNonce: "../invalid" }, { bootId: "invalid" }, { runId: "foreign" },
      { workerPlanSha256: "c".repeat(64) }, { dispatchAttempted: true }, { deadlineUnixMs: 0 }, { account: "foreign" }]) {
      expect(() => createFactoryControllerAdmission(f.descriptor, f.binding, { ...f.prepared, ...changes })).toThrow();
    }
  });
  it.each(["codex", "claude"] as const)("binds %s explicitly in launch, prepared receipt and signed payload", provider => {
    const f = fixture(); f.binding.provider = provider; f.prepared.provider = provider;
    const header = JSON.parse(encodeFactoryProviderLaunch(f.descriptor, f.binding, f.command).toString());
    expect(header.protocol).toBe("factory-worker-provider-lease-v2");
    expect(header.policy).toBe("factory-worker-provider-scope-v2");
    expect(header.providerAdmission.provider).toBe(provider);
    const record = createFactoryControllerAdmission(f.descriptor, f.binding, f.prepared);
    expect(record.schema).toBe("factory.provider-controller-admission.v2");
    expect(JSON.parse(encodeFactoryControllerAdmission(record).toString()).provider).toBe(provider);
  });
  it("rejects old or provider-absent bindings and prepared receipts", () => {
    const f = fixture();
    const { provider: _bindingProvider, ...withoutProvider } = f.binding;
    for (const value of [withoutProvider, { ...f.binding, schema: "factory.provider-worker-binding.v1" }]) {
      expect(() => validateFactoryProviderBinding(value)).toThrow("factory_provider_admission_invalid");
    }
    const { provider: _receiptProvider, ...withoutReceiptProvider } = f.prepared;
    for (const value of [withoutReceiptProvider, { ...f.prepared, provider: "claude" },
      { ...f.prepared, protocol: "factory-worker-provider-lease-v1" }]) {
      expect(() => createFactoryControllerAdmission(f.descriptor, f.binding, value)).toThrow("factory_provider_admission_invalid");
    }
    const record = createFactoryControllerAdmission(f.descriptor, f.binding, f.prepared);
    for (const [key, value] of [["provider", undefined], ["provider", "unregistered"],
      ["schema", "factory.provider-controller-admission.v1"]] as const) {
      const invalid = { ...record }; Reflect.set(invalid, key, value);
      expect(() => encodeFactoryControllerAdmission(invalid)).toThrow("factory_provider_admission_invalid");
    }
  });
  it("does not accept another provider or request-selected source/account fields", () => {
    const f = fixture();
    for (const changes of [{ provider: "unregistered" }, { source: "/arbitrary" }, { account: "arbitrary" }]) {
      expect(() => encodeFactoryProviderLaunch(f.descriptor, { ...f.binding, ...changes } as FactoryProviderBinding, f.command)).toThrow();
    }
  });
});

describe("scoped SSHSIG signer", () => {
  it("signs stdin with a disposable key and verifies in the exact namespace", async () => {
    const directory = await mkdtemp("/data/tmp/factory-signature-test-"); cleanups.push(directory);
    const key = join(directory, "fixture");
    const generated = spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", key],
      { stdio: "ignore", timeout: 5000, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
    expect(generated.status).toBe(0);
    const f = fixture(), record = createFactoryControllerAdmission(f.descriptor, f.binding, f.prepared);
    const signed = await signFactoryControllerAdmission(record, key, undefined,
      (args, env) => spawn("/usr/bin/ssh-keygen", [...args], { stdio: ["pipe", "pipe", "pipe"], env }));
    expect(Buffer.from(signed.payload, "base64")).toEqual(encodeFactoryControllerAdmission(record));
    const signers = join(directory, "allowed_signers"), signature = join(directory, "signature");
    await writeFile(signature, signed.signature, { mode: 0o600 });
    await writeFile(signers, `factory-${FACTORY_COMPANY_ID}@mereka.io namespaces="${FACTORY_ADMISSION_NAMESPACE}" ` +
      (await readFile(key + ".pub", "utf8")).trim() + "\n", { mode: 0o600 });
    for (const namespace of [FACTORY_ADMISSION_NAMESPACE, "factory-provider-admission-v1@mereka.io", "foreign@mereka.io"]) {
      const result = spawnSync("/usr/bin/ssh-keygen", ["-Y", "verify", "-f", signers, "-I", `factory-${FACTORY_COMPANY_ID}@mereka.io`,
        "-n", namespace, "-s", signature], { input: Buffer.from(signed.payload, "base64"), stdio: ["pipe", "ignore", "ignore"],
        timeout: 5000, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
      expect(result.status === 0).toBe(namespace === FACTORY_ADMISSION_NAMESPACE);
    }
    // A valid provider substitution is still a signature forgery, not merely a schema error.
    const tampered = encodeFactoryControllerAdmission({ ...record, provider: "claude" });
    const rejected = spawnSync("/usr/bin/ssh-keygen", ["-Y", "verify", "-f", signers,
      "-I", `factory-${FACTORY_COMPANY_ID}@mereka.io`, "-n", FACTORY_ADMISSION_NAMESPACE, "-s", signature],
      { input: tampered, stdio: ["pipe", "ignore", "ignore"], timeout: 5000, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
    expect(rejected.status).not.toBe(0);

  });
  it("never starts a signer for a pre-aborted admission", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    const start = vi.fn();
    await expect(signFactoryControllerAdmission(createFactoryControllerAdmission(f.descriptor, f.binding, f.prepared),
      "/synthetic/key", controller.signal, start)).rejects.toThrow("factory_provider_signing_held");
    expect(start).not.toHaveBeenCalled();
  });
  it("aborts and retires its owned local signer without exposing raw errors", async () => {
    const f = fixture(), controller = new AbortController();
    const child = spawn("/usr/bin/python3", ["-c", "import time; time.sleep(10)"],
      { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C" } });
    const closed = once(child, "close");
    const result = signFactoryControllerAdmission(createFactoryControllerAdmission(f.descriptor, f.binding, f.prepared),
      "/synthetic/key", controller.signal, () => child);
    controller.abort();
    await expect(result).rejects.toThrow("factory_provider_signing_held");
    await closed; expect(child.killed).toBe(true);
  });
});
