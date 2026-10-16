import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { FACTORY_COMPANY_ID, FACTORY_WORKER_POLICY } from "@paperclipai/adapter-utils/factory-worker-lease";
import { FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE, NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
  isNativeRunnerOwnershipHeld, nativeRunnerOwnershipNotHeldCondition } from "./native-runtime/native-runner-ownership.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { acquireFactoryWorkspaceStagingLease, assertFactoryWorkspaceStagingOwned, settleFactoryWorkspaceStaging, type FactoryWorkspaceStagingConfig } from "./factory-workspace-staging.js";

describe("Factory durable ownership before workspace preparation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let first: ReturnType<typeof createDb>, second: ReturnType<typeof createDb>;
  const companyId = FACTORY_COMPANY_ID, agentId = randomUUID(), projectId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("factory-workspace-staging-");
    first = createDb(temporary.connectionString); second = createDb(temporary.connectionString);
    await first.insert(companies).values({ id: companyId, name: "Isolated staging proof", issuePrefix: "FWS" });
    await first.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner", status: "active" });
    await first.insert(projects).values({ id: projectId, companyId, name: "Fixture" });
  }, 120_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture(db = first, workspaceId = randomUUID(), alias = false) {
    const environmentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const cwd = `/workspace/${companyId}/${workspaceId}`;
    await db.insert(issues).values({ id: issueId, companyId, title: "No provider call", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, mode: "shared", strategyType: "shared", name: "Fixture", cwd }).onConflictDoNothing();
    const config: FactoryWorkspaceStagingConfig = { factoryWorkerPolicy: FACTORY_WORKER_POLICY,
      host: alias ? "alias.invalid" : "fixture.invalid", port: alias ? 2223 : 2222, username: "node",
      remoteWorkspacePath: cwd, knownHosts: `${alias ? "alias.invalid" : "fixture.invalid"} ssh-ed25519 ${Buffer.alloc(32, 7).toString("base64")}`,
      strictHostKeyChecking: true };
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "ssh", config });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "running", invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { executionWorkspaceId: workspaceId, issueId } });
    return { db, companyId, agentId, environmentId, executionWorkspaceId: workspaceId, runId, issueId,
      executionWorkspaceMode: "shared", config, prepareWorkspace: async () => ({ remoteCwd: cwd }) };
  }

  it("fresh unresolved Paperclip intent stages before native admission without rewriting runtime mode", async () => {
    const a = await fixture();
    await first.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: null, nativeIssueId: null,
      controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, a.runId));
    await expect(acquireFactoryWorkspaceStagingLease(a)).resolves.toMatchObject({ heartbeatRunId: a.runId });
    const [row] = await first.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    expect(row).toMatchObject({ runtimeMode: "legacy", runtimeModeResolvedAt: null, nativeIssueId: null });
    await expect(acquireFactoryWorkspaceStagingLease({ ...a, db: second })).rejects.toThrow("factory_workspace_staging_busy");
  });

  it("resolved legacy, wrong pre-admission issue, non-Paperclip agent and admitted native mismatch cannot stage", async () => {
    const a = await fixture(); let prepared = 0;
    const input = { ...a, prepareWorkspace: async () => { prepared++; return { remoteCwd: a.config.remoteWorkspacePath }; } };
    await first.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), nativeIssueId: null }).where(eq(heartbeatRuns.id, a.runId));
    await expect(acquireFactoryWorkspaceStagingLease(input)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await first.update(heartbeatRuns).set({ runtimeModeResolvedAt: null, contextSnapshot: { executionWorkspaceId: a.executionWorkspaceId, issueId: randomUUID() } }).where(eq(heartbeatRuns.id, a.runId));
    await expect(acquireFactoryWorkspaceStagingLease(input)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await first.update(heartbeatRuns).set({ contextSnapshot: { executionWorkspaceId: a.executionWorkspaceId, issueId: a.issueId } }).where(eq(heartbeatRuns.id, a.runId));
    await first.update(heartbeatRuns).set({ controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, a.runId));
    await expect(acquireFactoryWorkspaceStagingLease(input)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await first.update(heartbeatRuns).set({ controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, a.runId));
    await expect(acquireFactoryWorkspaceStagingLease(input)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await first.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, a.runId));
    await first.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, agentId));
    try { await expect(acquireFactoryWorkspaceStagingLease(input)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE); }
    finally { await first.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, agentId)); }
    await first.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: null }).where(eq(heartbeatRuns.id, a.runId));
    await expect(acquireFactoryWorkspaceStagingLease(input)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    expect(prepared).toBe(0);
  });

  it("database hold predicate agrees with memory for pre-admission Factory and ordinary native states", async () => {
    const a = await fixture();
    const cases = [
      { runtimeMode: "legacy", status: "running", nativePhase: "terminal_failure", errorCode: FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE },
      { runtimeMode: "native", status: "running", nativePhase: "terminal_failure", errorCode: FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE },
      { runtimeMode: "legacy", status: "running", nativePhase: "observed", errorCode: FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE },
      { runtimeMode: "legacy", status: "failed", nativePhase: "terminal_failure", errorCode: FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE },
      { runtimeMode: "legacy", status: "running", nativePhase: "terminal_failure", errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE },
      { runtimeMode: "native", status: "running", nativePhase: "terminal_failure", errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE },
      { runtimeMode: "native", status: "running", nativePhase: null, errorCode: "native_adopted_runner_authentication_timeout" },
      { runtimeMode: "legacy", status: "running", nativePhase: null, errorCode: null },
    ];
    for (const state of cases) {
      await first.update(heartbeatRuns).set(state).where(eq(heartbeatRuns.id, a.runId));
      const eligible = await first.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, a.runId), nativeRunnerOwnershipNotHeldCondition()));
      expect(eligible.length === 0).toBe(isNativeRunnerOwnershipHeld(state));
    }
  });

  it("competing database connections and environment/host aliases admit exactly one preparer", async () => {
    const a = await fixture(), b = await fixture(second, a.executionWorkspaceId, true);
    let preparations = 0;
    const prepare = async () => { preparations++; return { remoteCwd: a.config.remoteWorkspacePath }; };
    const results = await Promise.allSettled([
      acquireFactoryWorkspaceStagingLease({ ...a, prepareWorkspace: prepare }),
      acquireFactoryWorkspaceStagingLease({ ...b, prepareWorkspace: prepare }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.message).toBe("factory_workspace_staging_busy");
    expect(failed.reason.holder).toMatchObject({ agentId, projectWorkspaceId: null });
    expect([a.runId, b.runId]).toContain(failed.reason.holder.runId);
    expect([a.issueId, b.issueId]).toContain(failed.reason.holder.issueId);
    expect(preparations).toBe(1);
  });

  it("cancellation cannot settle ownership while the controller preparer remains in flight", async () => {
    const a = await fixture();
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const acquiring = acquireFactoryWorkspaceStagingLease({ ...a, prepareWorkspace: async () => {
      enter(); await finished; return { remoteCwd: a.config.remoteWorkspacePath };
    } });
    await entered;
    try {
      await expect(acquireFactoryWorkspaceStagingLease(a)).rejects.toThrow("factory_workspace_staging_busy");
      const [row] = await first.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, a.runId));
      expect(row.metadata?.factoryWorkspaceStaging).toMatchObject({ state: "held" });
      await first.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, a.runId));
      let checked = false;
      await expect(settleFactoryWorkspaceStaging({ db: first, companyId, runId: a.runId, leaseId: row.id,
        verifyQuiescence: async () => { checked = true; } })).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
      expect(checked).toBe(false);
      const b = await fixture(second, a.executionWorkspaceId);
      await expect(acquireFactoryWorkspaceStagingLease(b)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    } finally { finish(); await acquiring; }
  });

  it("same-controller same-run retry reuses only its exact active enrollment without preparing twice", async () => {
    const a = await fixture(); let preparations = 0;
    const input = { ...a, prepareWorkspace: async () => { preparations++; return { remoteCwd: a.config.remoteWorkspacePath }; } };
    const original = await acquireFactoryWorkspaceStagingLease(input);
    const resumed = await acquireFactoryWorkspaceStagingLease(input);
    expect(resumed.id).toBe(original.id); expect(preparations).toBe(1);
    await expect(acquireFactoryWorkspaceStagingLease({ ...input, db: second })).rejects.toThrow("factory_workspace_staging_busy");
    await expect(acquireFactoryWorkspaceStagingLease({ ...input, config: { ...input.config, host: "changed.invalid" } }))
      .rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await first.update(environments).set({ config: { ...a.config, host: "retargeted.invalid" } }).where(eq(environments.id, a.environmentId));
    await expect(acquireFactoryWorkspaceStagingLease(input)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await first.update(environments).set({ config: a.config }).where(eq(environments.id, a.environmentId));
    await first.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.id, original.id));
    await expect(acquireFactoryWorkspaceStagingLease(input)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    expect(preparations).toBe(1);
  });

  it("different fixed workspaces on one worker stage independently", async () => {
    const a = await fixture(), b = await fixture(second);
    await expect(Promise.all([acquireFactoryWorkspaceStagingLease(a), acquireFactoryWorkspaceStagingLease(b)])).resolves.toHaveLength(2);
  });

  it("failed preparation retains a durable owner without recording raw errors", async () => {
    const a = await fixture();
    await expect(acquireFactoryWorkspaceStagingLease({ ...a, prepareWorkspace: async () => { throw new Error("synthetic-sensitive-stderr"); } }))
      .rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    const [row] = await first.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, a.runId));
    expect(row.metadata?.factoryWorkspaceStaging).toMatchObject({ state: "held" });
    expect(JSON.stringify(row)).not.toContain("synthetic-sensitive-stderr");
    const b = await fixture(second, a.executionWorkspaceId);
    await expect(acquireFactoryWorkspaceStagingLease(b)).rejects.toThrow("factory_workspace_staging_busy");
  });

  it("held or expired controllers escalate ownership instead of advertising live capacity", async () => {
    const a = await fixture(); await acquireFactoryWorkspaceStagingLease(a);
    const b = await fixture(second, a.executionWorkspaceId);
    await first.update(heartbeatRuns).set({ errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE, nativePhase: "terminal_failure" }).where(eq(heartbeatRuns.id, a.runId));
    await expect(acquireFactoryWorkspaceStagingLease(b)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await first.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, runtimeModeResolvedAt: null,
      errorCode: FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE }).where(eq(heartbeatRuns.id, a.runId));
    await expect(acquireFactoryWorkspaceStagingLease(b)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await first.update(heartbeatRuns).set({ errorCode: null, nativePhase: null, controllerBootId: null, controllerLeaseExpiresAt: null }).where(eq(heartbeatRuns.id, a.runId));
    await expect(acquireFactoryWorkspaceStagingLease(b)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await first.update(heartbeatRuns).set({ controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, a.runId));
    await expect(acquireFactoryWorkspaceStagingLease(b)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await first.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: a.issueId,
      executionControlDeadlineAt: new Date(0) }).where(eq(heartbeatRuns.id, a.runId));
    await expect(acquireFactoryWorkspaceStagingLease(b)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    const [lease] = await first.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, a.runId));
    expect(lease.metadata?.factoryWorkspaceStaging).toMatchObject({ state: "held" });
  });

  it("terminal run, generic lease release, expiry and a new controller do not clear ownership", async () => {
    const a = await fixture(), row = await acquireFactoryWorkspaceStagingLease(a);
    await first.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, a.runId));
    await first.update(environmentLeases).set({ status: "released", releasedAt: new Date(), expiresAt: new Date(0) }).where(eq(environmentLeases.id, row.id));
    let checks = 0;
    await expect(settleFactoryWorkspaceStaging({ db: second, companyId, runId: a.runId, leaseId: row.id,
      verifyQuiescence: async () => { checks++; } })).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    expect(checks).toBe(0);
    const b = await fixture(second, a.executionWorkspaceId);
    await expect(acquireFactoryWorkspaceStagingLease(b)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
  });

  it("failed quiescence does not release; verified quiescence admits the next owner and fences stale completion", async () => {
    const a = await fixture(), row = await acquireFactoryWorkspaceStagingLease(a);
    const binding = { db: first, companyId, runId: a.runId, leaseId: row.id };
    await expect(assertFactoryWorkspaceStagingOwned(binding)).resolves.toBeUndefined();
    await expect(assertFactoryWorkspaceStagingOwned({ ...binding, db: second })).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await expect(settleFactoryWorkspaceStaging({ ...binding, verifyQuiescence: async () => { throw new Error("synthetic-sensitive-cleanup"); } }))
      .rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    const b = await fixture(second, a.executionWorkspaceId);
    await expect(acquireFactoryWorkspaceStagingLease(b)).rejects.toThrow("factory_workspace_staging_busy");
    await settleFactoryWorkspaceStaging({ ...binding, verifyQuiescence: async () => {} });
    const next = await acquireFactoryWorkspaceStagingLease(b);
    await expect(assertFactoryWorkspaceStagingOwned(binding)).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await expect(settleFactoryWorkspaceStaging({ ...binding, verifyQuiescence: async () => {} }))
      .rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    const [held] = await second.select().from(environmentLeases).where(eq(environmentLeases.id, next.id));
    expect(held.metadata?.factoryWorkspaceStaging).toMatchObject({ state: "held" });
  });

  it("foreign run/workspace or invalid pin fails before any remote preparation", async () => {
    const a = await fixture(); let prepared = 0;
    const prepareWorkspace = async () => { prepared++; return { remoteCwd: a.config.remoteWorkspacePath }; };
    await expect(acquireFactoryWorkspaceStagingLease({ ...a, agentId: randomUUID(), prepareWorkspace })).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await expect(acquireFactoryWorkspaceStagingLease({ ...a, config: { ...a.config, knownHosts: "not-a-pin" }, prepareWorkspace })).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    await expect(acquireFactoryWorkspaceStagingLease({ ...a, config: { ...a.config, remoteWorkspacePath: "/workspace/other" }, prepareWorkspace })).rejects.toThrow(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    expect(prepared).toBe(0);
  });
});
