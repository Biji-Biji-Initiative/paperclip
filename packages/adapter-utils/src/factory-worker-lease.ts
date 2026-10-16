import { createHash } from "node:crypto";

export const FACTORY_WORKER_MARKER = "factory-worker-lease-v1" as const;
export const FACTORY_WORKER_POLICY = "factory-worker-scope-v2" as const;
export const FACTORY_COMPANY_ID = "740ad7ee-0c28-4e07-b9d1-ca7b35da820d" as const;
export const FACTORY_LEASE_MAX_HEADER_BYTES = 64 * 1024;
export const FACTORY_WORKER_BUSY_EXIT = 75;
export const FACTORY_WORKER_HELD_EXIT = 76;

/** Explicit enrollment seam. None of these fields come from a model or prompt. */
export interface FactoryWorkerLeaseDescriptor {
  protocol: typeof FACTORY_WORKER_MARKER;
  policy: typeof FACTORY_WORKER_POLICY;
  companyId: typeof FACTORY_COMPANY_ID;
  runId: string;
  leaseId: string;
  workspaceId: string;
  sessionId: string;
  workspaceRoot: string;
  sessionRoot: string;
  stateDirectory: string;
  filesystemDirectory: string;
  diagnosticsDirectory: string;
  deadlineUnixMs: number;
}
export interface FactoryWorkerLaunchHeader extends FactoryWorkerLeaseDescriptor {
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION = /^[A-Za-z0-9._:-]{1,256}$/;
const descriptorKeys = ["protocol", "policy", "companyId", "runId", "leaseId", "workspaceId", "sessionId",
  "workspaceRoot", "sessionRoot", "stateDirectory", "filesystemDirectory", "diagnosticsDirectory", "deadlineUnixMs"];

function invalid(): never { throw new Error("factory_worker_lease_invalid"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cleanString(value: unknown, max: number): value is string {
  // Reject unmatched UTF-16 surrogates: JSON round trips must mean the same UTF-8
  // bytes in the Python validator and in the model's exact argument vector.
  return typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= max &&
    Buffer.from(value).toString("utf8") === value;
}
function under(value: string, root: string): boolean {
  return value === root || value.startsWith(root + "/");
}
function path(value: unknown): value is string {
  return cleanString(value, 4096) && value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value) &&
    value.slice(1).split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function validateFactoryWorkerLeaseDescriptor(
  value: unknown, now = Date.now(),
): asserts value is FactoryWorkerLeaseDescriptor {
  if (!record(value) || Object.keys(value).length !== descriptorKeys.length ||
      descriptorKeys.some(key => !Object.hasOwn(value, key)) ||
      value.protocol !== FACTORY_WORKER_MARKER || value.policy !== FACTORY_WORKER_POLICY ||
      value.companyId !== FACTORY_COMPANY_ID) invalid();
  for (const key of ["runId", "leaseId", "workspaceId"]) {
    if (typeof value[key] !== "string" || value[key].length !== 36 || !UUID.test(value[key])) invalid();
  }
  if (typeof value.sessionId !== "string" || !SESSION.test(value.sessionId)) invalid();
  const workspace = `/workspace/${FACTORY_COMPANY_ID}/${value.workspaceId}`;
  const session = `${workspace}/.paperclip-runtime/paperclip-runner/sessions/` +
    createHash("sha256").update(value.sessionId).digest("hex");
  for (const [key, expected] of Object.entries({workspaceRoot: workspace, sessionRoot: session,
    stateDirectory: session + "/runner", filesystemDirectory: session + "/filesystem",
    diagnosticsDirectory: session + "/diagnostics"})) {
    if (!path(value[key]) || value[key] !== expected) invalid();
  }
  if (typeof value.deadlineUnixMs !== "number" || !Number.isSafeInteger(value.deadlineUnixMs) ||
      value.deadlineUnixMs <= now || value.deadlineUnixMs > now + 300_000) invalid();
}

/** Build only from already authorized resolved runtime metadata, not a default. */
export function createFactoryWorkerLeaseDescriptor(input: {
  companyId: string; runId: string; leaseId: string; workspaceId: string;
  sessionId: string; workspaceRoot: string; deadlineUnixMs: number;
}): FactoryWorkerLeaseDescriptor {
  const sessionRoot = input.workspaceRoot + "/.paperclip-runtime/paperclip-runner/sessions/" +
    createHash("sha256").update(input.sessionId).digest("hex");
  const descriptor = {
    protocol: FACTORY_WORKER_MARKER, policy: FACTORY_WORKER_POLICY, ...input,
    sessionRoot, stateDirectory: sessionRoot + "/runner",
    filesystemDirectory: sessionRoot + "/filesystem", diagnosticsDirectory: sessionRoot + "/diagnostics",
  };
  validateFactoryWorkerLeaseDescriptor(descriptor);
  return Object.freeze(descriptor);
}

export const FACTORY_LEASE_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", USER: "node", LOGNAME: "node",
  HOME: "/home/node/lease", XDG_CONFIG_HOME: "/home/node/lease/.config",
  XDG_DATA_HOME: "/home/node/lease/.local/share", XDG_CACHE_HOME: "/home/node/lease/.cache",
  TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp",
  HTTP_PROXY: "http://factory-gateway:3128", HTTPS_PROXY: "http://factory-gateway:3128",
  http_proxy: "http://factory-gateway:3128", https_proxy: "http://factory-gateway:3128",
  PAPERCLIP_RUNNER_CONNECT_PROXY: "http://factory-gateway:3128",
  NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
});
const homeKeys = new Set(["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]);

export function encodeFactoryWorkerLaunch(
  descriptor: FactoryWorkerLeaseDescriptor,
  command: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  now = Date.now(),
): Buffer {
  validateFactoryWorkerLeaseDescriptor(descriptor, now);
  if (!Array.isArray(command) || command.length < 1 || command.length > 256 ||
      command.some(arg => !cleanString(arg, 16384)) ||
      command[0] !== descriptor.workspaceRoot + "/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd") invalid();
  if (!record(environment) || Object.keys(environment).length > 48) invalid();
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !cleanString(value, 8192)) invalid();
    if (homeKeys.has(key)) {
      if (!path(value) || !(under(value, descriptor.filesystemDirectory) || under(value, "/home/node/lease"))) invalid();
    } else if (key === "PAPERCLIP_RUNNER_BOOTSTRAP_TICKET") {
      if (value.length !== "bootstrap_".length + 36 || !value.startsWith("bootstrap_") || !UUID.test(value.slice("bootstrap_".length))) invalid();
    } else if (key === "PAPERCLIP_PROVIDER_TRACE_PATH") {
      if (!path(value) || !under(value, descriptor.diagnosticsDirectory)) invalid();
    } else if (key === "DO_NOT_TRACK" || key === "PAPERCLIP_RUNNER_TRACE") {
      if (value !== "0" && value !== "1") invalid();
    } else if (key === "PAPERCLIP_WORKSPACE_CWD") {
      if (value !== descriptor.workspaceRoot) invalid();
    } else if (Object.hasOwn(FACTORY_LEASE_FIXED_ENV, key)) {
      if (value !== FACTORY_LEASE_FIXED_ENV[key]) invalid();
    } else invalid();
  }
  const header = Buffer.from(JSON.stringify({...descriptor, command: [...command], environment: {...environment}}) + "\n");
  if (header.length > FACTORY_LEASE_MAX_HEADER_BYTES) invalid();
  return header;
}

export class FactoryWorkerBusyError extends Error {
  readonly code = "factory_worker_busy";
  readonly dispatchAttempted = false;
  readonly retryable = true;
  // Constructed only after a verified matching busy receipt, SSH exit 75 and
  // successful channel cleanup. A remote program's ordinary exit 75 is not this.
  constructor() { super("factory_worker_busy"); this.name = "FactoryWorkerBusyError"; }
}
export function isFactoryWorkerBusyError(error: unknown): error is FactoryWorkerBusyError {
  return error instanceof FactoryWorkerBusyError;
}
