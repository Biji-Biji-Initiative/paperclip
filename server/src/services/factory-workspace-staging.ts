import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, or, sql } from "drizzle-orm";
import { agents, issues, environmentLeases, environments, executionWorkspaces, heartbeatRuns, type Db } from "@paperclipai/db";
import { FACTORY_COMPANY_ID, FACTORY_WORKER_POLICY } from "@paperclipai/adapter-utils/factory-worker-lease";

import { NativeRunnerOwnershipUnverifiedError, isNativeRunnerOwnershipHeld } from "./native-runtime/native-runner-ownership.js";

import { legacyControllerBootId } from "./legacy-controller-lease.js";

const SCHEMA = "paperclip.factory-workspace-staging.v1";
const MARKER = "factoryWorkspaceStaging";
type Row = typeof environmentLeases.$inferSelect;
type Binding = { companyId: string; runId: string; leaseId: string };
type Owner = Binding & { scope: string; ownerId: string; connectionKey: string; preparationPending: boolean; prepared: boolean };
// Process-local authority is deliberately not recoverable from API/model/DB metadata.
// Losing this controller leaves the durable record held until explicit reconciliation.
const owners = new WeakMap<Db, Map<string, Owner>>();

export type FactoryWorkspaceStagingHolder = {
  runId: string; agentId: string; issueId: string | null; issueIdentifier: string | null;
  projectWorkspaceId: string | null;
};
export class FactoryWorkspaceStagingBusyError extends Error {
  constructor(readonly holder: FactoryWorkspaceStagingHolder) {
    super("factory_workspace_staging_busy"); this.name = "FactoryWorkspaceStagingBusyError";
  }
}
function denied(): never { throw new NativeRunnerOwnershipUnverifiedError("factory_workspace_staging_unverified"); }

export type FactoryWorkspaceStagingConfig = {
  factoryWorkerPolicy?: string;
  remoteWorkspacePath: string;
  host: string; port: number; username: string;
  knownHosts: string | null; strictHostKeyChecking: boolean;
};

function scopeFor(companyId: string, workspaceId: string, config: FactoryWorkspaceStagingConfig) {
  const expected = `/workspace/${companyId}/${workspaceId}`;
  if (!config || companyId !== FACTORY_COMPANY_ID || config.factoryWorkerPolicy !== FACTORY_WORKER_POLICY ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(workspaceId) ||
      config.remoteWorkspacePath !== expected || !config.strictHostKeyChecking || !config.knownHosts) denied();
  const pins = config.knownHosts.trim().split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith("#"));
  // One pinned worker host key gives one identity across hostname/port/environment aliases.
  // Multiple keys or CA/wildcard trust are not a qualified worker identity for this gate.
  if (pins.length !== 1) denied();
  const fields = pins[0]!.trim().split(/\s+/);
  const [hostPattern, algorithm, key] = fields;
  if (!hostPattern || /[@*?!]/.test(hostPattern) || !algorithm || !/^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa)$/.test(algorithm) ||
      !key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key) || Buffer.from(key, "base64").length < 16 ||
      Buffer.from(key, "base64").toString("base64") !== key) denied();
  return createHash("sha256").update(JSON.stringify([SCHEMA, companyId, algorithm, key, expected])).digest("hex");
}
function connectionFor(config: FactoryWorkspaceStagingConfig) {
  return createHash("sha256").update(JSON.stringify([config.host, config.port, config.username,
    config.remoteWorkspacePath, config.knownHosts?.trim(), config.strictHostKeyChecking])).digest("hex");
}
function advisoryKey(scope: string) { return BigInt.asIntN(64, BigInt(`0x${scope.slice(0, 16)}`)).toString(); }

/** Commit exclusive durable ownership before the first remote mkdir, upload or provision command.
 * Preparation failures keep ownership: a rejected SSH request does not prove its remote child died.
 * The callback is trusted host code, never an API/model-supplied command or metadata proof.
 */
