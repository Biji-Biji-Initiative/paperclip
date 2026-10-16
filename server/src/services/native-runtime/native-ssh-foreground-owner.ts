import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// Deliberately structural: assignable to the existing command-runner duplex seam
// and RunnerProcessHandle without importing the 19k-line executor or database.
interface Channel {
  write(data: Uint8Array): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  onStderr?(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (exit: { exitCode: number | null; transportClosed?: boolean }) => void): void;
  stop(): void;
  close(): Promise<void>;
}
interface LaunchSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
}
interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
interface ProcessHandle {
  child: {
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  completion: Promise<ProcessResult>;
}
export interface ForegroundCommandRunner {
  openDuplexChannel?(input: { command: readonly string[]; signal?: AbortSignal }): Promise<Channel>;
}
interface OwnerRecord {
  schema: "paperclip.native-ssh-owner.v1";
  token: string;
  runId: string;
  runnerInstanceId: string;
  state: "preparing" | "dispatched" | "exited" | "held";
  createdAt: string;
  exitCode?: number;
}

function bounded<T>(promise: Promise<T>, milliseconds: number, error: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), milliseconds);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (failure) => { clearTimeout(timer); reject(failure); },
    );
  });
}

/**
 * A controller-owned, secret-free fail-closed receipt in the existing native
 * session root. This is NOT a remote PID lease. A receipt surviving a controller
 * restart always holds; only this live owner plus a successful existing native
 * checkpoint and an observed remote exit can release it automatically.
 */
export class NativeSshForegroundOwner {
  private readonly file: string;
  private active?: OwnerRecord;
  private handle?: ProcessHandle;
  private channel?: Channel;
  private uncertainty = false;
  private checkpointPromise?: Promise<void>;

  constructor(private readonly options: {
    directory: string;
    runId: string;
    runnerInstanceId: string;
    ownershipError: () => Error;
    stageTimeoutMs?: number;
    openTimeoutMs?: number;
    cleanupTimeoutMs?: number;
  }) {
    this.file = join(options.directory, "ssh-foreground-owner.json");
  }

