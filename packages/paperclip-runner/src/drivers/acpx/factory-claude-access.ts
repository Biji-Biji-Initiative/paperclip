import { closeSync, fstatSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type { Writable } from "node:stream";

export interface FactoryClaudeAccessPolicy {
  provider: "claude";
  admissionId: string;
  capabilityId: string;
  workerPlanSha256: string;
  runId: string;
  normalizedSessionId: string;
  environmentLeaseId: string;
  runnerInstanceId: string;
  deadlineAtMs: number;
  runtimeRoot: string;
  workspaceRoot: string;
  bridgeUrl: string;
  allowedMcpTools: readonly string[];
}
declare const factoryClaudeAccessBrand: unique symbol;
export interface FactoryClaudeAccessHandoff { readonly [factoryClaudeAccessBrand]: true }
type HandoffValue = { fd: number | null; bytes?: Buffer; timer?: NodeJS.Timeout; policy: FactoryClaudeAccessPolicy };
const handoffs = new WeakMap<FactoryClaudeAccessHandoff, HandoffValue>();
const ownedDescriptors = new Set<number>();
const FAILURE = "factory_claude_access_unverified";

/** Project only closed public metadata before anything can become argv. */
function projectFactoryClaudeAccessPolicy(input: FactoryClaudeAccessPolicy): FactoryClaudeAccessPolicy {
  const names = ["provider", "admissionId", "capabilityId", "workerPlanSha256", "runId", "normalizedSessionId", "environmentLeaseId", "runnerInstanceId", "deadlineAtMs", "runtimeRoot", "workspaceRoot", "bridgeUrl", "allowedMcpTools"];
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(FAILURE);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== names.length || names.some(name => !descriptors[name] || !("value" in descriptors[name]))) throw new Error(FAILURE);
  const value = (name: string): unknown => descriptors[name]!.value;
  const identifiers = ["admissionId", "capabilityId", "runId", "normalizedSessionId", "environmentLeaseId", "runnerInstanceId"];
  if (value("provider") !== "claude" || identifiers.some(name => typeof value(name) !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value(name) as string)) ||
      typeof value("workerPlanSha256") !== "string" || !/^[a-f0-9]{64}$/.test(value("workerPlanSha256") as string)) throw new Error(FAILURE);
  const deadlineAtMs = value("deadlineAtMs");
  if (typeof deadlineAtMs !== "number" || !Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= Date.now() || deadlineAtMs > Date.now() + 300_000) throw new Error(FAILURE);
  for (const name of ["runtimeRoot", "workspaceRoot"]) {
    const candidate = value(name);
    if (typeof candidate !== "string" || candidate.length > 4096 || !isAbsolute(candidate) || candidate === "/" || normalize(candidate) !== candidate || /[\x00-\x1f\x7f]/.test(candidate)) throw new Error(FAILURE);
  }
  const bridgeUrl = value("bridgeUrl");
  if (typeof bridgeUrl !== "string" || bridgeUrl.length > 4096 || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[^\s?#]*$/.test(bridgeUrl)) throw new Error(FAILURE);
  const declaredTools = value("allowedMcpTools");
  if (!Array.isArray(declaredTools) || declaredTools.length > 128) throw new Error(FAILURE);
  const toolDescriptors = Object.getOwnPropertyDescriptors(declaredTools);
  if (Reflect.ownKeys(declaredTools).length !== declaredTools.length + 1) throw new Error(FAILURE);
  const allowedMcpTools: string[] = [];
  for (let index = 0; index < declaredTools.length; index++) {
    const entry = toolDescriptors[String(index)];
    if (!entry || !("value" in entry) || typeof entry.value !== "string" || !/^mcp__paperclip__[a-z0-9_]{1,128}$/.test(entry.value)) throw new Error(FAILURE);
    allowedMcpTools.push(entry.value);
  }
  if (new Set(allowedMcpTools).size !== allowedMcpTools.length) throw new Error(FAILURE);
  return {
    provider: "claude", admissionId: value("admissionId") as string, capabilityId: value("capabilityId") as string,
    workerPlanSha256: value("workerPlanSha256") as string, runId: value("runId") as string,
    normalizedSessionId: value("normalizedSessionId") as string, environmentLeaseId: value("environmentLeaseId") as string,
    runnerInstanceId: value("runnerInstanceId") as string, deadlineAtMs, runtimeRoot: value("runtimeRoot") as string,
    workspaceRoot: value("workspaceRoot") as string, bridgeUrl, allowedMcpTools,
  };
}

/** Internal native-sidecar boundary only. Never construct from task JSON/environment. */
export function createFactoryClaudeAccessHandoff(fd: number, policy: FactoryClaudeAccessPolicy): FactoryClaudeAccessHandoff {
  const projectedPolicy = projectFactoryClaudeAccessPolicy(policy);
  if (!Number.isSafeInteger(fd) || fd < 3 || process.platform !== "linux" || ownedDescriptors.has(fd)) throw new Error(FAILURE);
  const metadata = fstatSync(fd);
  if (!metadata.isFIFO() && !metadata.isSocket()) throw new Error(FAILURE);
  const handoff = Object.freeze({}) as FactoryClaudeAccessHandoff;
  handoffs.set(handoff, { fd, policy: projectedPolicy });
  ownedDescriptors.add(fd);
  return handoff;
}

/** Transfer validated startup bytes through a new explicit guardian stdio pipe. */
export function createFactoryClaudeAccessBufferHandoff(bytes: Buffer, policy: FactoryClaudeAccessPolicy): FactoryClaudeAccessHandoff {
  const projectedPolicy = projectFactoryClaudeAccessPolicy(policy);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 16_384 || process.platform !== "linux") throw new Error(FAILURE);
  const handoff = Object.freeze({}) as FactoryClaudeAccessHandoff;
  const value: HandoffValue = { fd: null, bytes: Buffer.from(bytes), policy: projectedPolicy };
  value.timer = setTimeout(() => { value.bytes?.fill(0); handoffs.delete(handoff); }, Math.max(1, projectedPolicy.deadlineAtMs - Date.now()));
  value.timer.unref();
  handoffs.set(handoff, value);
  return handoff;
}