export async function acquireFactoryWorkspaceStagingLease(input: {
  db: Db; companyId: string; environmentId: string; executionWorkspaceId: string;
  issueId: string | null; runId: string; agentId: string;
  executionWorkspaceMode: string | null; config: FactoryWorkspaceStagingConfig;
  prepareWorkspace: () => Promise<{ remoteCwd: string }>;
}): Promise<Row> {
  const scope = scopeFor(input.companyId, input.executionWorkspaceId, input.config);
  const connectionKey = connectionFor(input.config);
  const existingOwner = [...(owners.get(input.db)?.values() ?? [])].find(owner =>
    owner.companyId === input.companyId && owner.runId === input.runId);
  if (existingOwner && ((!existingOwner.prepared && !existingOwner.preparationPending) ||
      existingOwner.scope !== scope || existingOwner.connectionKey !== connectionKey)) denied();
  const ownerId = randomUUID();
  const row = await input.db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${advisoryKey(scope)}::bigint)`);
    const [environment] = await tx.select().from(environments).where(eq(environments.id, input.environmentId)).for("update");
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.id, input.executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId)));
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).for("update");
    const [requestedAgent] = await tx.select({ id: agents.id, adapterType: agents.adapterType }).from(agents).where(and(
      eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    const [requestedIssue] = input.issueId ? await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))) : [];
    // Fresh runs retain their legacy controller lease until the native envelope is
    // admitted later in heartbeat. Only an unresolved Paperclip runner intent can
    // stage early, bound to the issue/workspace already persisted in its context.
    const freshIntent = run?.runtimeMode === "legacy" && run.runtimeModeResolvedAt === null;
    const [livePreparingController] = freshIntent ? await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
      gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
    )) : [];
    const issueBound = Boolean(input.issueId) && (freshIntent
      ? run?.nativeIssueId === null && run?.contextSnapshot?.issueId === input.issueId
      : run?.runtimeMode === "native" && run.nativeIssueId === input.issueId);
    if (!requestedAgent || requestedAgent.adapterType !== "paperclip_runner" || !requestedIssue ||
        (freshIntent && !livePreparingController) ||
        !environment || environment.driver !== "ssh" || environment.status !== "active" ||
        !workspace || workspace.status !== "active" || !run || run.status !== "running" || isNativeRunnerOwnershipHeld(run) || !issueBound ||
        run.agentId !== input.agentId ||
        run.contextSnapshot?.executionWorkspaceId !== input.executionWorkspaceId ||
        scopeFor(input.companyId, input.executionWorkspaceId, environment.config as FactoryWorkspaceStagingConfig) !== scope ||
        connectionFor(environment.config as FactoryWorkspaceStagingConfig) !== connectionKey) denied();
    const occupied = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.companyId),
      or(
        // Ignore generic lease status/expiry/run terminality. Only our verified release clears this owner.
        sql`${environmentLeases.metadata}->${MARKER}->>'scope' = ${scope} and coalesce(${environmentLeases.metadata}->${MARKER}->>'state', 'held') <> 'released'`,
        // Existing pre-gate leases must not silently overlap the first qualified owner.
        sql`${environmentLeases.provider} = 'ssh' and ${environmentLeases.metadata}->>'remoteWorkspacePath' = ${input.config.remoteWorkspacePath}
          and ${environmentLeases.status} in ('active', 'pending_cleanup', 'retained') and not (${environmentLeases.metadata} ? ${MARKER})`,
      ),
    )).limit(2);
    const busyFor = async (lease: Row): Promise<never> => {
      if (!lease.heartbeatRunId || lease.executionWorkspaceId !== input.executionWorkspaceId || lease.companyId !== input.companyId) denied();
      const [holderRun] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, lease.heartbeatRunId), eq(heartbeatRuns.companyId, input.companyId)));
      if (!holderRun || holderRun.status !== "running" || isNativeRunnerOwnershipHeld(holderRun)) denied();
      if (holderRun.executionControlDeadlineAt) {
        const [liveExecution] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, holderRun.id), gt(heartbeatRuns.executionControlDeadlineAt, sql`clock_timestamp()`)));
        if (!liveExecution) denied();
      }
      if (holderRun.runtimeMode === "legacy") {
        if (!holderRun.controllerBootId) denied();
        const [liveController] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, holderRun.id), gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`)));
        if (!liveController) denied();
      }
      const [holderAgent] = await tx.select({ id: agents.id, adapterType: agents.adapterType }).from(agents).where(and(
        eq(agents.id, holderRun.agentId), eq(agents.companyId, input.companyId)));
      const holderIssue = lease.issueId ? (await tx.select({ id: issues.id, identifier: issues.identifier }).from(issues).where(and(
        eq(issues.id, lease.issueId), eq(issues.companyId, input.companyId))))[0] : null;
      const holderFreshIntent = holderRun.runtimeMode === "legacy" && holderRun.runtimeModeResolvedAt === null &&
        holderRun.nativeIssueId === null && holderAgent?.adapterType === "paperclip_runner";
      const holderIssueBound = holderFreshIntent
        ? holderRun.contextSnapshot?.issueId === lease.issueId
        : holderRun.nativeIssueId === lease.issueId;
      if (!holderAgent || !holderIssueBound || holderRun.contextSnapshot?.executionWorkspaceId !== lease.executionWorkspaceId ||
          (lease.issueId && !holderIssue)) denied();
      throw new FactoryWorkspaceStagingBusyError({ runId: holderRun.id, agentId: holderAgent.id,
        issueId: lease.issueId, issueIdentifier: holderIssue?.identifier ?? null,
        projectWorkspaceId: workspace.projectWorkspaceId });
    };
    if (existingOwner) {
      const [owned] = await tx.select().from(environmentLeases).where(and(
        eq(environmentLeases.id, existingOwner.leaseId), eq(environmentLeases.companyId, input.companyId),
        eq(environmentLeases.heartbeatRunId, input.runId), eq(environmentLeases.environmentId, input.environmentId),
        eq(environmentLeases.executionWorkspaceId, input.executionWorkspaceId), eq(environmentLeases.status, "active"),
        sql`${environmentLeases.releasedAt} is null`, eq(environmentLeases.provider, "ssh"),
        sql`${environmentLeases.metadata}->${MARKER}->>'scope' = ${scope}`,
        sql`${environmentLeases.metadata}->${MARKER}->>'ownerId' = ${existingOwner.ownerId}`,
        sql`${environmentLeases.metadata}->${MARKER}->>'connectionKey' = ${connectionKey}`,
        sql`${environmentLeases.metadata}->${MARKER}->>'state' = 'held'`,
      ));
      if (!owned || (owned.expiresAt && owned.expiresAt.getTime() <= Date.now()) ||
          occupied.length !== 1 || occupied[0]?.id !== owned.id) denied();
      if (existingOwner.preparationPending) return busyFor(owned);
      return owned;
    }
    if (occupied.length) {
      if (occupied.length !== 1) denied();
      return busyFor(occupied[0]!);
    }
    const [lease] = await tx.insert(environmentLeases).values({
      companyId: input.companyId, environmentId: input.environmentId,
      executionWorkspaceId: input.executionWorkspaceId, issueId: input.issueId, heartbeatRunId: input.runId,
      status: "active", leasePolicy: "ephemeral", provider: "ssh",
      providerLeaseId: `ssh://${input.config.username}@${input.config.host}:${input.config.port}${input.config.remoteWorkspacePath}`,
      metadata: { agentId: input.agentId, driver: "ssh", executionWorkspaceMode: input.executionWorkspaceMode,
        host: input.config.host, port: input.config.port, username: input.config.username,
        remoteWorkspacePath: input.config.remoteWorkspacePath, remoteCwd: input.config.remoteWorkspacePath,
        [MARKER]: { schema: SCHEMA, scope, ownerId, connectionKey, state: "held", acquiredAt: new Date().toISOString() } },
    }).returning();
    if (!lease) denied();
    return lease;
  });
  // A same-controller retry reuses the exact active lease without another mkdir/upload.
  // Native-executor staging must separately assert this held owner on every pass.
  if (existingOwner) return row;
  const controller = owners.get(input.db) ?? new Map<string, Owner>();
  owners.set(input.db, controller);
  const owner: Owner = { companyId: input.companyId, runId: input.runId, leaseId: row.id, scope, ownerId, connectionKey, preparationPending: true, prepared: false };
  controller.set(row.id, owner);
  try {
    const prepared = await input.prepareWorkspace();
    if (prepared.remoteCwd !== input.config.remoteWorkspacePath) denied();
    owner.prepared = true;
  } catch {
    // Never persist raw SSH stderr, a provider result, or an exception containing credentials.
    denied();
  } finally { owner.preparationPending = false; }
  return row;
}

