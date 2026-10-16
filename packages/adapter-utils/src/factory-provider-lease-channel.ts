import { FACTORY_WORKER_BUSY_EXIT, FactoryWorkerBusyError, validateFactoryWorkerLeaseDescriptor,
  type FactoryWorkerLeaseDescriptor } from "./factory-worker-lease.js";
import { FACTORY_ADMISSION_SIGNED_SCHEMA, FACTORY_PROVIDER_MARKER, createFactoryControllerAdmission,
  encodeFactoryControllerAdmission, validateFactoryPreparedReceipt, validateFactoryProviderBinding,
  type FactoryControllerAdmission, type FactoryProviderBinding, type FactoryPreparedReceipt,
  type FactorySignedAdmission } from "./factory-provider-admission.js";
import { SshTransportUnverifiedError, type SshChannelExit, type SshProcessChannel } from "./ssh-process-channel.js";

type SignAdmission = (record: FactoryControllerAdmission, signal: AbortSignal) => Promise<FactorySignedAdmission>;

/** New opt-in only. The scoped private key remains entirely on the controller. */
export async function admitFactoryProviderLease(raw: SshProcessChannel, descriptor: FactoryWorkerLeaseDescriptor,
  binding: FactoryProviderBinding, header: Uint8Array, sign: SignAdmission,
  options: { timeoutMs?: number; signal?: AbortSignal; beforeSign?: () => Promise<void> } = {}): Promise<SshProcessChannel> {
  const lease = structuredClone(descriptor), provider = structuredClone(binding), launch = Buffer.from(header);
  try { validateFactoryProviderBinding(provider); validateFactoryWorkerLeaseDescriptor(lease); }
  catch { launch.fill(0); raw.stop(); await raw.close().catch(() => undefined); throw new SshTransportUnverifiedError(); }
  const timeoutMs = Math.min(options.timeoutMs ?? 20_000, lease.deadlineUnixMs - Date.now());
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || options.signal?.aborted) {
    launch.fill(0); raw.stop(); await raw.close().catch(() => undefined); throw new SshTransportUnverifiedError();
  }
  let stage: "prepare" | "signing" | "admit" | "accepted" | "busy" | "failed" = "prepare";
  let frame = Buffer.alloc(0), pendingBytes = 0;
  const pending: Buffer[] = [];
  let exit: SshChannelExit | undefined, exitDelivered = false;
  let dataListener: ((value: Uint8Array) => void) | undefined;
  let exitListener: ((value: SshChannelExit) => void) | undefined;
  const signing = new AbortController();
  let resolvePrepared!: (value: FactoryPreparedReceipt | null) => void;
  let rejectPrepared!: (error: Error) => void;
  let resolveAccepted!: () => void, rejectAccepted!: (error: Error) => void;
  let resolveExit!: (value: SshChannelExit) => void;
  const prepared = new Promise<FactoryPreparedReceipt | null>((resolve, reject) => { resolvePrepared = resolve; rejectPrepared = reject; });
  const accepted = new Promise<void>((resolve, reject) => { resolveAccepted = resolve; rejectAccepted = reject; });
  const exited = new Promise<SshChannelExit>(resolve => { resolveExit = resolve; });
  void prepared.catch(() => undefined); void accepted.catch(() => undefined);
  const fail = () => {
    if (stage === "failed") return;
    stage = "failed"; signing.abort(); raw.stop();
    rejectPrepared(new SshTransportUnverifiedError()); rejectAccepted(new SshTransportUnverifiedError());
  };
  const deliverData = (value: Buffer) => {
    if (!value.length) return;
    if (dataListener) { dataListener(value); return; }
    pendingBytes += value.length;
    if (pendingBytes > 65536) { fail(); return; }
    pending.push(Buffer.from(value));
  };
  const deliverExit = () => {
    if (exit && exitListener && !exitDelivered) { exitDelivered = true; exitListener(exit); }
  };
  const identity = (value: Record<string, unknown>) => ["companyId", "runId", "leaseId", "sessionId"]
    .every(key => value[key] === lease[key as keyof FactoryWorkerLeaseDescriptor]);
  raw.onData(chunk => {
    if (stage === "accepted") { deliverData(Buffer.from(chunk)); return; }
    if (stage !== "prepare" && stage !== "admit") { fail(); return; }
    const combined = Buffer.concat([frame, chunk]);
    const newline = combined.indexOf(10);
    if (newline < 0) {
      if (combined.length > 4096) { fail(); return; }
      frame = combined; return;
    }
    if (newline + 1 > 4096) { fail(); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(combined.subarray(0, newline).toString("utf8")); }
    catch { fail(); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { fail(); return; }
    const value = parsed as Record<string, unknown>;
    frame = Buffer.alloc(0);
    if (stage === "prepare") {
      if (Object.keys(value).length === 9 && value.protocol === FACTORY_PROVIDER_MARKER && value.type === "admission" && value.status === "busy" &&
          value.code === "busy" && value.dispatchAttempted === false && identity(value)) {
        stage = "busy"; resolvePrepared(null);
      } else {
        try { validateFactoryPreparedReceipt(parsed, lease, provider); }
        catch { fail(); return; }
        stage = "signing"; resolvePrepared(parsed);
      }
      if (combined.length > newline + 1) fail();
      return;
    }
    if (Object.keys(value).length !== 8 || value.protocol !== FACTORY_PROVIDER_MARKER || value.type !== "admission" ||
        value.status !== "accepted" || value.dispatchAttempted !== true || !identity(value)) { fail(); return; }
    stage = "accepted"; resolveAccepted(); deliverData(combined.subarray(newline + 1));
  });
  raw.onStderr(() => { /* No raw SSH/signing/source diagnostics. */ });
  raw.onExit(value => {
    exit = value; resolveExit(value); deliverExit();
    if (stage !== "accepted" && stage !== "busy") fail();
  });
  const timer = setTimeout(fail, timeoutMs);
  options.signal?.addEventListener("abort", fail, { once: true });
  let signedFrame: Buffer | undefined;
  try {
    if (options.signal?.aborted) fail();
    await Promise.race([raw.writeInput(launch), accepted]);
    const challenge = await prepared;
    if (challenge === null) {
      const completion = await Promise.race([exited, accepted.then(() => { throw new SshTransportUnverifiedError(); })]);
      if (completion.transportClosed || completion.exitCode !== FACTORY_WORKER_BUSY_EXIT) throw new SshTransportUnverifiedError();
      await raw.close(); throw new FactoryWorkerBusyError();
    }
    if ((stage as string) !== "signing" || exit || signing.signal.aborted) throw new SshTransportUnverifiedError();
    const record = createFactoryControllerAdmission(lease, provider, challenge);
    if (options.beforeSign) await Promise.race([options.beforeSign(), accepted.then(() => { throw new SshTransportUnverifiedError(); })]);
    if ((stage as string) !== "signing" || exit || signing.signal.aborted) throw new SshTransportUnverifiedError();
    const signature = await Promise.race([sign(record, signing.signal), accepted.then(() => { throw new SshTransportUnverifiedError(); })]);
    if ((stage as string) !== "signing" || exit || signing.signal.aborted ||
        Object.keys(signature).length !== 3 || signature.schema !== FACTORY_ADMISSION_SIGNED_SCHEMA ||
        signature.payload !== encodeFactoryControllerAdmission(record).toString("base64") ||
        typeof signature.signature !== "string" || signature.signature.length > 4096) throw new SshTransportUnverifiedError();
    signedFrame = Buffer.from(JSON.stringify(signature) + "\n");
    if (signedFrame.length > 32768) throw new SshTransportUnverifiedError();
    stage = "admit";
    await Promise.race([raw.writeInput(signedFrame), accepted]);
    await accepted;
    return {
      write() { throw new Error("factory_provider_stdin_is_lifetime_only"); },
      writeInput() { return Promise.reject(new Error("factory_provider_stdin_is_lifetime_only")); },
      endInput: () => raw.endInput(),
      onData(listener) {
        if (dataListener && dataListener !== listener) throw new Error("SSH data listener already registered");
        dataListener = listener;
        for (const value of pending.splice(0)) { pendingBytes -= value.length; listener(value); }
      },
      onStderr() { /* Fixed protocol evidence only. */ },
      onExit(listener) {
        if (exitListener && exitListener !== listener) throw new Error("SSH exit listener already registered");
        exitListener = listener; deliverExit();
      },
      stop: () => raw.stop(), close: () => raw.close(),
    };
  } catch (error) {
    signing.abort();
    if (error instanceof FactoryWorkerBusyError) throw error;
    raw.stop(); await raw.close().catch(() => undefined); throw new SshTransportUnverifiedError();
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", fail);
    launch.fill(0); signedFrame?.fill(0);
  }
}
