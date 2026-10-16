import { and, eq } from "drizzle-orm";
import { environmentLeases, environments, executionWorkspaces, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { AdapterExecutionTarget, AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { FACTORY_COMPANY_ID, FACTORY_WORKER_POLICY, createFactoryWorkerLeaseDescriptor,
  type FactoryWorkerBusyError } from "@paperclipai/adapter-utils/factory-worker-lease";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { hasFactoryBusyReceipt } from "./factory-worker-capacity.js";
import { validateDedicatedSshTarget } from "@paperclipai/adapter-utils/ssh-duplex";
import { NativeRunnerOwnershipUnverifiedError } from "./native-runner-ownership.js";
import { randomUUID } from "node:crypto";
import { validateFactoryProviderBinding, type FactoryProviderBinding } from "@paperclipai/adapter-utils/factory-provider-admission";

export interface FactoryWorkerAttempt {
  readonly runId: string;
  busy?: FactoryWorkerBusyError;
}
export function isFactoryWorkerTarget(target: AdapterExecutionTarget | null | undefined): target is AdapterSshExecutionTarget {
  return target?.kind === "remote" && target.transport === "ssh" && target.factoryWorkerPolicy === FACTORY_WORKER_POLICY;
}
export function assertFactoryWorkerColdExecution(execution: NativeExecutionInput, recovery: unknown): void {
  const providerAllowed = execution.provider.kind === "codex" ||
    (execution.provider.kind === "acpx" && execution.provider.agent === "claude");
  if (!providerAllowed || execution.binding.companyId !== FACTORY_COMPANY_ID || execution.session.lifecyclePolicy.mode !== "per_turn" || recovery) {
    throw new NativeRunnerOwnershipUnverifiedError("ssh_foreground_ownership_unverified");
  }
}

export function assertFactoryWorkerCredentialBoundary(environment: NodeJS.ProcessEnv | undefined, managedHome: string | undefined): void {
  if (managedHome || Object.keys(environment ?? {}).some(key =>
    !key.startsWith("PAPERCLIP_NATIVE_MCP_") &&
    /(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|OAUTH_TOKEN|AUTH_TOKEN|BASE_URL|API_BASE|ENDPOINT)$/.test(key))) {
    throw new NativeRunnerOwnershipUnverifiedError("ssh_foreground_ownership_unverified");
  }
}

/** Environments are instance-wide; the acquired lease and workspace establish company authority. */
export async function authorizeFactoryWorker(input: {
  db: Db; execution: NativeExecutionInput; target: AdapterSshExecutionTarget;
  beforeClaim?: boolean;
}) {
  const { binding } = input.execution;
  const target = input.target;
  const fail = (): never => { throw new NativeRunnerOwnershipUnverifiedError("ssh_foreground_ownership_unverified"); };
  if (!isFactoryWorkerTarget(target) || binding.companyId !== FACTORY_COMPANY_ID || !target.environmentId || !target.leaseId) fail();
  validateDedicatedSshTarget({ ...target.spec, remoteCwd: target.remoteCwd });
  const [lease] = await input.db.select().from(environmentLeases).where(and(
    eq(environmentLeases.id, target.leaseId!), eq(environmentLeases.companyId, binding.companyId),
  ));
  const [environment] = await input.db.select().from(environments).where(and(
    eq(environments.id, target.environmentId!),
  ));
  const [workspace] = await input.db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, binding.executionWorkspaceId), eq(executionWorkspaces.companyId, binding.companyId),
  ));
  const [run] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
  ));
  const expectedCwd = `/workspace/${binding.companyId}/${binding.executionWorkspaceId}`;
  if (!lease || lease.environmentId !== target.environmentId || lease.heartbeatRunId !== binding.runId ||
      lease.executionWorkspaceId !== binding.executionWorkspaceId || lease.issueId !== binding.issueId ||
      lease.status !== "active" || lease.provider !== "ssh" || lease.releasedAt !== null ||
      (lease.expiresAt !== null && lease.expiresAt.getTime() <= Date.now()) ||
      lease.metadata?.remoteCwd !== expectedCwd || !environment || environment.driver !== "ssh" || environment.status !== "active" ||
      environment.config?.factoryWorkerPolicy !== FACTORY_WORKER_POLICY ||
      environment.config?.remoteWorkspacePath !== expectedCwd || target.remoteCwd !== expectedCwd ||
      environment.config?.host !== target.spec.host || (environment.config?.port ?? 22) !== target.spec.port ||
      environment.config?.username !== target.spec.username || environment.config?.knownHosts !== target.spec.knownHosts ||
      environment.config?.strictHostKeyChecking === false || !target.spec.strictHostKeyChecking ||
      !workspace || workspace.status !== "active" || !run || run.agentId !== binding.agentId ||
      run.nativeIssueId !== binding.issueId || run.runtimeMode !== "native" || run.status !== "running") fail();
  if (input.beforeClaim) {
    const [coordinator] = await input.db.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, binding.runId), eq(nativeRunFinalizations.companyId, binding.companyId),
    ));
    if (!coordinator || !["observed", "retryable_failure"].includes(coordinator.phase) ||
        coordinator.resultId || coordinator.issueId !== binding.issueId ||
        (coordinator.attempt !== 0 && !hasFactoryBusyReceipt(coordinator, binding.runId))) fail();
  }
  const registered = environment!.config?.factoryProviderAdmission;
  const selected = target.factoryProviderAdmission;
  const validMode = (value: unknown): value is { provider: "codex"; workerPlanSha256: string } =>
    value !== null && typeof value === "object" && Object.keys(value).length === 2 &&
    (value as Record<string, unknown>).provider === "codex" &&
    typeof (value as Record<string, unknown>).workerPlanSha256 === "string" &&
    /^[a-f0-9]{64}$/.test((value as Record<string, string>).workerPlanSha256);
  if (registered !== undefined || selected !== undefined) {
    if (!validMode(registered) || !validMode(selected) || input.execution.provider.kind !== "codex" ||
        registered.workerPlanSha256 !== selected.workerPlanSha256) fail();
  }
  return { run, lease, providerMode: selected };
}

