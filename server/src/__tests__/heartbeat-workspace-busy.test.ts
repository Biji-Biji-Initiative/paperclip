import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  companySkills,
  completionContracts,
  createDb,
  environments,
  documents,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issues,
  nativeRunFinalizations,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
  type AdapterExecutionContext,
} from "../adapters/index.ts";
import {
  WORKSPACE_BUSY_ERROR_CODE,
  WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
  WORKSPACE_BUSY_RETRY_BASE_DELAY_MS,
  WORKSPACE_BUSY_RETRY_JITTER_MS,
  WORKSPACE_BUSY_RETRY_REASON,
  WORKSPACE_BUSY_RETRY_WAKE_REASON,
  computeWorkspaceBusyRetryDelayMs,
  heartbeatService,
} from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { FactoryWorkspaceStagingBusyError } from "../services/factory-workspace-staging.js";
import {
  FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE,
  isNativeRunnerOwnershipHeld,
  NativeRunnerOwnershipUnverifiedError,
} from "../services/native-runtime/native-runner-ownership.js";
import { parseNativeExecutionInput, type NativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { FACTORY_COMPANY_ID, FACTORY_WORKER_POLICY } from "@paperclipai/adapter-utils/factory-worker-lease";
import { buildEnvironmentLeaseContext } from "../services/environment-runtime.js";

type AcquireLease = ReturnType<typeof import("../services/environment-runtime.js").environmentRuntimeService>["acquireRunLease"];
type NativeExecute = typeof import("../services/native-runtime/native-session-executor.js").executePaperclipNativeSession;

const stagingAcquireFault = vi.hoisted(() => ({
  beforeAcquire: undefined as ((input: { heartbeatRunId: string | null }) => Promise<void>) | undefined,
  acquireOverride: undefined as AcquireLease | undefined,
  executeOverride: undefined as NativeExecute | undefined,
}));
vi.mock("../services/environment-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/environment-runtime.js")>();
  return { ...actual, environmentRuntimeService: (...args: Parameters<typeof actual.environmentRuntimeService>) => {
    const runtime = actual.environmentRuntimeService(...args);
    return { ...runtime, acquireRunLease: async (input: Parameters<typeof runtime.acquireRunLease>[0]) => {
      await stagingAcquireFault.beforeAcquire?.(input);
      if (stagingAcquireFault.acquireOverride) return stagingAcquireFault.acquireOverride(input);
      return runtime.acquireRunLease(input);
    } };
  } };
});
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return { ...actual, executePaperclipNativeSession: ((input) =>
    stagingAcquireFault.executeOverride ? stagingAcquireFault.executeOverride(input) : actual.executePaperclipNativeSession(input)) satisfies NativeExecute };
});

// Exercise the real SSH lease and heartbeat paths without connecting to a host.
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>(),
  ensureSshWorkspaceReady: async (config: { remoteWorkspacePath: string }) => ({
    remoteCwd: config.remoteWorkspacePath,
  }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const WORKSPACE_BUSY_TEST_ADAPTER = "workspace_busy_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace-busy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("computeWorkspaceBusyRetryDelayMs", () => {
  it("stays within the base-delay-to-base-plus-jitter window", () => {
    expect(computeWorkspaceBusyRetryDelayMs(() => 0)).toBe(WORKSPACE_BUSY_RETRY_BASE_DELAY_MS);
    expect(computeWorkspaceBusyRetryDelayMs(() => 0.5)).toBe(
      WORKSPACE_BUSY_RETRY_BASE_DELAY_MS + WORKSPACE_BUSY_RETRY_JITTER_MS / 2,
    );
    expect(computeWorkspaceBusyRetryDelayMs(() => 1)).toBe(
      WORKSPACE_BUSY_RETRY_BASE_DELAY_MS + WORKSPACE_BUSY_RETRY_JITTER_MS,
    );
  });

  it("clamps out-of-range random sources instead of leaving the window", () => {
    expect(computeWorkspaceBusyRetryDelayMs(() => -5)).toBe(WORKSPACE_BUSY_RETRY_BASE_DELAY_MS);
    expect(computeWorkspaceBusyRetryDelayMs(() => 7)).toBe(
      WORKSPACE_BUSY_RETRY_BASE_DELAY_MS + WORKSPACE_BUSY_RETRY_JITTER_MS,
    );
  });
});