function closeHandoffValue(value: HandoffValue): void {
  if (value.timer) clearTimeout(value.timer);
  value.bytes?.fill(0);
  if (value.fd !== null) { ownedDescriptors.delete(value.fd); closeSync(value.fd); }
}

/** Failed admission can retire an unconsumed handoff without closing a reused FD. */
export function closeFactoryClaudeAccessHandoff(handoff: FactoryClaudeAccessHandoff): void {
  const value = handoffs.get(handoff);
  if (!value) return;
  handoffs.delete(handoff); closeHandoffValue(value);
}

export function claimFactoryClaudeAccessHandoff(handoff: FactoryClaudeAccessHandoff) {
  const value = handoffs.get(handoff);
  if (!value) throw new Error(FAILURE);
  handoffs.delete(handoff);
  let closed = false;
  const close = () => { if (!closed) { closed = true; closeHandoffValue(value); } };
  let seeded = false;
  return { fd: value.fd, policy: value.policy, close,
    seed(target: Writable, failed: () => void) {
      if (closed || seeded || value.fd !== null || !value.bytes || value.policy.deadlineAtMs <= Date.now() || target.destroyed || !target.writable) { close(); throw new Error(FAILURE); }
      seeded = true;
      target.once("error", () => { close(); failed(); });
      target.end(value.bytes, close);
    },
  };
}

