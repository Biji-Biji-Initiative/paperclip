import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { FACTORY_COMPANY_ID, encodeFactoryWorkerLaunch, validateFactoryWorkerLeaseDescriptor,
  type FactoryWorkerLeaseDescriptor } from "./factory-worker-lease.js";

export const FACTORY_PROVIDER_MARKER = "factory-worker-provider-lease-v1" as const;
export const FACTORY_PROVIDER_POLICY = "factory-worker-provider-scope-v1" as const;
export const FACTORY_ADMISSION_NAMESPACE = "factory-provider-admission-v1@mereka.io" as const;
export const FACTORY_ADMISSION_SIGNED_SCHEMA = "factory.provider-controller-signed.v1" as const;
export interface FactoryProviderBinding {
  schema: "factory.provider-worker-binding.v1";
  provider: "codex";
  admissionId: string;
  capabilityId: string;
  normalizedSessionId: string;
  runnerInstanceId: string;
  workerPlanSha256: string;
}
export interface FactoryPreparedReceipt {
  protocol: typeof FACTORY_PROVIDER_MARKER;
  type: "preparation";
  status: "prepared";
  companyId: string;
  runId: string;
  leaseId: string;
  sessionId: string;
  ownerNonce: string;
  bootId: string;
  createdUnixMs: number;
  deadlineUnixMs: number;
  workerPlanSha256: string;
  dispatchAttempted: false;
}
export interface FactoryControllerAdmission {
  schema: "factory.provider-controller-admission.v1";
  admissionId: string;
  companyId: typeof FACTORY_COMPANY_ID;
  capabilityId: string;
  runId: string;
  environmentLeaseId: string;
  workerSessionId: string;
  normalizedSessionId: string;
  runnerInstanceId: string;
  workerOwnerNonce: string;
  workerPlanSha256: string;
  bootId: string;
  createdUnixMs: number;
  admittedUntilUnixMs: number;
}
export interface FactorySignedAdmission {
  schema: typeof FACTORY_ADMISSION_SIGNED_SCHEMA;
  payload: string;
  signature: string;
}
const bindingKeys = ["schema", "provider", "admissionId", "capabilityId", "normalizedSessionId", "runnerInstanceId", "workerPlanSha256"];
const preparedKeys = ["protocol", "type", "status", "companyId", "runId", "leaseId", "sessionId", "ownerNonce", "bootId",
  "createdUnixMs", "deadlineUnixMs", "workerPlanSha256", "dispatchAttempted"];
const admissionKeys = ["schema", "admissionId", "companyId", "capabilityId", "runId", "environmentLeaseId", "workerSessionId",
  "normalizedSessionId", "runnerInstanceId", "workerOwnerNonce", "workerPlanSha256", "bootId", "createdUnixMs", "admittedUntilUnixMs"];
const ID = /^[A-Za-z0-9_.:@+-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): never { throw new Error("factory_provider_admission_invalid"); }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }

export function validateFactoryProviderBinding(value: unknown): asserts value is FactoryProviderBinding {
  if (!exact(value, bindingKeys) || value.schema !== "factory.provider-worker-binding.v1" || value.provider !== "codex" ||
      ["admissionId", "capabilityId", "normalizedSessionId", "runnerInstanceId"].some(key => !id(value[key])) ||
      typeof value.workerPlanSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.workerPlanSha256)) invalid();
}

export function encodeFactoryProviderLaunch(descriptor: FactoryWorkerLeaseDescriptor, binding: FactoryProviderBinding,
  command: readonly string[], environment?: Readonly<Record<string, string>>): Buffer {
  validateFactoryProviderBinding(binding);
  const flags: Record<string, string> = { "--run-id": descriptor.runId, "--environment-lease-id": descriptor.leaseId,
    "--session-id": binding.normalizedSessionId, "--runner-id": binding.runnerInstanceId };
  for (const [flag, expected] of Object.entries(flags)) {
    const positions = command.flatMap((value, index) => value === flag ? [index] : []);
    if (positions.length !== 1 || command[positions[0]! + 1] !== expected || command.some(value => value.startsWith(flag + "="))) invalid();
  }
  const base = encodeFactoryWorkerLaunch(descriptor, command, environment);
  try {
    const value = JSON.parse(base.toString("utf8")) as Record<string, unknown>;
    const body = Buffer.from(JSON.stringify({ ...value, protocol: FACTORY_PROVIDER_MARKER,
      policy: FACTORY_PROVIDER_POLICY, providerAdmission: binding }) + "\n");
    if (body.length > 65536) invalid();
    return body;
  } finally { base.fill(0); }
}