describeEmbeddedPostgres("shared-workspace run serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let workspaceCwd!: string;
  const executedRunIds: string[] = [];
  const executedInputs = new Map<string, AdapterExecutionContext>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-workspace-busy-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    workspaceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-busy-"));
    registerServerAdapter({
      type: WORKSPACE_BUSY_TEST_ADAPTER,
      execute: async (input) => {
        executedRunIds.push(input.runId);
        executedInputs.set(input.runId, input);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          resultJson: {},
        };
      },
      testEnvironment: async () => ({
        adapterType: WORKSPACE_BUSY_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 120_000);

  afterEach(async () => {
    // Seeded holder runs are synthetic "running" rows with no real execution
    // behind them; cancel them first so the drain helper does not spin
    // waiting for them to finish.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "running"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupFixture();
    stagingAcquireFault.beforeAcquire = undefined;
    stagingAcquireFault.acquireOverride = undefined;
    stagingAcquireFault.executeOverride = undefined;
    executedRunIds.length = 0;
    executedInputs.clear();
    await instanceSettingsService(db).updateGeneral({ executionMode: "any" });
  });

  afterAll(async () => {
    unregisterServerAdapter(WORKSPACE_BUSY_TEST_ADAPTER);
    if (workspaceCwd) await fs.rm(workspaceCwd, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function cleanupFixture() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await cleanupFixtureOnce();
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function cleanupFixtureOnce() {
    await db.delete(agentTaskSessions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(nativeRunFinalizations);
    await db.update(heartbeatRuns).set({ completionContractId: null });
    await db.delete(completionContracts);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  async function waitForRunToLeaveActiveStates(runId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  // A deferral does two writes in order: first it cancels the original run,
  // then it inserts the scheduled-retry row. waitForRunToLeaveActiveStates
  // returns after the first write, so a read of the retry row can land before
  // the second write and find nothing. Poll until the retry row exists so the
  // retry-row assertions never observe the gap between the two writes.
  async function waitForRetryRun(originalRunId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const retryRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, originalRunId))
        .then((rows) => rows[0] ?? null);
      if (retryRun) return retryRun;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, originalRunId))
      .then((rows) => rows[0] ?? null);
  }

  interface WorkspaceFixture {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    holderAgentId: string;
    holderIssueId: string;
    holderRunId: string;
    agentId: string;
    issueId: string;
    nonAssigneeAgentId: string;
  }

  async function seedWorkspaceFixture(input?: {
    companyId?: string;
    holderIssueWorkspaceSettings?: Record<string, unknown> | null;
    holderProjectWorkspaceId?: string;
    holderActivityAt?: Date;
    issueWorkspaceSettings?: Record<string, unknown> | null;
    projectWorkspacePolicy?: Record<string, unknown>;
    agentEnvironmentDriver?: "local" | "ssh" | "sandbox";
  }): Promise<WorkspaceFixture> {
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const companyId = input?.companyId ?? randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const holderAgentId = randomUUID();
    const holderIssueId = randomUUID();
    const holderRunId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nonAssigneeAgentId = randomUUID();
    // Deferral/retry tests exercise sandbox protection. Local and SSH folders
    // must remain concurrent even when an older policy requests serialization.
    const agentEnvironmentDriver = input?.agentEnvironmentDriver ?? "sandbox";
    const agentEnvironmentId = agentEnvironmentDriver === "local" ? null : randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace Busy Project",
      executionWorkspacePolicy: input?.projectWorkspacePolicy ?? null,
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      sourceType: "local_path",
      cwd: workspaceCwd,
      isPrimary: true,
    });

    if (agentEnvironmentId) {
      await db.insert(environments).values({
        id: agentEnvironmentId,
        companyId,
        name: `Workspace busy ${agentEnvironmentDriver} ${agentEnvironmentId}`,
        driver: agentEnvironmentDriver,
        status: "active",
        config: agentEnvironmentDriver === "ssh"
          ? { host: "workspace-test.invalid", username: "test", remoteWorkspacePath: workspaceCwd }
          : { provider: "fake", image: "fake:test", reuseLease: false },
      });
    }

    const holderProjectWorkspaceId = input?.holderProjectWorkspaceId ?? projectWorkspaceId;
    if (holderProjectWorkspaceId !== projectWorkspaceId) {
      await db.insert(projectWorkspaces).values({
        id: holderProjectWorkspaceId,
        companyId,
        projectId,
        name: "Secondary workspace",
        sourceType: "local_path",
        cwd: workspaceCwd,
      });
    }

    for (const [id, name] of [
      [holderAgentId, "HolderCoder"],
      [agentId, "DeferredCoder"],
      [nonAssigneeAgentId, "CommenterCoder"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: id === holderAgentId ? "running" : "idle",
        adapterType: WORKSPACE_BUSY_TEST_ADAPTER,
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        ...(agentEnvironmentId ? { defaultEnvironmentId: agentEnvironmentId } : {}),
        permissions: {},
      });
    }

    const holderActivityAt = input?.holderActivityAt ?? now;
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId: holderAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: holderActivityAt,
      lastOutputAt: holderActivityAt,
      contextSnapshot: {
        issueId: holderIssueId,
        wakeReason: "issue_assigned",
      },
      createdAt: holderActivityAt,
      updatedAt: holderActivityAt,
    });

    await db.insert(issues).values({
      id: holderIssueId,
      companyId,
      title: "Holder issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: holderAgentId,
      projectId,
      projectWorkspaceId: holderProjectWorkspaceId,
      executionRunId: holderRunId,
      executionAgentNameKey: "holdercoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      ...(input?.holderIssueWorkspaceSettings !== undefined
        ? { executionWorkspaceSettings: input.holderIssueWorkspaceSettings }
        : {}),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      projectId,
      projectWorkspaceId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      executionWorkspaceSettings:
        input?.issueWorkspaceSettings === undefined
          ? { sharedWorkspaceConcurrency: "serialize" }
          : input.issueWorkspaceSettings,
    });

    return {
      companyId,
      projectId,
      projectWorkspaceId,
      holderAgentId,
      holderIssueId,
      holderRunId,
      agentId,
      issueId,
      nonAssigneeAgentId,
    };
  }

  it.each(["fresh_foreign", "fresh_self", "admitted_foreign", "missing_admitted"] as const)(
    "Factory staging refusal preserves the correct heartbeat disposition: %s", async scenario => {
      const fixture = await seedWorkspaceFixture({ agentEnvironmentDriver: "ssh",
        issueWorkspaceSettings: { sharedWorkspaceConcurrency: "allow" } });
      await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
      const [agent] = await db.select().from(agents).where(eq(agents.id, fixture.agentId));
      const workspaceId = randomUUID(), remoteCwd = `/workspace/${fixture.companyId}/${workspaceId}`;
      await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: fixture.companyId,
        projectId: fixture.projectId, projectWorkspaceId: fixture.projectWorkspaceId, sourceIssueId: fixture.issueId,
        mode: "shared_workspace", strategyType: "project_primary", name: "Factory boundary fixture", cwd: workspaceCwd });
      await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, fixture.issueId));
      await db.update(environments).set({ config: { host: "fixture.invalid", port: 2222, username: "node",
        remoteWorkspacePath: remoteCwd, factoryWorkerPolicy: "factory-worker-scope-v2",
        privateKey: null, privateKeySecretRef: null, knownHosts: "fixture-public-pin", strictHostKeyChecking: true,
      } }).where(eq(environments.id, agent!.defaultEnvironmentId!));
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: {
        provider: "codex", model: "gpt-6.1-sol", codexPermissionMode: "never", lifecycleMode: "per_turn",
      } }).where(eq(agents.id, fixture.agentId));
      let refusedRunId: string | null = null;
      const refused = vi.fn(async (input: { heartbeatRunId: string | null }) => {
        refusedRunId = input.heartbeatRunId;
        throw new FactoryWorkspaceStagingBusyError({ runId: scenario === "fresh_self" ? input.heartbeatRunId! : fixture.holderRunId,
          agentId: scenario === "fresh_self" ? fixture.agentId : fixture.holderAgentId,
          issueId: null, issueIdentifier: null, projectWorkspaceId: null });
      });
      stagingAcquireFault.beforeAcquire = refused;
      let runId: string;
      const admitted = scenario === "admitted_foreign" || scenario === "missing_admitted";
      if (admitted) {
        runId = randomUUID();
        const execution: Extract<NativeExecutionInput, { schema: "paperclip.native-execution-input.v1" }> = {
          schema: "paperclip.native-execution-input.v1", binding: { companyId: fixture.companyId,
            agentId: fixture.agentId, issueId: fixture.issueId, runId, executionWorkspaceId: workspaceId },
          task: { identifier: fixture.issueId, title: "Admitted fixture", description: null, prompt: "No inference", workMode: "standard" },
          workspace: { cwd: workspaceCwd, repoUrl: null, repoRef: null, branchName: null },
          provider: { kind: "codex", model: "gpt-6.1-sol" },
          session: { normalizedSessionId: randomUUID(), driverKind: "codex_app_server", protocolVersion: 1,
            lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
          completionContract: { id: randomUUID(), sha256: "0".repeat(64), schemaVersion: "paperclip.completion-contract.v1",
            contract: { revision: "1", objective: "Boundary fixture", criteria: [{ id: "no-dispatch", requirement: "No provider dispatch" }] } },
          interactionResponses: [], credentialBindings: [],
        };
        expect(() => parseNativeExecutionInput(execution)).not.toThrow();
        await db.insert(heartbeatRuns).values({ id: runId, companyId: fixture.companyId, agentId: fixture.agentId,
          status: "queued", invocationSource: "assignment", triggerDetail: "system", runtimeMode: "native",
          runtimeModeResolvedAt: new Date(), nativeIssueId: fixture.issueId, nativeSessionId: execution.session.normalizedSessionId,
          contextSnapshot: { issueId: fixture.issueId, executionWorkspaceId: workspaceId, wakeReason: "issue_assigned" },
          runnerProfileJson: scenario === "missing_admitted" ? {} : { nativeExecutionInput: execution } });
        await db.insert(nativeRunFinalizations).values({ runId, companyId: fixture.companyId,
          issueId: fixture.issueId, phase: "observed", attempt: 1 });
        await heartbeat.resumeQueuedRuns();
      } else {
        const run = await heartbeat.invoke(fixture.agentId, "assignment", { issueId: fixture.issueId, wakeReason: "issue_assigned" }, "system");
        expect(run).not.toBeNull(); runId = run!.id;
      }
      if (scenario !== "missing_admitted") {
        await expect.poll(() => refusedRunId, { timeout: 20_000, interval: 50 }).toBe(runId);
      }
      if (scenario === "fresh_foreign") {
        const ended = await waitForRunToLeaveActiveStates(runId, 20_000);
        expect(ended).toMatchObject({ status: "cancelled", errorCode: WORKSPACE_BUSY_ERROR_CODE });
        const retry = await waitForRetryRun(runId);
        expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON });
        expect(ended?.resultJson?.workspaceBusy).toMatchObject({ holderRunId: fixture.holderRunId, holderIssueId: null, projectWorkspaceId: null });
      } else {
        await expect.poll(async () => (await heartbeat.getRun(runId))?.errorCode,
          { timeout: 20_000, interval: 50 }).toBe(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
        const heldRun = await heartbeat.getRun(runId);
        expect(heldRun).not.toBeNull();
        expect(isNativeRunnerOwnershipHeld(heldRun!)).toBe(true);
        if (scenario === "fresh_self") {
          expect(heldRun).toMatchObject({ runtimeMode: "legacy", runtimeModeResolvedAt: null });
        }
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
      }
      if (scenario === "missing_admitted") expect(refused).not.toHaveBeenCalled();
      else expect(refused).toHaveBeenCalledOnce();
      expect(executedRunIds).not.toContain(runId);
      const coordinator = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      if (admitted) expect(coordinator[0]?.attempt).toBe(1);
      else expect(coordinator).toHaveLength(0);
      await heartbeat.waitForRunExecutionDrain(runId, { timeoutMs: 20_000 });
    }, 60_000,
  );

  it("starts a new Factory human turn with fresh authority and the previous artifact handoff", async () => {
    const fixture = await seedWorkspaceFixture({ companyId: FACTORY_COMPANY_ID, agentEnvironmentDriver: "ssh",
      issueWorkspaceSettings: { sharedWorkspaceConcurrency: "allow" } });
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
    const [agent] = await db.select().from(agents).where(eq(agents.id, fixture.agentId));
    const workspaceId = randomUUID(), remoteCwd = `/workspace/${fixture.companyId}/${workspaceId}`;
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: fixture.companyId,
      projectId: fixture.projectId, projectWorkspaceId: fixture.projectWorkspaceId, sourceIssueId: fixture.issueId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Factory continuation fixture", cwd: workspaceCwd });
    await db.update(issues).set({ executionWorkspaceId: workspaceId, executionWorkspacePreference: "reuse_existing" })
      .where(eq(issues.id, fixture.issueId));
    await db.update(environments).set({ config: { host: "fixture.invalid", port: 2222, username: "node",
      remoteWorkspacePath: remoteCwd, factoryWorkerPolicy: FACTORY_WORKER_POLICY,
      privateKey: null, privateKeySecretRef: null, knownHosts: "fixture-public-pin", strictHostKeyChecking: true,
    } }).where(eq(environments.id, agent!.defaultEnvironmentId!));
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: {
      provider: "codex", model: "gpt-6.1-sol", codexPermissionMode: "never", lifecycleMode: "per_turn",
    } }).where(eq(agents.id, fixture.agentId));

    // Keep actual heartbeat selection, persistence, and history reads. Replace
    // only the external lease/provider boundaries: this test never uses SSH.
    const leaseIds: string[] = [];
    stagingAcquireFault.acquireOverride = async input => {
      const [lease] = await db.insert(environmentLeases).values({ companyId: input.companyId,
        environmentId: input.environment.id, executionWorkspaceId: input.persistedExecutionWorkspace!.id,
        issueId: input.issueId, heartbeatRunId: input.heartbeatRunId, provider: "ssh", status: "active",
        metadata: { remoteCwd, driver: "ssh" } }).returning();
      leaseIds.push(lease!.id);
      return { environment: input.environment, lease: lease!, leaseContext: buildEnvironmentLeaseContext(input) };
    };
    const dispatched: Parameters<NativeExecute>[0][] = [];
    let handoff: string | null | undefined;
    let handoffTiming: unknown;
    stagingAcquireFault.executeOverride = async input => {
      dispatched.push(input);
      if (dispatched.length === 1) {
        // The substituted native provider completes its proposal. A still-open
        // task would correctly schedule an autonomous continuation before the
        // next human message and would test a different admission boundary.
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.issueId));
        return { exitCode: 0, signal: null, timedOut: false, summary: "First proposal drafted" };
      }
      handoff = await input.getFreshSessionHandoff?.();
      handoffTiming = await db.execute(sql`select
        (select created_at::text from heartbeat_runs where id = ${input.execution.binding.runId}) as run_time,
        (select max(created_at)::text from issue_comments where issue_id = ${fixture.issueId}) as comment_time,
        (select max(updated_at)::text from documents where company_id = ${fixture.companyId}) as document_time`);
      throw new NativeRunnerOwnershipUnverifiedError("ssh_foreground_ownership_unverified");
    };
    const first = await heartbeat.invoke(fixture.agentId, "assignment", { issueId: fixture.issueId, wakeReason: "issue_assigned" }, "system");
    expect(first).not.toBeNull();
    expect((await waitForRunToLeaveActiveStates(first!.id, 30_000))?.status).toBe("succeeded");
    await heartbeat.waitForRunExecutionDrain(first!.id, { timeoutMs: 30_000 });
    expect(dispatched).toHaveLength(1);
    const oldSessionId = dispatched[0]!.execution.session.normalizedSessionId!;
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first!.id));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...finished!.runnerProfileJson,
      sessionCheckpoint: { semanticResult: { summary: "First proposal drafted; use the saved proposal document" } } },
    }).where(eq(heartbeatRuns.id, first!.id));
    await db.insert(agentTaskSessions).values({ companyId: fixture.companyId, agentId: fixture.agentId,
      adapterType: "paperclip_runner", taskKey: fixture.issueId, lastRunId: first!.id,
      sessionDisplayId: oldSessionId, sessionParamsJson: { sessionId: oldSessionId, cwd: workspaceCwd },
    }).onConflictDoUpdate({ target: [agentTaskSessions.companyId, agentTaskSessions.agentId, agentTaskSessions.adapterType, agentTaskSessions.taskKey],
      set: { lastRunId: first!.id, sessionDisplayId: oldSessionId, sessionParamsJson: { sessionId: oldSessionId, cwd: workspaceCwd } } });
    const documentId = randomUUID(), commentId = randomUUID();
    await db.insert(documents).values({ id: documentId, companyId: fixture.companyId, latestBody: "Saved proposal artifact: marketing launch plan" });
    await db.insert(issueDocuments).values({ companyId: fixture.companyId, issueId: fixture.issueId, documentId, key: "proposal" });
    await db.insert(issueComments).values({ id: commentId, companyId: fixture.companyId, issueId: fixture.issueId,
      authorType: "user", authorUserId: "responsible-user", body: "Revise the saved proposal for the LMS marketing team" });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, fixture.issueId));
    const second = await heartbeat.invoke(fixture.agentId, "on_demand", { issueId: fixture.issueId,
      wakeReason: "issue_commented", commentId }, "manual", { actorType: "user", actorId: "responsible-user" });
    expect(second, JSON.stringify(await db.select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, fixture.agentId)))).not.toBeNull();
    await expect.poll(() => dispatched.length, { timeout: 30_000, interval: 50 }).toBe(2);
    await heartbeat.waitForRunExecutionDrain(second!.id, { timeoutMs: 30_000 });
    const next = dispatched[1]!;
    expect(next.execution.binding).toMatchObject({ runId: second!.id, issueId: fixture.issueId, executionWorkspaceId: workspaceId });
    expect(next.execution.session).toMatchObject({ lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } });
    expect(next.execution.session.normalizedSessionId).not.toBe(oldSessionId);
    expect(next.runnerInstanceId).not.toBe(dispatched[0]!.runnerInstanceId);
    expect(next.runnerExecutionTarget).toMatchObject({ leaseId: leaseIds[1], factoryWorkerPolicy: FACTORY_WORKER_POLICY });
    expect(leaseIds[1]).not.toBe(leaseIds[0]);
    const persisted = await heartbeat.getRun(second!.id);
    expect(persisted?.contextSnapshot).toMatchObject({ forceFreshSession: true });
    expect(persisted?.runnerProfileJson).not.toHaveProperty("sessionCheckpoint");
    expect(handoff).toContain("First proposal drafted");
    expect(handoff, JSON.stringify(handoffTiming)).toContain("Saved proposal artifact");
    expect(handoff).toContain(documentId);
    expect(handoff).toContain("Revise the saved proposal");
    expect(await db.select().from(documents).where(eq(documents.id, documentId))).toHaveLength(1);
  }, 120_000);

  it("auto dispatches alongside a local holder and adds coordination context", async () => {
    const fixture = await seedWorkspaceFixture({
      issueWorkspaceSettings: { sharedWorkspaceConcurrency: "auto" },
      agentEnvironmentDriver: "local",
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("succeeded");
    expect(executedRunIds).toContain(run!.id);
    expect(executedInputs.get(run!.id)?.context.paperclipTaskMarkdown).toContain(
      `shared workspace is concurrently held by run ${fixture.holderRunId}`,
    );
    expect(executedInputs.get(run!.id)?.context.paperclipTaskMarkdown).toContain(
      "expect concurrent mutations, coordinate via commits",
    );
  });

  it("auto defers when the final environment driver is sandbox", async () => {
    const fixture = await seedWorkspaceFixture({
      issueWorkspaceSettings: { sharedWorkspaceConcurrency: "auto" },
      agentEnvironmentDriver: "sandbox",
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).not.toContain(run!.id);
  });

  it("auto defers when instance policy forces Kubernetes", async () => {
    const fixture = await seedWorkspaceFixture({
      issueWorkspaceSettings: { sharedWorkspaceConcurrency: "auto" },
      agentEnvironmentDriver: "local",
    });
    await db.insert(environments).values({
      id: randomUUID(),
      companyId: fixture.companyId,
      name: `Managed Kubernetes ${fixture.companyId}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "kubernetes" },
      metadata: { managedKubernetesSandbox: true },
    });
    await instanceSettingsService(db).updateGeneral({ executionMode: "kubernetes" });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).not.toContain(run!.id);
  });

  it.each([
    { driver: "local", policySource: "issue" },
    { driver: "local", policySource: "project" },
    { driver: "ssh", policySource: "issue" },
    { driver: "ssh", policySource: "project" },
  ] as const)("dispatches on $driver despite a $policySource serialize policy", async ({ driver, policySource }) => {
    const fixture = await seedWorkspaceFixture({
      agentEnvironmentDriver: driver,
      issueWorkspaceSettings: policySource === "issue" ? { sharedWorkspaceConcurrency: "serialize" } : null,
      projectWorkspacePolicy: policySource === "project"
        ? { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize" }
        : undefined,
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("succeeded");
    expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).toContain(run!.id);
    expect(executedInputs.get(run!.id)?.context.paperclipTaskMarkdown).toContain(
      `shared workspace is concurrently held by run ${fixture.holderRunId}`,
    );
    expect((await heartbeat.getRun(fixture.holderRunId))?.status).toBe("running");
    const retryRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(
      and(eq(heartbeatRuns.companyId, fixture.companyId), eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON)),
    );
    expect(retryRuns).toHaveLength(0);
  });

  it("allow passes the busy gate for a sandbox environment and adds coordination context", async () => {
    const fixture = await seedWorkspaceFixture({
      issueWorkspaceSettings: { sharedWorkspaceConcurrency: "allow" },
      agentEnvironmentDriver: "sandbox",
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).toContain(run!.id);
    expect((finishedRun?.contextSnapshot as Record<string, unknown>)?.paperclipTaskMarkdown).toContain(
      `shared workspace is concurrently held by run ${fixture.holderRunId}`,
    );
    const retryRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON));
    expect(retryRuns).toHaveLength(0);
  });

  it.each([0, 35 * 60_000])("defers a run in a busy shared workspace after %i ms of holder silence", async (silenceMs) => {
    const fixture = await seedWorkspaceFixture({ holderActivityAt: new Date(Date.now() - silenceMs) });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("cancelled");
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    const workspaceBusy = (finishedRun?.resultJson as Record<string, unknown> | null)
      ?.workspaceBusy as Record<string, unknown> | undefined;
    expect(workspaceBusy).toMatchObject({
      projectWorkspaceId: fixture.projectWorkspaceId,
      holderRunId: fixture.holderRunId,
      holderIssueId: fixture.holderIssueId,
      deferralAttempt: 0,
    });

    // The deferred run's adapter never executed — the whole point of the gate.
    expect(executedRunIds).not.toContain(run!.id);

    const retryRun = await waitForRetryRun(run!.id);
    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
    });
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.wakeReason).toBe(
      WORKSPACE_BUSY_RETRY_WAKE_REASON,
    );

    // The issue execution lock moved to the retry run, so the issue keeps an
    // active execution path and stranded-issue recovery leaves it alone.
    const issueRow = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionRunId).toBe(retryRun!.id);

    const finishedAtMs = finishedRun?.finishedAt ? new Date(finishedRun.finishedAt).getTime() : 0;
    const dueAtMs = retryRun?.scheduledRetryAt ? new Date(retryRun.scheduledRetryAt).getTime() : 0;
    expect(dueAtMs).toBeGreaterThanOrEqual(finishedAtMs + WORKSPACE_BUSY_RETRY_BASE_DELAY_MS);
    expect(dueAtMs).toBeLessThanOrEqual(
      finishedAtMs + WORKSPACE_BUSY_RETRY_BASE_DELAY_MS + WORKSPACE_BUSY_RETRY_JITTER_MS,
    );

    // The holder was left undisturbed and the agent returned to idle rather
    // than error.
    const holderRun = await heartbeat.getRun(fixture.holderRunId);
    expect(holderRun?.status).toBe("running");
    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status, errorReason: agents.errorReason })
            .from(agents)
            .where(eq(agents.id, fixture.agentId))
            .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toEqual({ status: "idle", errorReason: null });

    if (run!.wakeupRequestId) {
      const wakeup = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, run!.wakeupRequestId))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.status).toBe("cancelled");
    }
  });

  it("executes the scheduled retry once the holder has finished", async () => {
    const fixture = await seedWorkspaceFixture();

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();
    const deferred = await waitForRunToLeaveActiveStates(run!.id);
    expect(deferred?.status).toBe("cancelled");

    const retryRun = await waitForRetryRun(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");

    // Holder finishes; the due retry promotes, queues, and executes.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.holderRunId));

    const afterDue = new Date(new Date(retryRun!.scheduledRetryAt!).getTime() + 1_000);
    const promotion = await heartbeat.promoteDueScheduledRetries(afterDue);
    expect(promotion.runIds).toContain(retryRun!.id);

    await heartbeat.resumeQueuedRuns();
    const finishedRetry = await waitForRunToLeaveActiveStates(retryRun!.id);
    expect(finishedRetry?.status).toBe("succeeded");
    expect(executedRunIds).toContain(retryRun!.id);
  });

  it("preserves a legacy accepted mention run through workspace retry", async () => {
    const fixture = await seedWorkspaceFixture();

    // Existing queued work can contain coalesced assignment or feedback.
    // Only new mention requests are ignored; keep accepted work's rules.
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId, agentId: fixture.nonAssigneeAgentId,
      invocationSource: "on_demand", status: "queued", responsibleUserId: "responsible-user",
      contextSnapshot: {
        issueId: fixture.issueId, wakeReason: "issue_comment_mentioned", commentId: randomUUID(),
      },
    }).returning();
    await heartbeat.resumeQueuedRuns();

    const deferred = await waitForRunToLeaveActiveStates(run!.id);
    expect(deferred?.status).toBe("cancelled");
    expect(deferred?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).not.toContain(run!.id);

    const retryRun = await waitForRetryRun(run!.id);
    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
    });
    expect(
      (retryRun?.contextSnapshot as Record<string, unknown> | null)?.workspaceBusyDeferredWhileAssignee,
    ).toBe(false);

    // The non-assignee run never held the issue execution lock, so the
    // deferral must not have stolen or released it.
    const issueRow = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionRunId).toBeNull();

    // The holder finishes; the retry must survive the promotion gate even
    // though the retry's agent is not the issue assignee.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.holderRunId));

    const afterDue = new Date(new Date(retryRun!.scheduledRetryAt!).getTime() + 1_000);
    const promotion = await heartbeat.promoteDueScheduledRetries(afterDue);
    expect(promotion.runIds).toContain(retryRun!.id);

    await heartbeat.resumeQueuedRuns();
    const finishedRetry = await waitForRunToLeaveActiveStates(retryRun!.id);
    expect(finishedRetry?.status).toBe("succeeded");
    expect(executedRunIds).toContain(retryRun!.id);
  });

  it("still cancels an assignee retry at promotion when the issue is reassigned", async () => {
    const fixture = await seedWorkspaceFixture();

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();
    const deferred = await waitForRunToLeaveActiveStates(run!.id);
    expect(deferred?.status).toBe("cancelled");

    const retryRun = await waitForRetryRun(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(
      (retryRun?.contextSnapshot as Record<string, unknown> | null)?.workspaceBusyDeferredWhileAssignee,
    ).toBe(true);

    // Ownership changes while the retry pends: the deferral was taken under
    // assignee-ship, so the reassignment protection must still cancel it.
    await db
      .update(issues)
      .set({ assigneeAgentId: fixture.nonAssigneeAgentId, executionRunId: null })
      .where(eq(issues.id, fixture.issueId));

    const afterDue = new Date(new Date(retryRun!.scheduledRetryAt!).getTime() + 1_000);
    const promotion = await heartbeat.promoteDueScheduledRetries(afterDue);
    expect(promotion.runIds).not.toContain(retryRun!.id);

    const cancelledRetry = await heartbeat.getRun(retryRun!.id);
    expect(cancelledRetry?.status).toBe("cancelled");
    expect(cancelledRetry?.errorCode).toBe("issue_reassigned");
  });

  it("does not defer when the holder issue explicitly uses an isolated workspace", async () => {
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      const fixture = await seedWorkspaceFixture({
        holderIssueWorkspaceSettings: { mode: "isolated_workspace" },
      });

      const run = await heartbeat.invoke(
        fixture.agentId,
        "assignment",
        { issueId: fixture.issueId, wakeReason: "issue_assigned" },
        "system",
      );
      expect(run).not.toBeNull();

      const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
      expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
      const retryRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, fixture.companyId),
            eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON),
          ),
        )
        .then((rows) => rows.length);
      expect(retryRuns).toBe(0);
    } finally {
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    }
  });

  it("does not defer when the running run holds a different project workspace", async () => {
    const fixture = await seedWorkspaceFixture({ holderProjectWorkspaceId: randomUUID() });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
    const retryRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, fixture.companyId),
          eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON),
        ),
      )
      .then((rows) => rows.length);
    expect(retryRuns).toBe(0);
  });

  it("does not defer when the only holder has been silent past the staleness threshold", async () => {
    const fixture = await seedWorkspaceFixture({
      holderActivityAt: new Date(Date.now() - WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS - 60_000),
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    // The holder row is still "running", but it has been silent past the
    // staleness bar, so it no longer blocks the workspace.
    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("succeeded");
    expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).toContain(run!.id);
  });

  it("keeps deferring past earlier attempts while the holder is still live", async () => {
    const fixture = await seedWorkspaceFixture();

    // Seed the promoted continuation of a run that has already been deferred
    // many times while the holder is still live: it must defer again, not
    // dispatch alongside the live holder.
    const priorAttempts = 10;
    const priorRunId = randomUUID();
    const wakeupId = randomUUID();
    const retryRunId = randomUUID();
    const now = new Date();
    const dueAt = new Date(now.getTime() - 1_000);

    await db.insert(heartbeatRuns).values({
      id: priorRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      errorCode: WORKSPACE_BUSY_ERROR_CODE,
      finishedAt: now,
      scheduledRetryAttempt: priorAttempts - 1,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
      contextSnapshot: {
        issueId: fixture.issueId,
        wakeReason: WORKSPACE_BUSY_RETRY_WAKE_REASON,
      },
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: WORKSPACE_BUSY_RETRY_WAKE_REASON,
      payload: {
        issueId: fixture.issueId,
        retryOfRunId: priorRunId,
        retryReason: WORKSPACE_BUSY_RETRY_REASON,
        scheduledRetryAttempt: priorAttempts,
      },
      status: "queued",
      requestedByActorType: "system",
    });

    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId: wakeupId,
      retryOfRunId: priorRunId,
      scheduledRetryAt: dueAt,
      scheduledRetryAttempt: priorAttempts,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
      contextSnapshot: {
        issueId: fixture.issueId,
        wakeReason: WORKSPACE_BUSY_RETRY_WAKE_REASON,
        retryReason: WORKSPACE_BUSY_RETRY_REASON,
        workspaceBusyDeferredWhileAssignee: true,
      },
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: retryRunId })
      .where(eq(agentWakeupRequests.id, wakeupId));

    const promotion = await heartbeat.promoteDueScheduledRetries(now);
    expect(promotion.runIds).toContain(retryRunId);

    await heartbeat.resumeQueuedRuns();
    const finishedRun = await waitForRunToLeaveActiveStates(retryRunId);

    expect(finishedRun?.status).toBe("cancelled");
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).not.toContain(retryRunId);

    const nextRetry = await waitForRetryRun(retryRunId);
    expect(nextRetry).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryAttempt: priorAttempts + 1,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
    });

    const holderRun = await heartbeat.getRun(fixture.holderRunId);
    expect(holderRun?.status).toBe("running");
  });
});