  assertAvailable(): void {
    if (existsSync(this.file) || (() => {
      try { lstatSync(this.file); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    })()) throw this.options.ownershipError();
  }

  private syncDirectory(): void {
    const fd = openSync(this.options.directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  private readOwnRecord(): OwnerRecord {
    if (!this.active) throw this.options.ownershipError();
    const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const value = JSON.parse(readFileSync(fd, "utf8")) as OwnerRecord;
      if (value.schema !== this.active.schema || value.token !== this.active.token ||
          value.runId !== this.active.runId || value.runnerInstanceId !== this.active.runnerInstanceId) {
        throw this.options.ownershipError();
      }
      return value;
    } finally { closeSync(fd); }
  }

  private claim(): void {
    if (this.active) throw this.options.ownershipError();
    mkdirSync(this.options.directory, { mode: 0o700, recursive: true });
    const record: OwnerRecord = {
      schema: "paperclip.native-ssh-owner.v1", token: randomUUID(),
      runId: this.options.runId, runnerInstanceId: this.options.runnerInstanceId,
      createdAt: new Date().toISOString(), state: "preparing",
    };
    let fd: number;
    try { fd = openSync(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw this.options.ownershipError(); }
    // Any uncertain write intentionally leaves the exclusive hold present.
    this.active = record;
    try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.syncDirectory();
  }

  private update(state: OwnerRecord["state"], exitCode?: number): void {
    this.readOwnRecord();
    const record: OwnerRecord = { ...this.active!, state, ...(exitCode === undefined ? {} : { exitCode }) };
    const temporary = this.file + "." + randomUUID() + ".pending";
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.readOwnRecord();
    renameSync(temporary, this.file);
    this.syncDirectory();
    this.active = record;
  }

  private hold(): void {
    this.uncertainty = true;
    try { if (this.active) this.update("held"); } catch {
      // An unreadable or partially written original receipt still fails closed.
    }
  }

  private release(): void {
    this.readOwnRecord();
    // Retain the latest nonsecret receipt. Its presence is not a release token;
    // the exclusive active file is the admission fence.
    this.update("exited");
    renameSync(this.file, join(this.options.directory, "ssh-foreground-last-" + this.active!.token + ".json"));
    this.syncDirectory();
    this.active = undefined;
  }

  createLauncher(input: {
    runner: ForegroundCommandRunner;
    remoteBinary: string;
    remoteCwd: string;
    diagnosticsDirectory: string;
    ensureArtifact: () => Promise<void>;
    onDispatched?: () => void;
  }): (spec: LaunchSpec) => ProcessHandle {
    if (!input.runner.openDuplexChannel) throw new Error("native_ssh_foreground_channel_required");
    if (![input.remoteBinary, input.remoteCwd, input.diagnosticsDirectory].every((p) => p.startsWith("/") && !p.includes("\0"))) {
      throw new Error("Invalid native SSH foreground launch path");
    }
    return (spec) => {
      this.assertAvailable();
      this.claim();
      this.uncertainty = false;
      this.channel = undefined;
      this.checkpointPromise = undefined;
      const abort = new AbortController();
      let dispatchAttempted = false;
      let cancelledBeforeDispatch = false;
      let finished = false;
      let stopped = false;
      let stopDeadline: ReturnType<typeof setTimeout> | undefined;
      let rejectStop!: (error: Error) => void;
      const stopExpired = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
      void stopExpired.catch(() => undefined);
      const child: ProcessHandle["child"] = {
        exitCode: null, signalCode: null,
        kill: () => {
          if (finished || stopped) return false;
          stopped = true;
          stopDeadline = setTimeout(() => rejectStop(this.options.ownershipError()), this.options.cleanupTimeoutMs ?? 6_000);
          abort.abort();
          this.channel?.stop();
          return true;
        },
      };
      const completion = (async (): Promise<ProcessResult> => {
        try {
          // Staging is awaited. A timeout leaves a hold, and the settled staging
          // promise cannot later dispatch a runner after this closure has failed.
          await Promise.race([bounded(input.ensureArtifact(), this.options.stageTimeoutMs ?? 600_000, this.options.ownershipError), stopExpired]);
          if (stopped) {
            if (this.uncertainty) throw this.options.ownershipError();
            this.release();
            cancelledBeforeDispatch = true;
            throw new Error("native_ssh_cancelled_before_dispatch");
          }
          const args = [...spec.args];
          const index = args.indexOf("--diagnostics-directory");
          if (index >= 0) {
            if (index + 1 >= args.length) throw new Error("Missing diagnostics argument");
            args[index + 1] = input.diagnosticsDirectory;
          } else args.push("--diagnostics-directory", input.diagnosticsDirectory);
          const env = Object.entries(spec.environment).filter((entry): entry is [string, string] => typeof entry[1] === "string");
          for (const [key, value] of env) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) throw new Error("Invalid native runner environment");
          }
          // Preserve the actual runner vector. The small shell only creates the
          // diagnostics directory, changes cwd and execs; no nohup/setsid/&/PID RPC.
          const command = ["/usr/bin/env", ...env.map(([key, value]) => `${key}=${value}`),
            "/bin/sh", "-c", 'set -eu; umask 077; mkdir -p -- "$1"; cd -- "$2"; shift 2; exec "$@"',
            "paperclip-ssh-foreground", input.diagnosticsDirectory, input.remoteCwd, input.remoteBinary, ...args];
          this.update("dispatched");
          dispatchAttempted = true;
          const opening = input.runner.openDuplexChannel!({ command, signal: abort.signal });
          let openingExpired = false;
          // A delayed provider implementation must not orphan a late-open channel.
          void opening.then((channel) => {
            if (openingExpired || stopped) { channel.stop(); void channel.close().catch(() => undefined); }
          }, () => undefined);
          try {
            this.channel = await Promise.race([bounded(opening, this.options.openTimeoutMs ?? 20_000, this.options.ownershipError), stopExpired]);
          } catch (error) { openingExpired = true; abort.abort(); throw error; }
          if (stopped) this.channel.stop();
          // Dispatch notification is not an authenticated remote-PID claim.
          input.onDispatched?.();
          this.channel.onData(() => {});
          this.channel.onStderr?.(() => {}); // Raw transport diagnostics can contain argv secrets.
          const exit = await Promise.race([
            new Promise<{ exitCode: number | null; transportClosed?: boolean }>((resolve) => {
              this.channel!.onExit(resolve);
            }),
            stopExpired,
          ]);
          if (exit.transportClosed || exit.exitCode === null || !Number.isInteger(exit.exitCode) || exit.exitCode < 0 || exit.exitCode >= 255) {
            this.hold();
            await bounded(this.channel.close(), this.options.cleanupTimeoutMs ?? 6_000, this.options.ownershipError).catch(() => undefined);
            // The existing PRP watcher treats ANY resolved process completion
            // as an observed exit. Reject uncertainty; never resolve code:null.
            throw this.options.ownershipError();
          }
          child.exitCode = exit.exitCode;
          this.update("exited", exit.exitCode);
          await bounded(this.channel.close(), this.options.cleanupTimeoutMs ?? 6_000, this.options.ownershipError);
          return { code: exit.exitCode, signal: null, stdout: "", stderr: "" };
        } catch {
          if (cancelledBeforeDispatch) throw new Error("native_ssh_cancelled_before_dispatch");
          // No detached retry. Keeping the receipt is intentional even if an
          // exception preceded dispatch: staging/cleanup must first be reconciled.
          this.hold();
          abort.abort();
          this.channel?.stop();
          if (this.channel) {
            await bounded(this.channel.close(), this.options.cleanupTimeoutMs ?? 6_000, this.options.ownershipError).catch(() => undefined);
          }
          throw this.options.ownershipError();
        } finally {
          finished = true;
          if (stopDeadline) clearTimeout(stopDeadline);
          // A pre-dispatch cancellation after staging settled is the only early
          // release; no provider or runner could have been submitted in that case.
          if (!dispatchAttempted && !this.active) this.channel = undefined;
        }
      })();
      void completion.catch(() => undefined);
      const handle = { child, completion };
      this.handle = handle;
      return handle;
    };
  }

  /** Called by the existing PRP checkpoint/release path, not by SSH exit alone. */
  checkpoint(settlement: "settled" | "unsettled", checkpoint: () => Promise<void>): Promise<void> {
    if (this.checkpointPromise) return this.checkpointPromise;
    if (!this.active) return checkpoint();
    this.checkpointPromise ??= (async () => {
      try {
        if (settlement !== "settled" || this.uncertainty || !this.handle) throw this.options.ownershipError();
        const result = await bounded(this.handle.completion, this.options.cleanupTimeoutMs ?? 6_000, this.options.ownershipError);
        if (result.code === null || this.uncertainty || this.active?.state !== "exited") throw this.options.ownershipError();
        await checkpoint();
        this.release();
      } catch (error) {
        this.hold();
        this.channel?.stop();
        // Preserve an existing native checkpoint/settlement classification. The
        // durable receipt still blocks a successor; transport uncertainty above
        // already raises the established native ownership-hold error.
        throw error instanceof Error ? error : this.options.ownershipError();
      }
    })();
    return this.checkpointPromise;
  }
}