/** Revalidate the same controller's held staging capability before resumed uploads.
 * A worker-busy retry may reuse its environment lease without rerunning driver acquisition.
 * Keep that staging owner held across capacity deferral; a restarted controller cannot adopt it.
 */
export async function assertFactoryWorkspaceStagingOwned(input: Binding & { db: Db }): Promise<void> {
  const owner = owners.get(input.db)?.get(input.leaseId);
  if (!owner || owner.companyId !== input.companyId || owner.runId !== input.runId || owner.preparationPending || !owner.prepared) denied();
  const [row] = await input.db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.id, owner.leaseId), eq(environmentLeases.companyId, owner.companyId),
    eq(environmentLeases.heartbeatRunId, owner.runId),
    sql`${environmentLeases.metadata}->${MARKER}->>'scope' = ${owner.scope}`,
    sql`${environmentLeases.metadata}->${MARKER}->>'ownerId' = ${owner.ownerId}`,
    sql`${environmentLeases.metadata}->${MARKER}->>'connectionKey' = ${owner.connectionKey}`,
    sql`${environmentLeases.metadata}->${MARKER}->>'state' = 'held'`,
  ));
  if (!row) denied();
}

/** Internal native-executor hook. Call only with the owned foreground checkpoint,
 * or a trusted non-dispatch cleanup that has awaited every staging SSH/SFTP child.
 * Generic lease release, run terminal status, cancellation, age, receipt-shaped JSON
 * and a new controller's successful connection do not supply this authority.
 */
