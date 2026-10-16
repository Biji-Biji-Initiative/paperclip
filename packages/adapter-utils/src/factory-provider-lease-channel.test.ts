import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FACTORY_COMPANY_ID, FactoryWorkerBusyError, createFactoryWorkerLeaseDescriptor } from "./factory-worker-lease.js";
import { FACTORY_ADMISSION_SIGNED_SCHEMA, FACTORY_PROVIDER_MARKER, encodeFactoryControllerAdmission,
  encodeFactoryProviderLaunch, type FactoryControllerAdmission, type FactoryProviderBinding } from "./factory-provider-admission.js";
import { admitFactoryProviderLease } from "./factory-provider-lease-channel.js";
import type { SshChannelExit, SshProcessChannel } from "./ssh-process-channel.js";

function fixture() {
  const workspaceId = randomUUID();
  const descriptor = createFactoryWorkerLeaseDescriptor({ companyId: FACTORY_COMPANY_ID, runId: randomUUID(), leaseId: randomUUID(),
    workspaceId, workspaceRoot: `/workspace/${FACTORY_COMPANY_ID}/${workspaceId}`, sessionId: "worker-session", deadlineUnixMs: Date.now() + 60000 });
  const binding: FactoryProviderBinding = { schema: "factory.provider-worker-binding.v1", provider: "codex", admissionId: randomUUID(),
    capabilityId: randomUUID(), normalizedSessionId: "native-session", runnerInstanceId: "runner-fixture", workerPlanSha256: "a".repeat(64) };
  const prepared = { protocol: FACTORY_PROVIDER_MARKER, type: "preparation", status: "prepared", companyId: descriptor.companyId,
    runId: descriptor.runId, leaseId: descriptor.leaseId, sessionId: descriptor.sessionId, ownerNonce: "b".repeat(32), bootId: randomUUID(),
    createdUnixMs: Date.now(), deadlineUnixMs: descriptor.deadlineUnixMs, workerPlanSha256: binding.workerPlanSha256, dispatchAttempted: false };
  const command = [`${descriptor.workspaceRoot}/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd`, "--run-id", descriptor.runId,
    "--environment-lease-id", descriptor.leaseId, "--session-id", binding.normalizedSessionId, "--runner-id", binding.runnerInstanceId];
  const header = encodeFactoryProviderLaunch(descriptor, binding, command);
  const identity = { companyId: descriptor.companyId, runId: descriptor.runId, leaseId: descriptor.leaseId, sessionId: descriptor.sessionId };
  const accepted = { protocol: FACTORY_PROVIDER_MARKER, type: "admission", status: "accepted", ...identity, dispatchAttempted: true };
  return { descriptor, binding, prepared, accepted, identity, header };
}
function rawChannel() {
  let data: ((value: Uint8Array) => void) | undefined, exit: ((value: SshChannelExit) => void) | undefined;
  const writes: Buffer[] = [];
  let onWrite: ((count: number) => void) | undefined;
  const stop = vi.fn(), close = vi.fn(async () => {}), endInput = vi.fn();
  const raw: SshProcessChannel = { write: () => {}, endInput, async writeInput(bytes) { writes.push(Buffer.from(bytes)); onWrite?.(writes.length); },
    onData(fn) { data = fn; }, onExit(fn) { exit = fn; }, onStderr() {}, stop, close };
  return { raw, writes, stop, close, endInput, writeHook(fn: (count: number) => void) { onWrite = fn; },
    send(value: unknown) { data?.(Buffer.from(JSON.stringify(value) + "\n")); },
    bytes(value: string) { data?.(Buffer.from(value)); }, finish(value: SshChannelExit) { exit?.(value); } };
}
function signed(record: FactoryControllerAdmission) {
  return { schema: FACTORY_ADMISSION_SIGNED_SCHEMA, payload: encodeFactoryControllerAdmission(record).toString("base64"),
    signature: "-----BEGIN SSH SIGNATURE-----\nsynthetic-only\n-----END SSH SIGNATURE-----\n" };
}

