import { closeSync, fstatSync } from "node:fs";
import { Socket } from "node:net";
import { isAbsolute, normalize } from "node:path";
import type { FactoryClaudeAccessHandoff } from "./factory-claude-access.js";

export const FACTORY_CLAUDE_SIDECAR_FLAG = "--factory-claude-access-v1";
const FAILURE = "factory_claude_access_unverified";
const bindingKeys = ["admissionId", "capabilityId", "workerPlanSha256", "runId", "normalizedSessionId", "environmentLeaseId", "runnerInstanceId", "deadlineAtMs"] as const;
export interface FactoryClaudeSidecarBinding {
  admissionId: string;
  capabilityId: string;
  workerPlanSha256: string;
  runId: string;
  normalizedSessionId: string;
  environmentLeaseId: string;
  runnerInstanceId: string;
  deadlineAtMs: number;
}
declare const startupBrand: unique symbol;
export interface FactoryClaudeSidecarAccess { readonly [startupBrand]: true }
interface Startup {
  binding: FactoryClaudeSidecarBinding;
  runtimeDirectory: string;
  workingDirectory: string;
  bytes: Buffer;
  expiresAtMs: number;
  timer: NodeJS.Timeout;
  opened: boolean;
}
const capabilities = new WeakMap<FactoryClaudeSidecarAccess, Startup>();
let startup: FactoryClaudeSidecarAccess | undefined;

