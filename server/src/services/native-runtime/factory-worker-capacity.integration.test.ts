import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces,
  heartbeatRuns, issues, nativeRunFinalizations, projects } from "@paperclipai/db";
import { FACTORY_COMPANY_ID, FACTORY_WORKER_POLICY, FactoryWorkerBusyError } from "@paperclipai/adapter-utils/factory-worker-lease";
import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { authorizeFactoryWorker, createAuthorizedFactoryWorkerLease, assertFactoryWorkerColdExecution,
  assertFactoryWorkerCredentialBoundary } from "./factory-worker-runtime.js";
import { deferFactoryWorkerCapacity, factoryProviderAttempt, hasFactoryBusyReceipt } from "./factory-worker-capacity.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";

type NativeExecutionInputV1 = Extract<NativeExecutionInput, { schema: "paperclip.native-execution-input.v1" }>;

describe("Factory authoritative runtime and nondispatched capacity", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = FACTORY_COMPANY_ID, agentId = randomUUID(), projectId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("factory-worker-capacity-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Isolated Factory proof", issuePrefix: "FWC" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner", status: "active" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fixture" });
  }, 120_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const runId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
    const cwd = `/workspace/${companyId}/${workspaceId}`;
    await db.insert(issues).values({ id: issueId, companyId, title: "Fixture", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId,
      mode: "shared", strategyType: "shared", name: "Fixture", cwd });
    const config = { host: "fixture.invalid", port: 2222, username: "node", remoteWorkspacePath: cwd,
      knownHosts: "fixture-key-pin", strictHostKeyChecking: true, factoryWorkerPolicy: FACTORY_WORKER_POLICY };
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "ssh", config });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, agentId, issueId, runId, executionWorkspaceId: workspaceId },
      task: { identifier: issueId, title: "Fixture", description: null, prompt: "No provider execution", workMode: "standard" },
      workspace: { cwd, repoUrl: null, repoRef: null, branchName: null },
      provider: { kind: "codex", model: null, approvalPolicy: "never" },
      session: { normalizedSessionId: randomUUID(), driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: randomUUID(), sha256: "0".repeat(64), schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Verify runtime authority", criteria: [{ id: "authority", requirement: "No unauthorized dispatch" }] } },
      credentialBindings: [], interactionResponses: [],
    };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "running", invocationSource: "assignment", triggerDetail: "system",
      runnerProfileJson: { nativeExecutionInput: execution } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, executionWorkspaceId: workspaceId,
      heartbeatRunId: runId, issueId, status: "active", provider: "ssh", metadata: { remoteCwd: cwd } });
    const target: AdapterSshExecutionTarget = { kind: "remote", transport: "ssh", environmentId, leaseId,
      factoryWorkerPolicy: FACTORY_WORKER_POLICY, remoteCwd: cwd,
      spec: { ...config, remoteCwd: cwd, privateKey: "fixture-not-a-key" } };
    return { execution, target, runId, issueId, environmentId, leaseId };
  }

  it("binds actual run/workspace/acquired lease, revalidates enrollment and uses the earlier deadline", async () => {
    const f = await fixture();
    await expect(authorizeFactoryWorker({ db, ...f, beforeClaim: true })).resolves.toBeDefined();
    const deadline = new Date(Date.now() + 80_000);
    await db.update(heartbeatRuns).set({ executionControlDeadlineAt: deadline }).where(eq(heartbeatRuns.id, f.runId));
    const d = await createAuthorizedFactoryWorkerLease({ db, ...f, sessionId: f.execution.session.normalizedSessionId! });
    expect(d).toMatchObject({ runId: f.runId, leaseId: f.leaseId, deadlineUnixMs: deadline.getTime(), workspaceRoot: f.target.remoteCwd });
    await db.update(environments).set({ config: {} }).where(eq(environments.id, f.environmentId));
    await expect(authorizeFactoryWorker({ db, ...f })).rejects.toThrow("native_execution_ownership_unverified");
  });

  it("rejects foreign lease, connection retargeting, warm lifecycle and accepted-run replay", async () => {
    const f = await fixture();
    await expect(authorizeFactoryWorker({ db, ...f, target: { ...f.target, leaseId: randomUUID() } })).rejects.toThrow();
    await expect(authorizeFactoryWorker({ db, ...f, target: { ...f.target, spec: { ...f.target.spec, host: "other.invalid" } } })).rejects.toThrow();
    expect(() => assertFactoryWorkerColdExecution({ ...f.execution, session: { ...f.execution.session,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 1000 } } }, undefined)).toThrow();
    expect(() => assertFactoryWorkerColdExecution(f.execution, { kind: "resume" })).toThrow();
    expect(() => assertFactoryWorkerColdExecution({ ...f.execution,
      provider: { kind: "opencode", model: "fixture", permissionMode: "allow" } }, undefined)).toThrow();
    expect(() => assertFactoryWorkerCredentialBoundary({ OPENAI_API_KEY: "fixture-only" }, undefined)).toThrow();
    expect(() => assertFactoryWorkerCredentialBoundary({}, "/not-read/managed-auth-home")).toThrow();
    expect(() => assertFactoryWorkerCredentialBoundary(undefined, undefined)).not.toThrow();
    await db.update(nativeRunFinalizations).set({ attempt: 1 }).where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(authorizeFactoryWorker({ db, ...f, beforeClaim: true })).rejects.toThrow();
  });

  it("repeated verified busy survives scheduler claims without incrementing or decrementing the reserved attempt", async () => {
    const f = await fixture();
    let owner = "fixture-first";
    await db.update(nativeRunFinalizations).set({ attempt: 1, leaseOwner: owner }).where(eq(nativeRunFinalizations.runId, f.runId));
    for (let n = 0; n < 5; n++) {
      const now = new Date(Date.now() + n * 60_000);
      const deferred = await deferFactoryWorkerCapacity({ db, runId: f.runId, companyId, issueId: f.issueId,
        leaseOwner: owner, attempt: 1, error: new FactoryWorkerBusyError(), now });
      let [row] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(row).toMatchObject({ phase: "retryable_failure", attempt: 1, resultId: null, leaseOwner: null });
      expect(hasFactoryBusyReceipt(row, f.runId)).toBe(true);
      const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "fixture", runIds: [f.runId], now: deferred.nextAttemptAt });
      expect(claims).toHaveLength(1); owner = claims[0].leaseOwner;
      await expect(authorizeFactoryWorker({ db, ...f, beforeClaim: true })).resolves.toBeDefined();
      [row] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(factoryProviderAttempt(row, f.runId)).toBe(1);
      // This is the executor's next claim, reserving the same attempt atomically.
      await db.update(nativeRunFinalizations).set({ failureCode: null, failureDetail: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(run).toMatchObject({ status: "running", errorCode: null }); expect(issue.status).toBe("in_progress");
  });

  it("plain exit75 and stale coordinator ownership cannot create capacity receipts", async () => {
    const f = await fixture();
    await db.update(nativeRunFinalizations).set({ attempt: 1, leaseOwner: "real-owner" }).where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(deferFactoryWorkerCapacity({ db, runId: f.runId, companyId, issueId: f.issueId,
      leaseOwner: "real-owner", attempt: 1, error: new Error("75") })).rejects.toThrow("busy_unverified");
    await expect(deferFactoryWorkerCapacity({ db, runId: f.runId, companyId, issueId: f.issueId,
      leaseOwner: "stale-owner", attempt: 1, error: new FactoryWorkerBusyError() })).rejects.toThrow("binding_lost");
    const [row] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(row).toMatchObject({ phase: "observed", leaseOwner: "real-owner", failureCode: null });
  });
});