describe("explicit preparing → signed admission → dispatch handshake", () => {
  it("accepts split prepared receipt, signs metadata only, and preserves coalesced completion", async () => {
    const f = fixture(), raw = rawChannel();
    raw.writeHook(count => queueMicrotask(() => {
      if (count === 1) { const line = JSON.stringify(f.prepared) + "\n"; raw.bytes(line.slice(0, 9)); raw.bytes(line.slice(9)); }
      else { raw.bytes(JSON.stringify(f.accepted) + "\n" + '{"type":"completion"}\n'); }
    }));
    const sign = vi.fn(async (record: FactoryControllerAdmission) => signed(record));
    const channel = await admitFactoryProviderLease(raw.raw, f.descriptor, f.binding, f.header, sign);
    expect(raw.writes).toHaveLength(2); expect(sign).toHaveBeenCalledTimes(1);
    const record = JSON.parse(Buffer.from(JSON.parse(raw.writes[1]!.toString()).payload, "base64").toString());
    expect(record.workerOwnerNonce).toBe(f.prepared.ownerNonce); expect(record.runnerInstanceId).toBe(f.binding.runnerInstanceId);
    expect(Object.keys(record)).not.toContain("command"); expect(Object.keys(record)).not.toContain("environment");
    let output = ""; channel.onData(bytes => { output += Buffer.from(bytes).toString(); });
    expect(output).toBe('{"type":"completion"}\n');
    await expect(channel.writeInput(Buffer.from("extra"))).rejects.toThrow("lifetime_only");
    channel.endInput(); expect(raw.endInput).toHaveBeenCalledOnce();
  });
  it("never signs malformed/foreign/dispatched prepared metadata", async () => {
    for (const changes of [{ ownerNonce: "bad" }, { runId: "foreign" }, { dispatchAttempted: true }, { account: "forbidden" }]) {
      const f = fixture(), raw = rawChannel(), sign = vi.fn(async (record: FactoryControllerAdmission) => signed(record));
      raw.writeHook(() => queueMicrotask(() => raw.send({ ...f.prepared, ...changes })));
      await expect(admitFactoryProviderLease(raw.raw, f.descriptor, f.binding, f.header, sign)).rejects.toThrow("transport_unverified");
      expect(sign).not.toHaveBeenCalled(); expect(raw.stop).toHaveBeenCalled(); expect(raw.close).toHaveBeenCalled();
    }
  });
  it("rejects accepted before prepared and trailing data during signing", async () => {
    for (const receipt of [JSON.stringify(fixture().accepted) + "\n", "trailing"]) {
      const f = fixture(), raw = rawChannel(), sign = vi.fn(async (record: FactoryControllerAdmission) => signed(record));
      raw.writeHook(() => queueMicrotask(() => raw.bytes(receipt === "trailing" ? JSON.stringify(f.prepared) + "\nextra" : receipt)));
      await expect(admitFactoryProviderLease(raw.raw, f.descriptor, f.binding, f.header, sign)).rejects.toThrow("transport_unverified");
      expect(sign).not.toHaveBeenCalled();
    }
  });
  it("source owner exit aborts an unresolved signer and never sends a signature", async () => {
    const f = fixture(), raw = rawChannel();
    raw.writeHook(() => queueMicrotask(() => raw.send(f.prepared)));
    let aborted = false;
    const sign = vi.fn((_record: FactoryControllerAdmission, signal: AbortSignal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      queueMicrotask(() => raw.finish({ exitCode: 76 }));
      return new Promise<ReturnType<typeof signed>>(() => {});
    });
    await expect(admitFactoryProviderLease(raw.raw, f.descriptor, f.binding, f.header, sign)).rejects.toThrow("transport_unverified");
    expect(aborted).toBe(true); expect(raw.writes).toHaveLength(1);
  });
  it("sanitizes signer failures and rejects signer payload substitution", async () => {
    for (const substitute of [false, true]) {
      const f = fixture(), raw = rawChannel(); raw.writeHook(() => queueMicrotask(() => raw.send(f.prepared)));
      const sign = async (record: FactoryControllerAdmission) => {
        if (!substitute) throw new Error("synthetic-private-path-detail");
        return signed({ ...record, capabilityId: "foreign" });
      };
      await expect(admitFactoryProviderLease(raw.raw, f.descriptor, f.binding, f.header, sign)).rejects.toThrow("transport_unverified");
      expect(raw.writes).toHaveLength(1); expect(raw.close).toHaveBeenCalled();
    }
  });
  it("only verified busy with real exit75 permits capacity deferral", async () => {
    for (const transportClosed of [false, true]) {
      const f = fixture(), raw = rawChannel(), sign = vi.fn(async (record: FactoryControllerAdmission) => signed(record));
      raw.writeHook(() => queueMicrotask(() => {
        raw.send({ protocol: FACTORY_PROVIDER_MARKER, type: "admission", status: "busy", ...f.identity, code: "busy", dispatchAttempted: false });
        raw.finish({ exitCode: 75, transportClosed });
      }));
      const result = admitFactoryProviderLease(raw.raw, f.descriptor, f.binding, f.header, sign);
      if (transportClosed) await expect(result).rejects.toThrow("transport_unverified");
      else await expect(result).rejects.toBeInstanceOf(FactoryWorkerBusyError);
      expect(sign).not.toHaveBeenCalled();
    }
  });
  it("timeout interrupts a stuck header write without leaving the channel open", async () => {
    const f = fixture(), raw = rawChannel();
    raw.raw.writeInput = () => new Promise<void>(() => {});
    await expect(admitFactoryProviderLease(raw.raw, f.descriptor, f.binding, f.header,
      async record => signed(record), { timeoutMs: 10 })).rejects.toThrow("transport_unverified");
    expect(raw.stop).toHaveBeenCalled(); expect(raw.close).toHaveBeenCalled();
  });
  it("held source admission is never reclassified as non-dispatch busy", async () => {
    const f = fixture(), raw = rawChannel();
    raw.writeHook(count => queueMicrotask(() => raw.send(count === 1 ? f.prepared : {
      protocol: FACTORY_PROVIDER_MARKER, type: "admission", status: "held", ...f.identity,
      dispatchAttempted: false, code: "provider_preparation_held" })));
    await expect(admitFactoryProviderLease(raw.raw, f.descriptor, f.binding, f.header, async record => signed(record))).rejects.toThrow("transport_unverified");
    expect(raw.writes).toHaveLength(2);
  });
});