function fail(): never { throw new Error(FAILURE); }
function closedRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key] || !("value" in descriptors[key]))) return fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function canonical(input: unknown): input is string {
  return typeof input === "string" && input.length <= 4096 && isAbsolute(input) && input !== "/" && normalize(input) === input && !/[\x00-\x1f\x7f]/.test(input);
}
export function parseFactoryClaudeSidecarBinding(input: unknown): FactoryClaudeSidecarBinding {
  const value = closedRecord(input, bindingKeys);
  for (const key of bindingKeys.filter(key => key !== "deadlineAtMs" && key !== "workerPlanSha256")) {
    if (typeof value[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value[key] as string)) return fail();
  }
  if (typeof value.workerPlanSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.workerPlanSha256) ||
    typeof value.deadlineAtMs !== "number" || !Number.isSafeInteger(value.deadlineAtMs) || value.deadlineAtMs <= Date.now() || value.deadlineAtMs > Date.now() + 300_000) return fail();
  return value as unknown as FactoryClaudeSidecarBinding;
}
function sameBinding(actual: FactoryClaudeSidecarBinding, expected: FactoryClaudeSidecarBinding): boolean {
  return bindingKeys.every(key => actual[key] === expected[key]);
}
async function readPipe(fd: number, signal: AbortSignal): Promise<Buffer> {
  const stat = fstatSync(fd);
  if (!stat.isFIFO() && !stat.isSocket()) { closeSync(fd); return fail(); }
  // net.Socket wraps an owned Unix socket/pipe in libuv's nonblocking handle;
  // fs.ReadStream can leave a blocking worker read alive after AbortSignal.
  return new Promise((resolve, reject) => {
    const stream = new Socket({ fd, readable: true, writable: false });
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    const finish = (error: boolean) => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", abort);
      const result = error ? undefined : Buffer.concat(chunks, size);
      for (const chunk of chunks) chunk.fill(0);
      stream.once("close", () => { if (result) resolve(result); else reject(new Error(FAILURE)); });
      stream.destroy();
    };
    const abort = () => finish(true);
    stream.on("data", (bytes: Buffer) => {
      if (settled) { bytes.fill(0); return; }
      chunks.push(bytes); size += bytes.length;
      if (size > 16_384) finish(true);
    });
    stream.once("error", () => finish(true));
    stream.once("end", () => finish(size === 0));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Called only by the builtin-only launcher, before runtime/tool modules load. */
export async function initializeFactoryClaudeSidecarAccess(): Promise<void> {
  if (!process.argv.includes(FACTORY_CLAUDE_SIDECAR_FLAG)) return;
  if (process.platform !== "linux" || process.argv.length !== 3 || process.argv[2] !== FACTORY_CLAUDE_SIDECAR_FLAG || startup) return fail();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 2_000);
  let metadata: Buffer | undefined;
  let access: Buffer | undefined;
  try {
    const reads = await Promise.allSettled([readPipe(3, controller.signal), readPipe(4, controller.signal)]);
    if (reads[0].status === "fulfilled") metadata = reads[0].value;
    if (reads[1].status === "fulfilled") access = reads[1].value;
    if (!metadata || !access) return fail();
    const raw = closedRecord(JSON.parse(metadata.toString("utf8")), ["schema", "provider", ...bindingKeys, "runtimeDirectory", "workingDirectory"]);
    if (raw.schema !== "paperclip.factory-claude-sidecar.v1" || raw.provider !== "claude" || !canonical(raw.runtimeDirectory) || !canonical(raw.workingDirectory)) return fail();
    const binding = parseFactoryClaudeSidecarBinding(Object.fromEntries(bindingKeys.map(key => [key, raw[key]])));
    const grant = closedRecord(JSON.parse(access.toString("utf8")), ["schema", "provider", ...bindingKeys.filter(key => key !== "deadlineAtMs"), "expiresAtMs", "accessToken"]);
    if (grant.schema !== "paperclip.factory-claude-access.v1" || grant.provider !== "claude" ||
      !bindingKeys.filter(key => key !== "deadlineAtMs").every(key => grant[key] === binding[key]) ||
      typeof grant.expiresAtMs !== "number" || !Number.isSafeInteger(grant.expiresAtMs) || grant.expiresAtMs <= Date.now() || grant.expiresAtMs > binding.deadlineAtMs ||
      typeof grant.accessToken !== "string" || !/^[A-Za-z0-9._-]{32,4096}$/.test(grant.accessToken)) return fail();
    const cap = Object.freeze({}) as FactoryClaudeSidecarAccess;
    const bytes = access; access = undefined;
    const timer = setTimeout(() => { bytes.fill(0); capabilities.delete(cap); }, Math.max(1, grant.expiresAtMs - Date.now()));
    timer.unref();
    capabilities.set(cap, { binding, runtimeDirectory: raw.runtimeDirectory, workingDirectory: raw.workingDirectory, bytes, expiresAtMs: grant.expiresAtMs, timer, opened: false });
    process.once("exit", () => { bytes.fill(0); clearTimeout(timer); });
    startup = cap;
  } catch { return fail(); }
  finally { clearTimeout(deadline); controller.abort(); metadata?.fill(0); access?.fill(0); }
}

/** Private module state, never an environment/global accessor or serialized value. */
export function factoryClaudeSidecarAccess(): FactoryClaudeSidecarAccess | undefined { return startup; }
export function retireFactoryClaudeSidecarAccess(access: FactoryClaudeSidecarAccess): void {
  const value = capabilities.get(access);
  if (!value) return;
  value.bytes.fill(0); clearTimeout(value.timer); capabilities.delete(access);
}
export function verifyFactoryClaudeSidecarOpen(access: FactoryClaudeSidecarAccess | undefined, input: {
  factoryBinding?: FactoryClaudeSidecarBinding;
  agent: string; permissionMode: string; normalizedSessionId: string; runtimeDirectory: string; workingDirectory: string;
}): void {
  if (!access) { if (input.factoryBinding !== undefined) return fail(); return; }
  const value = capabilities.get(access);
  let matches = false;
  try { matches = input.factoryBinding !== undefined && value !== undefined && sameBinding(parseFactoryClaudeSidecarBinding(input.factoryBinding), value.binding); }
  catch { /* Reject with the fixed failure after retiring the owned buffer. */ }
  if (!value || value.expiresAtMs <= Date.now() || value.opened || !matches ||
    input.agent !== "claude" || input.permissionMode !== "approve-paperclip" || input.normalizedSessionId !== value.binding.normalizedSessionId ||
    input.runtimeDirectory !== value.runtimeDirectory || input.workingDirectory !== value.workingDirectory) { retireFactoryClaudeSidecarAccess(access); return fail(); }
  value.opened = true;
}
export function verifyFactoryClaudeSidecarRun(access: FactoryClaudeSidecarAccess | undefined, runId: string): void {
  if (!access) return;
  const value = capabilities.get(access);
  if (!value || value.expiresAtMs <= Date.now() || !value.opened || value.binding.runId !== runId || value.binding.deadlineAtMs <= Date.now()) { retireFactoryClaudeSidecarAccess(access); return fail(); }
}

export async function createFactoryClaudeSidecarHandoff(access: FactoryClaudeSidecarAccess, actual: {
  normalizedSessionId: string; runtimeDirectory: string; runtimeRoot: string; workspaceRoot: string; bridgeUrl: string; allowedMcpTools: readonly string[];
}): Promise<FactoryClaudeAccessHandoff> {
  const value = capabilities.get(access);
  if (!value || value.expiresAtMs <= Date.now() || !value.opened || value.bytes.length === 0 || value.bytes.every(byte => byte === 0) || actual.normalizedSessionId !== value.binding.normalizedSessionId || actual.runtimeDirectory !== value.runtimeDirectory || actual.workspaceRoot !== value.workingDirectory) return fail();
  const { createFactoryClaudeAccessBufferHandoff } = await import("./factory-claude-access.js");
  const bytes = value.bytes;
  value.bytes = Buffer.alloc(0);
  try {
    return createFactoryClaudeAccessBufferHandoff(bytes, { provider: "claude", ...value.binding, deadlineAtMs: value.expiresAtMs, runtimeRoot: actual.runtimeRoot, workspaceRoot: actual.workspaceRoot, bridgeUrl: actual.bridgeUrl, allowedMcpTools: actual.allowedMcpTools });
  } finally { bytes.fill(0); }
}