export function validateFactoryPreparedReceipt(value: unknown, descriptor: FactoryWorkerLeaseDescriptor,
  binding: FactoryProviderBinding): asserts value is FactoryPreparedReceipt {
  validateFactoryWorkerLeaseDescriptor(descriptor);
  validateFactoryProviderBinding(binding);
  if (!exact(value, preparedKeys) || value.protocol !== FACTORY_PROVIDER_MARKER || value.type !== "preparation" ||
      value.status !== "prepared" || value.dispatchAttempted !== false ||
      ["companyId", "runId", "leaseId", "sessionId"].some(key => value[key] !== descriptor[key as keyof FactoryWorkerLeaseDescriptor]) ||
      value.workerPlanSha256 !== binding.workerPlanSha256 || value.deadlineUnixMs !== descriptor.deadlineUnixMs ||
      typeof value.ownerNonce !== "string" || !/^[a-f0-9]{32}$/.test(value.ownerNonce) ||
      typeof value.bootId !== "string" || !UUID.test(value.bootId) || !integer(value.createdUnixMs) ||
      value.createdUnixMs <= 0 || value.createdUnixMs > Date.now() + 5000) invalid();
}

export function createFactoryControllerAdmission(descriptor: FactoryWorkerLeaseDescriptor, binding: FactoryProviderBinding,
  prepared: unknown): FactoryControllerAdmission {
  validateFactoryPreparedReceipt(prepared, descriptor, binding);
  return { schema: "factory.provider-controller-admission.v1", admissionId: binding.admissionId,
    companyId: FACTORY_COMPANY_ID, capabilityId: binding.capabilityId, runId: descriptor.runId,
    environmentLeaseId: descriptor.leaseId, workerSessionId: descriptor.sessionId,
    normalizedSessionId: binding.normalizedSessionId, runnerInstanceId: binding.runnerInstanceId,
    workerOwnerNonce: prepared.ownerNonce, workerPlanSha256: binding.workerPlanSha256,
    bootId: prepared.bootId, createdUnixMs: prepared.createdUnixMs, admittedUntilUnixMs: descriptor.deadlineUnixMs };
}

export function encodeFactoryControllerAdmission(value: FactoryControllerAdmission): Buffer {
  if (!exact(value, admissionKeys) || value.schema !== "factory.provider-controller-admission.v1" || value.companyId !== FACTORY_COMPANY_ID ||
      ["admissionId", "capabilityId", "runId", "environmentLeaseId", "normalizedSessionId", "runnerInstanceId"].some(key => !id(value[key])) ||
      typeof value.workerSessionId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.workerSessionId) ||
      typeof value.workerOwnerNonce !== "string" || !/^[a-f0-9]{32}$/.test(value.workerOwnerNonce) ||
      typeof value.workerPlanSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.workerPlanSha256) ||
      typeof value.bootId !== "string" || !UUID.test(value.bootId) || !integer(value.createdUnixMs) || value.createdUnixMs <= 0 ||
      value.createdUnixMs > Date.now() + 5000 || !integer(value.admittedUntilUnixMs) ||
      value.admittedUntilUnixMs <= Date.now() || value.admittedUntilUnixMs > Date.now() + 300000) invalid();
  return Buffer.from(JSON.stringify(Object.fromEntries([...admissionKeys].sort().map(key => [key, value[key as keyof FactoryControllerAdmission]]))) + "\n");
}

type StartSigner = (args: readonly string[], environment: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
const startSigner: StartSigner = (args, env) => spawn("/usr/local/bin/ssh-keygen", [...args], { stdio: ["pipe", "pipe", "pipe"], env });

/** keyPath belongs only to openDedicatedSshDuplex's private temp-key lifecycle. */
export async function signFactoryControllerAdmission(value: FactoryControllerAdmission, keyPath: string, signal?: AbortSignal,
  start: StartSigner = startSigner): Promise<FactorySignedAdmission> {
  const body = encodeFactoryControllerAdmission(value);
  if (!isAbsolute(keyPath) || keyPath.includes("\0") || signal?.aborted) throw new Error("factory_provider_signing_held");
  return await new Promise<FactorySignedAdmission>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = start(["-Y", "sign", "-f", keyPath, "-n", FACTORY_ADMISSION_NAMESPACE],
      { PATH: "/usr/bin:/bin:/usr/local/bin", LANG: "C", LC_ALL: "C" }); }
    catch { body.fill(0); reject(new Error("factory_provider_signing_held")); return; }
    const chunks: Buffer[] = [];
    let bytes = 0, settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", fail); body.fill(0); };
    const fail = () => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* Local signer retirement only. */ }
      cleanup(); reject(new Error("factory_provider_signing_held"));
    };
    const timer = setTimeout(fail, Math.min(2000, Math.max(1, value.admittedUntilUnixMs - Date.now())));
    signal?.addEventListener("abort", fail, { once: true });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stderr.on("data", () => { /* Never retain key paths or raw signer errors. */ });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4096) { fail(); return; }
      chunks.push(Buffer.from(chunk));
    });
    child.on("close", (code, exitSignal) => {
      if (settled) return;
      const signature = Buffer.concat(chunks).toString("ascii");
      if (code !== 0 || exitSignal !== null || !signature.startsWith("-----BEGIN SSH SIGNATURE-----\n") ||
          !signature.endsWith("-----END SSH SIGNATURE-----\n") || Date.now() >= value.admittedUntilUnixMs) { fail(); return; }
      const result: FactorySignedAdmission = { schema: FACTORY_ADMISSION_SIGNED_SCHEMA, payload: body.toString("base64"), signature };
      settled = true; cleanup(); resolve(result);
    });
    child.stdin.end(body);
    if (signal?.aborted) fail();
  });
}