/** Serialized into the verified provider bootstrap; all dependencies stay builtin. */
export async function installFactoryClaudeAccess(input: { fd: number; policy: FactoryClaudeAccessPolicy }): Promise<void> {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const { Transform } = require("node:stream") as typeof import("node:stream");
  const { StringDecoder } = require("node:string_decoder") as typeof import("node:string_decoder");
  const { Socket } = require("node:net") as typeof import("node:net");
  const failure = () => new Error("factory_claude_access_unverified");
  const policy = input.policy;
  const stable = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const canonical = (value: unknown): value is string => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value && value !== "/" && !/[\x00-\x1f\x7f]/.test(value);
  const inside = (root: string, candidate: string) => candidate.startsWith(root + "/");
  const hook = Symbol.for("paperclip.factoryClaudeAccess.v1");
  if (process.platform !== "linux" || !Number.isSafeInteger(input.fd) || input.fd < 3 ||
      !policy || policy.provider !== "claude" || ![policy.admissionId, policy.capabilityId, policy.runId, policy.normalizedSessionId, policy.environmentLeaseId, policy.runnerInstanceId].every(stable) ||
      !/^[a-f0-9]{64}$/.test(policy.workerPlanSha256) ||
      !Number.isSafeInteger(policy.deadlineAtMs) || policy.deadlineAtMs <= Date.now() || policy.deadlineAtMs > Date.now() + 300_000 ||
      !canonical(policy.runtimeRoot) || !canonical(policy.workspaceRoot) ||
      !Array.isArray(policy.allowedMcpTools) || policy.allowedMcpTools.length > 128 ||
      policy.allowedMcpTools.some(name => !/^mcp__paperclip__[a-z0-9_]{1,128}$/.test(name)) ||
      new Set(policy.allowedMcpTools).size !== policy.allowedMcpTools.length ||
      typeof policy.bridgeUrl !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[^\s?#]*$/.test(policy.bridgeUrl) ||
      Object.hasOwn(globalThis, hook)) throw failure();
  const metadata = fs.fstatSync(input.fd);
  if (!metadata.isFIFO() && !metadata.isSocket()) throw failure();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let length = 0; let settled = false;
    const stream = new Socket({ fd: input.fd, readable: true, writable: false });
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const copy = error ? undefined : Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      stream.once("close", () => { if (copy) resolve(copy); else reject(failure()); });
      stream.destroy();
    };
    const timer = setTimeout(() => finish(failure()), 2_000);
    stream.on("data", (value: string | Buffer) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (settled) { chunk.fill(0); return; }
      length += chunk.length;
      if (length > 16_384) { chunk.fill(0); finish(failure()); } else chunks.push(chunk);
    });
    stream.once("error", () => finish(failure()));
    stream.once("end", () => finish());
  });
  let token: Buffer;
  let expiresAtMs: number;
  try {
    const frame = JSON.parse(bytes.toString("utf8"));
    if (Object.keys(frame).sort().join(",") !== "accessToken,admissionId,capabilityId,environmentLeaseId,expiresAtMs,normalizedSessionId,provider,runId,runnerInstanceId,schema,workerPlanSha256" ||
        frame.schema !== "paperclip.factory-claude-access.v1" || frame.provider !== "claude" ||
        ["admissionId", "capabilityId", "workerPlanSha256", "runId", "normalizedSessionId", "environmentLeaseId", "runnerInstanceId"].some(key => frame[key] !== policy[key as keyof FactoryClaudeAccessPolicy]) ||
        !Number.isSafeInteger(frame.expiresAtMs) || frame.expiresAtMs <= Date.now() || frame.expiresAtMs > policy.deadlineAtMs ||
        typeof frame.accessToken !== "string" || !/^[A-Za-z0-9._-]{32,4096}$/.test(frame.accessToken)) throw failure();
    token = Buffer.from(frame.accessToken); expiresAtMs = frame.expiresAtMs;
    frame.accessToken = "";
  } catch { throw failure(); } finally { bytes.fill(0); }

  const forbidden = /^(?:ANTHROPIC_|AWS_|AZURE_|GOOGLE_|CLAUDE_CODE_(?:OAUTH|API_KEY|HOST_AUTH|HOST_CREDS|SESSION_ACCESS|GATEWAY|CUSTOM_OAUTH|USE_|HFI_BEARER|SDK_HAS_|SUBSCRIPTION_TYPE|USER_EMAIL|ACCOUNT_|ORGANIZATION_)|CLAUDE_LOCAL_OAUTH|CLAUDE_BG_|CCR_|USE_(?:LOCAL|STAGING)_OAUTH)/;
  const readOwnedJson = (fd: number): Record<string, unknown> => {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || before.size > 65_536n || (before.mode & 0o022n)) throw failure();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    try {
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
        if (!count) break; length += count;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (BigInt(length) !== before.size || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) throw failure();
      const value = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
      return value;
    } finally { buffer.fill(0); }
  };
  const validateHome = (environment: NodeJS.ProcessEnv) => {
    for (const [name, value] of Object.entries(environment)) if (value !== undefined && forbidden.test(name)) throw failure();
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR"]) {
      const value = environment[name];
      if (!canonical(value) || !inside(policy.runtimeRoot, value) || fs.realpathSync(value) !== value) throw failure();
      const info = fs.lstatSync(value);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077)) throw failure();
    }
    for (const root of [environment.HOME!, environment.CLAUDE_CONFIG_DIR!]) {
      for (const name of [".credentials.json", "credentials.json", "auth.json", "managed-settings.json"]) {
        try { fs.lstatSync(path.join(root, name)); throw failure(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure(); }
      }
      const metadataPath = path.join(root, ".claude.json");
      try {
        const fd = fs.openSync(metadataPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const metadata = readOwnedJson(fd);
          if (["oauthAccount", "apiKey", "apiKeyHelper", "env", "hooks"].some(name => Object.hasOwn(metadata, name))) throw failure();
        } finally { fs.closeSync(fd); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure(); }
    }
    const settings = path.join(environment.CLAUDE_CONFIG_DIR!, "settings.json");
    const fd = fs.openSync(settings, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const value = readOwnedJson(fd) as { model?: unknown; availableModels?: unknown; permissions?: { allow?: unknown[] } };
      if (Object.keys(value).some(key => !["model", "availableModels", "permissions"].includes(key)) ||
          (value.permissions && (Object.keys(value.permissions).some(key => key !== "allow") ||
            !Array.isArray(value.permissions.allow) || value.permissions.allow.some(name => typeof name !== "string" || !policy.allowedMcpTools.includes(name))))) throw failure();
    } finally { fs.closeSync(fd); }
  };
  try { validateHome(process.env); } catch { token.fill(0); throw failure(); }
  const expectedExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
  if (!expectedExecutable || !path.isAbsolute(expectedExecutable)) { token.fill(0); throw failure(); }
  let used = false;
  let active: import("node:child_process").ChildProcess | undefined;
  const timer = setTimeout(() => {
    token.fill(0);
    // This is the owned ACP process, already inside its lifetime guardian.
    // Its exit makes that guardian reap the complete provider group.
    process.kill(process.pid, "SIGTERM");
  }, expiresAtMs - Date.now());
  timer.unref();
  const configure = (servers: Record<string, { type?: string; url?: string }>) => {
    if (servers.paperclip?.type !== "http" || servers.paperclip.url !== policy.bridgeUrl) throw failure();
    return {
      tools: [], allowedTools: [...policy.allowedMcpTools], settingSources: ["user"],
      allowDangerouslySkipPermissions: false, permissionMode: "default",
      extraArgs: {}, plugins: [], settings: {}, mcpServers: { paperclip: servers.paperclip },
      canUseTool: async (name: string, value: unknown) => policy.allowedMcpTools.includes(name)
        ? { behavior: "allow", updatedInput: value } : { behavior: "deny", message: "factory_tool_requires_assignment" },
      spawnClaudeCodeProcess(options: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }) {
        if (used || expiresAtMs <= Date.now() || options.command !== expectedExecutable || options.cwd !== policy.workspaceRoot) throw failure();
        used = true;
        try { validateHome(options.env); } catch { token.fill(0); throw failure(); }
        const environment: NodeJS.ProcessEnv = {};
        for (const [name, value] of Object.entries(options.env)) {
          if (/^(?:PATH|LANG|LANGUAGE|TZ|LC_[A-Z0-9_]+|HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|CLAUDE_CONFIG_DIR|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|https?_proxy|HTTPS?_PROXY|NO_PROXY|no_proxy)$/.test(name)) environment[name] = value;
        }
        Object.assign(environment, { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
        const child = spawn(options.command, options.args, { cwd: options.cwd, env: environment, stdio: ["pipe", "pipe", "pipe", "pipe"], shell: false, signal: options.signal });
        active = child;
        const input = child.stdio[3] as import("node:stream").Writable;
        const payload = Buffer.concat([token, Buffer.from("\n")]);
        input.on("error", () => { payload.fill(0); child.kill(); });
        input.end(payload, () => payload.fill(0));
        const needles = [...new Set([token.toString("ascii"), token.toString("base64"), token.toString("base64url"), token.toString("base64").replace(/=+$/, ""), token.toString("hex"), token.toString("hex").toUpperCase()])].sort((a, b) => b.length - a.length);
        const replaceSecrets = (value: string) => needles.reduce((result, needle) => result.split(needle).join("[REDACTED]"), value);
        const redact = (raw: import("node:stream").Readable) => {
          let pending = "";
          const decoder = new StringDecoder("utf8");
          const transform = new Transform({
            transform(chunk, _encoding, callback) {
              pending += decoder.write(chunk);
              const safe = replaceSecrets(pending);
              // Retain only a possible secret prefix. Holding a fixed tail
              // would withhold JSON newlines and deadlock a persistent SDK.
              let retain = 0;
              for (const needle of needles) {
                for (let length = Math.min(needle.length - 1, safe.length); length > retain; length--) {
                  if (needle.startsWith(safe.slice(-length))) { retain = length; break; }
                }
              }
              const count = safe.length - retain;
              this.push(safe.slice(0, count)); pending = safe.slice(count); callback();
            },
            flush(callback) { pending += decoder.end(); this.push(replaceSecrets(pending)); pending = ""; callback(); },
          });
          raw.on("error", () => transform.destroy(failure()));
          raw.pipe(transform); return transform;
        };
        child.stdout = redact(child.stdout!); child.stderr = redact(child.stderr!);
        child.stdio[1] = child.stdout; child.stdio[2] = child.stderr;
        child.on("error", error => { error.message = "factory_claude_access_unverified"; });
        child.once("close", () => { token.fill(0); active = undefined; clearTimeout(timer); });
        return child;
      },
    };
  };
  Object.defineProperty(globalThis, hook, { value: configure, configurable: false, writable: false });
  process.once("exit", () => { token.fill(0); if (active) active.kill(); });
}

export function factoryClaudeAccessBootstrap(fd: number, policy: FactoryClaudeAccessPolicy): string {
  // tsx/keepNames can insert this identity helper into serialized callbacks.
  // Supply it lexically rather than granting any ambient bootstrap global.
  const projectedPolicy = projectFactoryClaudeAccessPolicy(policy);
  return `((__name) => (${installFactoryClaudeAccess.toString()})(${JSON.stringify({ fd, policy: projectedPolicy })}))((value) => value)`;
}