export async function createAuthorizedFactoryWorkerLease(input: {
  db: Db; execution: NativeExecutionInput; target: AdapterSshExecutionTarget; sessionId: string;
  timeoutMs?: number;
}) {
  const { run, lease, providerMode } = await authorizeFactoryWorker(input);
  // An older caller must never silently downgrade an explicitly enrolled mode.
  if (providerMode) throw new NativeRunnerOwnershipUnverifiedError("ssh_foreground_ownership_unverified");
  return descriptor(input, run, lease);
}

function descriptor(input: {
  execution: NativeExecutionInput; target: AdapterSshExecutionTarget; sessionId: string; timeoutMs?: number;
}, run: typeof heartbeatRuns.$inferSelect, lease: typeof environmentLeases.$inferSelect) {
  const now = Date.now();
  const duration = input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? Math.min(300_000, input.timeoutMs) : 300_000;
  const deadlineUnixMs = Math.min(now + Math.floor(duration), run.executionControlDeadlineAt?.getTime() ?? Infinity,
    lease.expiresAt?.getTime() ?? Infinity);
  return createFactoryWorkerLeaseDescriptor({ companyId: input.execution.binding.companyId,
    runId: input.execution.binding.runId, leaseId: lease.id,
    workspaceId: input.execution.binding.executionWorkspaceId, sessionId: input.sessionId,
    workspaceRoot: input.target.remoteCwd, deadlineUnixMs });
}

/** One DB-current, post-staging authorization; caller supplies actual native identity. */
export async function createAuthorizedFactoryWorkerAdmission(input: {
  db: Db; execution: NativeExecutionInput; target: AdapterSshExecutionTarget; sessionId: string;
  runnerInstanceId: string; durableEnvironmentLeaseId?: string; timeoutMs?: number;
}) {
  const attempt = { ...input, execution: structuredClone(input.execution), target: structuredClone(input.target) };
  const { run, lease, providerMode } = await authorizeFactoryWorker(attempt);
  const workerLease = descriptor(attempt, run, lease);
  if (!providerMode) return { workerLease };
  const fail = (): never => { throw new NativeRunnerOwnershipUnverifiedError("ssh_foreground_ownership_unverified"); };
  const stored = run.runnerProfileJson?.nativeExecutionInput as NativeExecutionInput | undefined;
  const nativeSession = attempt.execution.session.normalizedSessionId ?? `session-${run.id}`;
  if (attempt.execution.provider.kind !== "codex" || attempt.execution.session.lifecyclePolicy.mode !== "per_turn" ||
      attempt.sessionId !== nativeSession || run.runnerInstanceId !== attempt.runnerInstanceId ||
      !stored || stored.binding?.runId !== run.id || stored.binding?.companyId !== run.companyId ||
      stored.binding?.agentId !== attempt.execution.binding.agentId || stored.binding?.issueId !== attempt.execution.binding.issueId ||
      stored.binding?.executionWorkspaceId !== attempt.execution.binding.executionWorkspaceId ||
      stored.provider?.kind !== "codex" ||
      stored.session?.lifecyclePolicy?.mode !== "per_turn" ||
      stored.session?.driverKind !== attempt.execution.session.driverKind || stored.session?.protocolVersion !== 1 ||
      (attempt.durableEnvironmentLeaseId !== undefined && attempt.durableEnvironmentLeaseId !== lease.id) ||
      (run.runnerProfileJson?.durableEnvironmentLeaseId !== undefined && run.runnerProfileJson.durableEnvironmentLeaseId !== lease.id) ||
      (stored.session?.normalizedSessionId ?? `session-${run.id}`) !== nativeSession) fail();
  const providerAdmission: FactoryProviderBinding = {
    schema: "factory.provider-worker-binding.v2", provider: "codex",
    admissionId: randomUUID(), capabilityId: randomUUID(), normalizedSessionId: nativeSession,
    runnerInstanceId: attempt.runnerInstanceId, workerPlanSha256: providerMode.workerPlanSha256,
  };
  validateFactoryProviderBinding(providerAdmission);
  return { workerLease, providerAdmission };
}