export async function settleFactoryWorkspaceStaging(input: Binding & {
  db: Db; verifyQuiescence: () => Promise<void>;
}): Promise<void> {
  const controller = owners.get(input.db), owner = controller?.get(input.leaseId);
  if (!owner || owner.companyId !== input.companyId || owner.runId !== input.runId || owner.preparationPending) denied();
  try { await input.verifyQuiescence(); }
  catch { denied(); }
  await input.db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${advisoryKey(owner.scope)}::bigint)`);
    const [row] = await tx.update(environmentLeases).set({
      metadata: sql`jsonb_set(${environmentLeases.metadata}, array[${MARKER}],
        (${environmentLeases.metadata}->${MARKER}) || ${JSON.stringify({ state: "released", releasedAt: new Date().toISOString() })}::jsonb)`,
      updatedAt: new Date(),
    }).where(and(eq(environmentLeases.id, owner.leaseId), eq(environmentLeases.companyId, owner.companyId),
      eq(environmentLeases.heartbeatRunId, owner.runId),
      sql`${environmentLeases.metadata}->${MARKER}->>'scope' = ${owner.scope}`,
      sql`${environmentLeases.metadata}->${MARKER}->>'ownerId' = ${owner.ownerId}`,
    sql`${environmentLeases.metadata}->${MARKER}->>'connectionKey' = ${owner.connectionKey}`,
      sql`${environmentLeases.metadata}->${MARKER}->>'state' = 'held'`,
    )).returning({ id: environmentLeases.id });
    if (!row) denied();
  });
  controller!.delete(owner.leaseId);
}
