import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { environmentLeases, environments, executionWorkspaces, heartbeatRuns, type Db } from "@paperclipai/db";
import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { FACTORY_COMPANY_ID, FACTORY_WORKER_POLICY } from "@paperclipai/adapter-utils/factory-worker-lease";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { createAuthorizedFactoryWorkerAdmission, createAuthorizedFactoryWorkerLease } from "./factory-worker-runtime.js";

// DB-current mutation fixtures. Existing capacity integration suite proves SQL/company predicates.
function fixture(mode = true) {
  const runId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID(), workspaceId = randomUUID();
  const runnerInstanceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = "session-" + randomUUID();
  const cwd = `/workspace/${FACTORY_COMPANY_ID}/${workspaceId}`;
  const admission = { provider: "codex" as const, workerPlanSha256: "a".repeat(64) };
  const config = { factoryWorkerPolicy: FACTORY_WORKER_POLICY, host: "fixture.invalid", port: 2222,
    username: "node", knownHosts: "fixture-pin", strictHostKeyChecking: true, remoteWorkspacePath: cwd,
    ...(mode ? { factoryProviderAdmission: admission } : {}) };
  const execution = { binding: { companyId: FACTORY_COMPANY_ID, runId, agentId, issueId, executionWorkspaceId: workspaceId },
    provider: { kind: "codex" }, session: { normalizedSessionId: sessionId, driverKind: "codex_app_server",
      protocolVersion: 1, lifecyclePolicy: { mode: "per_turn" } } } as NativeExecutionInput;
  const target: AdapterSshExecutionTarget = { kind: "remote", transport: "ssh", environmentId, leaseId,
    factoryWorkerPolicy: FACTORY_WORKER_POLICY, ...(mode ? { factoryProviderAdmission: { ...admission } } : {}),
    remoteCwd: cwd, spec: { host: config.host, port: config.port, username: config.username, remoteCwd: cwd, remoteWorkspacePath: cwd,
      knownHosts: config.knownHosts, strictHostKeyChecking: true, privateKey: "synthetic-not-read" } };
  const run = { id: runId, companyId: FACTORY_COMPANY_ID, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "running",
    runnerInstanceId, runnerProfileJson: { nativeExecutionInput: structuredClone(execution) }, executionControlDeadlineAt: new Date(Date.now() + 60_000) };
  const lease = { id: leaseId, environmentId, heartbeatRunId: runId, executionWorkspaceId: workspaceId, issueId,
    status: "active", provider: "ssh", releasedAt: null, expiresAt: null, metadata: { remoteCwd: cwd } };
  const environment = { driver: "ssh", status: "active", config };
  const rows = new Map<unknown, unknown>([[heartbeatRuns, run], [environmentLeases, lease],
    [environments, environment], [executionWorkspaces, { status: "active" }]]);
  const db = { select: () => ({ from: (table: unknown) => ({ where: async () => [rows.get(table)] }) }) } as unknown as Db;
  return { db, execution, target, sessionId, runnerInstanceId, run, lease, environment };
}

describe("Factory provider DB-current admission", () => {
  it("keeps legacy credential-free and prevents old caller downgrade of explicit mode", async () => {
    const f = fixture(false);
    expect(await createAuthorizedFactoryWorkerAdmission(f)).not.toHaveProperty("providerAdmission");
    expect(await createAuthorizedFactoryWorkerLease(f)).toMatchObject({ runId: f.run.id });
    await expect(createAuthorizedFactoryWorkerLease(fixture())).rejects.toThrow();
  });
  it("binds real IDs/plan and creates fresh attempt IDs after authorization", async () => {
    const f = fixture();
    const a = await createAuthorizedFactoryWorkerAdmission(f), b = await createAuthorizedFactoryWorkerAdmission(f);
    expect(a.providerAdmission).toMatchObject({ schema: "factory.provider-worker-binding.v2", provider: "codex", normalizedSessionId: f.sessionId, runnerInstanceId: f.runnerInstanceId,
      workerPlanSha256: f.target.factoryProviderAdmission!.workerPlanSha256 });
    expect(a.providerAdmission!.admissionId).not.toBe(b.providerAdmission!.admissionId);
    expect(a.providerAdmission!.capabilityId).not.toBe(b.providerAdmission!.capabilityId);
    expect(a.workerLease.deadlineUnixMs).toBe(f.run.executionControlDeadlineAt.getTime());
  });
  it.each(["registration", "execution", "stored execution"])("keeps %s Codex-only despite the low-level Claude v2 contract", async boundary => {
    const f = fixture();
    if (boundary === "registration") {
      Reflect.set(f.environment.config.factoryProviderAdmission!, "provider", "claude");
      Reflect.set(f.target.factoryProviderAdmission!, "provider", "claude");
    } else if (boundary === "execution") {
      f.execution = { ...f.execution, provider: { kind: "acpx", agent: "claude" } } as NativeExecutionInput;
    } else {
      const stored = f.run.runnerProfileJson.nativeExecutionInput;
      f.run.runnerProfileJson.nativeExecutionInput = { ...stored, provider: { kind: "acpx", agent: "claude" } } as NativeExecutionInput;
    }
    await expect(createAuthorizedFactoryWorkerAdmission(f)).rejects.toMatchObject({
      name: "NativeRunnerOwnershipUnverifiedError", reason: "ssh_foreground_ownership_unverified",
    });
  });
  it("rejects changed registration, omitted mode, stale runner/session and inactive lease", async () => {
    const mutations = [
      (f: ReturnType<typeof fixture>) => { f.environment.config.factoryProviderAdmission!.workerPlanSha256 = "b".repeat(64); },
      (f: ReturnType<typeof fixture>) => { delete (f.target as { factoryProviderAdmission?: unknown }).factoryProviderAdmission; },
      (f: ReturnType<typeof fixture>) => { f.runnerInstanceId = randomUUID(); },
      (f: ReturnType<typeof fixture>) => { f.sessionId = "foreign"; },
      (f: ReturnType<typeof fixture>) => { const stored = f.run.runnerProfileJson.nativeExecutionInput;
        f.run.runnerProfileJson.nativeExecutionInput = { ...stored, session: { ...stored.session, normalizedSessionId: "foreign" } }; },
      (f: ReturnType<typeof fixture>) => { f.lease.status = "released"; },
      (f: ReturnType<typeof fixture>) => { f.run.status = "succeeded"; },
    ];
    for (const change of mutations) {
      const f = fixture(); change(f);
      await expect(createAuthorizedFactoryWorkerAdmission(f)).rejects.toThrow();
    }
  });
  it("rejects persisted native agent/issue/lifecycle and durable lease substitutions", async () => {
    for (const key of ["agentId", "issueId"] as const) {
      const f = fixture(), stored = f.run.runnerProfileJson.nativeExecutionInput;
      f.run.runnerProfileJson.nativeExecutionInput = { ...stored, binding: { ...stored.binding, [key]: randomUUID() } };
      await expect(createAuthorizedFactoryWorkerAdmission(f)).rejects.toThrow();
    }
    const f = fixture(), stored = f.run.runnerProfileJson.nativeExecutionInput;
    f.run.runnerProfileJson.nativeExecutionInput = { ...stored, session: { ...stored.session,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 1000 } } };
    await expect(createAuthorizedFactoryWorkerAdmission(f)).rejects.toThrow();
    await expect(createAuthorizedFactoryWorkerAdmission({ ...fixture(), durableEnvironmentLeaseId: randomUUID() })).rejects.toThrow();
  });
});
