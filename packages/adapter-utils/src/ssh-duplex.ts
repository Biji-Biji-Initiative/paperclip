import { spawn } from "node:child_process";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSshArgvCommand, quoteSshArgument } from "./ssh-command.js";
import { createSshProcessChannel, type SshProcessChannel } from "./ssh-process-channel.js";
import { FACTORY_WORKER_MARKER, encodeFactoryWorkerLaunch, isFactoryWorkerBusyError, type FactoryWorkerLeaseDescriptor } from "./factory-worker-lease.js";
import { admitFactoryWorkerLease } from "./factory-worker-lease-channel.js";
import { FACTORY_PROVIDER_MARKER, encodeFactoryProviderLaunch, signFactoryControllerAdmission,
  type FactoryProviderBinding } from "./factory-provider-admission.js";
import { admitFactoryProviderLease } from "./factory-provider-lease-channel.js";

export interface DedicatedSshTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string | null;
  knownHosts: string | null;
  strictHostKeyChecking: boolean;
  remoteCwd: string;
}
export interface SshDuplexOpenInput {
  command: readonly string[];
  signal?: AbortSignal;
  /** Explicit Factory opt-in only. Generic/control calls never acquire a slot. */
  workerLease?: FactoryWorkerLeaseDescriptor;
  /** Explicit provider opt-in from authorized runtime metadata; never a default. */
  providerAdmission?: FactoryProviderBinding;
  environment?: Readonly<Record<string, string>>;
}

/** Native worker path only: no operator profile, agent, jump host or alternate key. */
export function validateDedicatedSshTarget(config: DedicatedSshTarget): void {
  const dnsName = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
  if ((!isIP(config.host) && !dnsName.test(config.host)) ||
      !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(config.username) ||
      !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535 ||
      !config.remoteCwd.startsWith("/") || config.remoteCwd.includes("\0") ||
      !config.strictHostKeyChecking || !config.privateKey?.trim() || !config.knownHosts?.trim()) {
    throw new Error("Native SSH requires an explicit target, dedicated key and pinned known-hosts");
  }
  if (config.privateKey.includes("\0") || config.knownHosts.includes("\0")) {
    throw new Error("Invalid native SSH authentication material");
  }
}

