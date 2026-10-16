import type { SshProcessChannel, SshChannelExit } from "./ssh-process-channel.js";
import { SshTransportUnverifiedError } from "./ssh-process-channel.js";
import { FACTORY_WORKER_MARKER, FACTORY_WORKER_BUSY_EXIT, FactoryWorkerBusyError,
  type FactoryWorkerLeaseDescriptor } from "./factory-worker-lease.js";

/**
 * Consume exactly the worker's admission line and cache early completion/output.
 * Input after the header is a lifetime channel: Rust uses PRP, not stdin. A busy
 * result is safe to queue ONLY with matching metadata, real exit 75 and cleanup.
 */
export async function admitFactoryWorkerLease(
  raw: SshProcessChannel,
  descriptor: FactoryWorkerLeaseDescriptor,
  header: Uint8Array,
  admissionTimeoutMs = 10_000,
): Promise<SshProcessChannel> {
  if (!Number.isSafeInteger(admissionTimeoutMs) || admissionTimeoutMs <= 0) throw new Error("Invalid admission bound");
  let ack: Record<string, unknown> | undefined;
  let first = Buffer.alloc(0);
  let settled = false;
  let exit: SshChannelExit | undefined;
  let exitListener: ((value: SshChannelExit) => void) | undefined;
  let exitDelivered = false;
  let dataListener: ((value: Uint8Array) => void) | undefined;
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let resolveAck!: () => void;
  let rejectAck!: (error: Error) => void;
  const acknowledged = new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
  void acknowledged.catch(() => undefined);
  let resolveExit!: (value: SshChannelExit) => void;
  const exited = new Promise<SshChannelExit>(resolve => { resolveExit = resolve; });
  const fail = () => {
    if (!settled) { settled = true; rejectAck(new SshTransportUnverifiedError()); }
    raw.stop();
  };
  const deliverExit = () => {
    if (exit && exitListener && !exitDelivered) { exitDelivered = true; exitListener(exit); }
  };
  const deliverData = (data: Buffer) => {
    if (!data.length) return;
    if (dataListener) { dataListener(data); return; }
    pendingBytes += data.length;
    if (pendingBytes > 65536) { fail(); return; }
    pending.push(Buffer.from(data));
  };
  raw.onData(data => {
    if (ack) { deliverData(Buffer.from(data)); return; }
    const joined = Buffer.concat([first, data]);
    const newline = joined.indexOf(10);
    if (newline < 0) {
      if (joined.length > 4096) { fail(); return; }
      first = joined; return;
    }
    if (newline + 1 > 4096) { fail(); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(joined.subarray(0, newline).toString("utf8")); }
    catch { fail(); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { fail(); return; }
    const value = parsed as Record<string, unknown>;
    if (value.protocol !== FACTORY_WORKER_MARKER || value.type !== "admission" ||
        ["companyId", "runId", "leaseId", "sessionId"].some(key => value[key] !== descriptor[key as keyof FactoryWorkerLeaseDescriptor]) ||
        !((value.status === "accepted" && value.dispatchAttempted === true) ||
          (value.status === "busy" && value.code === "busy" && value.dispatchAttempted === false))) {
      fail(); return;
    }
    ack = value;
    first = Buffer.alloc(0);
    settled = true;
    resolveAck();
    deliverData(joined.subarray(newline + 1));
  });
  // Raw process errors can contain command details. Never forward them as
  // protocol evidence; the worker puts useful bounded codes in its stdout receipt.
  raw.onStderr(() => {});
  raw.onExit(value => {
    exit = value; resolveExit(value); deliverExit();
    if (!ack && !settled) { settled = true; rejectAck(new SshTransportUnverifiedError()); }
  });
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  void timeout.catch(() => undefined);
  const timer = setTimeout(() => { fail(); rejectTimeout(new SshTransportUnverifiedError()); }, admissionTimeoutMs);
  try {
    await Promise.race([raw.writeInput(header), timeout]);
    await Promise.race([acknowledged, timeout]);
    if (ack!.status === "busy") {
      const value = await Promise.race([exited, timeout]);
      if (value.transportClosed || value.exitCode !== FACTORY_WORKER_BUSY_EXIT) throw new SshTransportUnverifiedError();
      await raw.close();
      throw new FactoryWorkerBusyError();
    }
    return {
      write() { throw new Error("factory_worker_lease_stdin_is_lifetime_only"); },
      writeInput() { return Promise.reject(new Error("factory_worker_lease_stdin_is_lifetime_only")); },
      endInput: () => raw.endInput(),
      onData(listener) {
        if (dataListener && dataListener !== listener) throw new Error("SSH data listener already registered");
        dataListener = listener;
        for (const value of pending.splice(0)) { pendingBytes -= value.length; listener(value); }
      },
      onStderr() { /* Deliberately no raw diagnostic forwarding. */ },
      onExit(listener) {
        if (exitListener && exitListener !== listener) throw new Error("SSH exit listener already registered");
        exitListener = listener; deliverExit();
      },
      stop: () => raw.stop(), close: () => raw.close(),
    };
  } catch (error) {
    if (error instanceof FactoryWorkerBusyError) throw error;
    raw.stop();
    await raw.close().catch(() => undefined);
    throw new SshTransportUnverifiedError();
  } finally { clearTimeout(timer); }
}
