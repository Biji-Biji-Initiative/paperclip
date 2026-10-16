import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface SshChannelExit {
  exitCode: number | null;
  transportClosed?: boolean;
}

/** Structurally implements CommandManagedDuplexChannel; no remote PID is exposed. */
export interface SshProcessChannel {
  write(data: Uint8Array): void;
  endInput(): void;
  writeInput(data: Uint8Array): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): void;
  onStderr(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (exit: SshChannelExit) => void): void;
  stop(): void;
  close(): Promise<void>;
}

export class SshTransportUnverifiedError extends Error {
  constructor() {
    super("native_ssh_transport_unverified");
    this.name = "SshTransportUnverifiedError";
  }
}

/** OpenSSH uses 255 for transport errors (also ambiguous with remote exit 255). */
export function classifySshExit(code: number | null, signal: NodeJS.Signals | null, interrupted: boolean): SshChannelExit {
  if (!interrupted && signal === null && code !== null && Number.isInteger(code) && code >= 0 && code < 255) {
    return { exitCode: code };
  }
  return { exitCode: null, transportClosed: true };
}

export interface SshProcessChannelOptions {
  cleanup: () => Promise<void>;
  signal?: AbortSignal;
  termGraceMs?: number;
  killGraceMs?: number;
  cleanupTimeoutMs?: number;
  maxPendingBytes?: number;
}

/**
 * Install all process listeners synchronously after spawn. Exit and early output
 * are cached until the consumer subscribes. Killing the local ssh client never
 * constitutes proof that the remote namespace retired.
 */
export function createSshProcessChannel(
  child: ChildProcessWithoutNullStreams,
  options: SshProcessChannelOptions,
): SshProcessChannel {
  const termGraceMs = options.termGraceMs ?? 2_000;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000;
  const maxPendingBytes = options.maxPendingBytes ?? 1024 * 1024;
  for (const value of [termGraceMs, killGraceMs, cleanupTimeoutMs, maxPendingBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid SSH channel bound");
  }
  let interrupted = false;
  let localClosed = false;
  let exit: SshChannelExit | undefined;
  let exitListener: ((value: SshChannelExit) => void) | undefined;
  let exitDelivered = false;
  let dataListener: ((value: Uint8Array) => void) | undefined;
  let stderrListener: ((value: Uint8Array) => void) | undefined;
  let buffered = 0;
  const stdoutQueue: Buffer[] = [];
  const stderrQueue: Buffer[] = [];
  let termTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let resolveFinished!: (value: SshChannelExit) => void;
  const finished = new Promise<SshChannelExit>((resolve) => { resolveFinished = resolve; });

  const cleanup = () => {
    cleanupPromise ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SshTransportUnverifiedError()), cleanupTimeoutMs);
      Promise.resolve().then(options.cleanup).then(
        () => { clearTimeout(timer); resolve(); },
        () => { clearTimeout(timer); reject(new SshTransportUnverifiedError()); },
      );
    });
    // It can finish before close() is called. Keep the error observable there
    // without generating an unhandled rejection in the meantime.
    void cleanupPromise.catch(() => undefined);
    return cleanupPromise;
  };
  const deliverExit = () => {
    if (!exit || !exitListener || exitDelivered) return;
    exitDelivered = true;
    try { exitListener(exit); } catch { stop(); }
  };
  const finish = (value: SshChannelExit) => {
    if (exit) return;
    exit = value;
    if (termTimer) clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", stop);
    resolveFinished(value);
    deliverExit();
    void cleanup();
  };
  const safeKill = (signal: NodeJS.Signals) => {
    try { child.kill(signal); } catch { /* Classification remains unverified. */ }
  };
  function stop() {
    if (exit || interrupted) return;
    interrupted = true;
    safeKill("SIGTERM");
    termTimer = setTimeout(() => {
      safeKill("SIGKILL");
      killTimer = setTimeout(() => {
        // Even an unresponsive local process cannot keep cleanup promises open
        // forever. Retain remote uncertainty; never synthesize exit 0 here.
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref();
        finish({ exitCode: null, transportClosed: true });
      }, killGraceMs);
    }, termGraceMs);
  }
  const receive = (value: Buffer, stderr: boolean) => {
    if (exit) return;
    const listener = stderr ? stderrListener : dataListener;
    if (listener) {
      try { listener(value); } catch { stop(); }
      return;
    }
    if (buffered + value.length > maxPendingBytes) { stop(); return; }
    const copy = Buffer.from(value);
    (stderr ? stderrQueue : stdoutQueue).push(copy);
    buffered += copy.length;
  };
  child.stdout.on("data", (value: Buffer) => receive(value, false));
  child.stderr.on("data", (value: Buffer) => receive(value, true));
  child.stdin.on("error", () => stop());
  child.on("error", () => {
    if (child.pid === undefined) {
      interrupted = true;
      finish({ exitCode: null, transportClosed: true });
    } else stop();
  });
  child.on("close", (code, signal) => {
    localClosed = true;
    finish(classifySshExit(code, signal, interrupted));
  });
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();

  return {
    write(data) {
      if (exit || interrupted || child.stdin.destroyed) throw new SshTransportUnverifiedError();
      if (child.stdin.writableLength + data.byteLength > maxPendingBytes) {
        stop(); throw new Error("SSH channel input bound exceeded");
      }
      child.stdin.write(data);
    },
    writeInput(data) {
      if (exit || interrupted || child.stdin.destroyed || data.byteLength > maxPendingBytes) {
        return Promise.reject(new SshTransportUnverifiedError());
      }
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(data, (error) => error ? reject(new SshTransportUnverifiedError()) : resolve());
      });
    },
    endInput() {
      if (exit || interrupted) throw new SshTransportUnverifiedError();
      child.stdin.end();
    },
    onData(listener) {
      if (dataListener && dataListener !== listener) throw new Error("SSH data listener already registered");
      dataListener = listener;
      for (const value of stdoutQueue.splice(0)) { buffered -= value.length; listener(value); }
    },
    onStderr(listener) {
      if (stderrListener && stderrListener !== listener) throw new Error("SSH stderr listener already registered");
      stderrListener = listener;
      for (const value of stderrQueue.splice(0)) { buffered -= value.length; listener(value); }
    },
    onExit(listener) {
      if (exitListener && exitListener !== listener) throw new Error("SSH exit listener already registered");
      exitListener = listener;
      // Never lose an exit which preceded this subscription.
      deliverExit();
    },
    stop,
    close() {
      closePromise ??= (async () => {
        stop();
        const result = await finished;
        await cleanup();
        if (!localClosed || result.transportClosed) throw new SshTransportUnverifiedError();
      })();
      return closePromise;
    },
  };
}