export function dedicatedSshArgs(config: DedicatedSshTarget, keyPath: string, hostsPath: string): string[] {
  validateDedicatedSshTarget(config);
  return [
    "-F", "/dev/null", "-T", "-a", "-x", "-S", "none",
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2", "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none", "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no",
    "-o", "ControlPersist=no", "-o", "ProxyCommand=none", "-o", "ProxyJump=none",
    "-o", "PermitLocalCommand=no", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${hostsPath}`, "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "KnownHostsCommand=none", "-o", "UpdateHostKeys=no",
    "-o", "VerifyHostKeyDNS=no", "-o", "CertificateFile=none",
    "-o", "PreferredAuthentications=publickey", "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no", "-o", "NumberOfPasswordPrompts=0",
    "-o", "LogLevel=ERROR", "-i", keyPath, "-p", String(config.port),
    "-l", config.username, config.host,
  ];
}

export function dedicatedSshClientEnvironment(): NodeJS.ProcessEnv {
  // No SSH_AUTH_SOCK, SSH_ASKPASS, NODE_OPTIONS, LD_PRELOAD or proxy/config
  // variables inherited from an operator shell. ssh is selected by absolute path.
  return { PATH: "/usr/bin:/bin:/usr/local/bin", LANG: "C", LC_ALL: "C" };
}

export async function openDedicatedSshDuplex(
  config: DedicatedSshTarget,
  input: SshDuplexOpenInput,
): Promise<SshProcessChannel> {
  validateDedicatedSshTarget(config);
  if (!input.command.length) throw new Error("SSH duplex command is empty");
  // Snapshot before async key preparation: changes to caller-owned objects cannot
  // retarget the request after validation. Bootstrap argv stays on stdin, never
  // in the SSH command string, receipt or diagnostics.
  const workerLease = input.workerLease ? structuredClone(input.workerLease) : undefined;
  const providerAdmission = input.providerAdmission ? structuredClone(input.providerAdmission) : undefined;
  if (providerAdmission && !workerLease) throw new Error("factory_provider_requires_worker_lease");
  if (workerLease && config.remoteCwd !== workerLease.workspaceRoot) {
    throw new Error("factory_worker_lease_cwd_mismatch");
  }
  if (!workerLease && input.environment !== undefined) {
    throw new Error("factory_worker_environment_requires_explicit_lease");
  }
  const header = workerLease ? (providerAdmission
    ? encodeFactoryProviderLaunch(workerLease, providerAdmission, input.command, input.environment)
    : encodeFactoryWorkerLaunch(workerLease, input.command, input.environment)) : undefined;
  const command = providerAdmission ? FACTORY_PROVIDER_MARKER : workerLease ? FACTORY_WORKER_MARKER : `/bin/sh -c ${quoteSshArgument(buildSshArgvCommand({
    command: input.command[0]!, args: input.command.slice(1), cwd: config.remoteCwd,
  }))}`;
  if (input.signal?.aborted) throw new Error("native_ssh_open_cancelled_before_dispatch");
  const directory = await mkdtemp(join(tmpdir(), "paperclip-native-ssh-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    await chmod(directory, 0o700);
    const keyPath = join(directory, "identity");
    const hostsPath = join(directory, "known_hosts");
    await writeFile(keyPath, config.privateKey!.trimEnd() + "\n", { mode: 0o600, flag: "wx" });
    await writeFile(hostsPath, config.knownHosts!.trimEnd() + "\n", { mode: 0o600, flag: "wx" });
    if (input.signal?.aborted) throw new Error("native_ssh_open_cancelled_before_dispatch");
    // The pinned aef image installs its qualified client here. Generic SSH
    // helpers retain their original PATH/profile behavior outside this mode.
    const child = spawn("/usr/local/bin/ssh", [
      ...dedicatedSshArgs(config, keyPath, hostsPath),
      command,
    ], { stdio: ["pipe", "pipe", "pipe"], env: dedicatedSshClientEnvironment() });
    const channel = createSshProcessChannel(child, { cleanup, signal: input.signal });
    // Keep stdin open after the header. Rust's authenticated dial_wss channel
    // carries work; EOF on this owning channel cancels the worker namespace.
    if (workerLease && providerAdmission && header) {
      return await admitFactoryProviderLease(channel, workerLease, providerAdmission, header,
        (record, signal) => signFactoryControllerAdmission(record, keyPath, signal), { signal: input.signal });
    }
    return workerLease && header ? await admitFactoryWorkerLease(channel, workerLease, header) : channel;
  } catch (error) {
    await cleanup();
    // Never include command, credential or raw spawn error in a thrown message.
    // Preserve only the verified non-dispatch busy classification, not raw errors.
    if (isFactoryWorkerBusyError(error)) throw error;
    throw new Error("native_ssh_channel_open_failed");
  } finally {
    header?.fill(0);
  }
}


/** One-shot commands use the same strict credential path; EOF is explicit. */
export async function runDedicatedSshCommand(config: DedicatedSshTarget, input: {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs?: number;
  maxBufferBytes: number;
}) {
  const startedAt = new Date().toISOString();
  const script = buildSshArgvCommand({ ...input, cwd: input.cwd ?? config.remoteCwd });
  const channel = await openDedicatedSshDuplex(config, { command: ["/bin/sh", "-c", script] });
  let stdout = "", stderr = "", bytes = 0, overflow = false, timedOut = false;
  // Text must be decoded after collection: a multibyte codepoint may straddle
  // stream events, including a one-byte boundary from a TCP relay.
  const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = [];
  const collectBytes = (value: Uint8Array, isStderr: boolean) => {
    bytes += value.byteLength;
    if (bytes > input.maxBufferBytes) { overflow = true; channel.stop(); return; }
    (isStderr ? stderrChunks : stdoutChunks).push(Buffer.from(value));
  };
  channel.onData((value) => collectBytes(value, false));
  channel.onStderr((value) => collectBytes(value, true));
  const completion = new Promise<{ exitCode: number | null; transportClosed?: boolean }>((resolve) => channel.onExit(resolve));
  const timer = setTimeout(() => { timedOut = true; channel.stop(); }, input.timeoutMs ?? 15_000);
  try {
    if (input.stdin !== undefined) {
      const bytes = Buffer.from(input.stdin);
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        await channel.writeInput(bytes.subarray(offset, offset + 64 * 1024));
      }
    }
    channel.endInput();
    const exit = await completion;
    stdout = Buffer.concat(stdoutChunks).toString("utf8");
    stderr = Buffer.concat(stderrChunks).toString("utf8");
    let cleanupFailed = false;
    await channel.close().catch(() => { cleanupFailed = true; });
    return {
      exitCode: overflow || exit.transportClosed || cleanupFailed ? null : exit.exitCode,
      signal: null, timedOut, stdout, stderr, pid: null, startedAt,
    };
  } catch {
    channel.stop();
    await channel.close().catch(() => undefined);
    return { exitCode: null, signal: null, timedOut, stdout, stderr: "native_ssh_command_unverified", pid: null, startedAt };
  } finally { clearTimeout(timer); }
}
