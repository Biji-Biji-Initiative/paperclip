import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentWakeupRequests, authUsers, environmentLeases, environments, executionWorkspaces, heartbeatRuns, type Db } from "@paperclipai/db";
import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { FactoryAdmissionProvider } from "@paperclipai/adapter-utils/factory-provider-admission";
import { FACTORY_COMPANY_ID, FACTORY_WORKER_POLICY } from "@paperclipai/adapter-utils/factory-worker-lease";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { createAuthorizedFactoryWorkerAdmission, createAuthorizedFactoryWorkerLease } from "./factory-worker-runtime.js";

// DB-current mutation fixtures. Existing capacity integration suite proves SQL/company predicates.
function fixture(mode = true, provider: FactoryAdmissionProvider = "codex") {
  const runId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID(), workspaceId = randomUUID();
  const runnerInstanceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = "session-" + randomUUID();
  const cwd = `/workspace/${FACTORY_COMPANY_ID}/${workspaceId}`;
  const admission = { provider, workerPlanSha256: "a".repeat(64) };
  const config = { factoryWorkerPolicy: FACTORY_WORKER_POLICY, host: "fixture.invalid", port: 2222,
    username: "node", knownHosts: "fixture-pin", strictHostKeyChecking: true, remoteWorkspacePath: cwd,
    ...(mode ? { factoryProviderAdmission: admission } : {}) };
  const execution = { binding: { companyId: FACTORY_COMPANY_ID, runId, agentId, issueId, executionWorkspaceId: workspaceId },
    provider: provider === "codex" ? { kind: "codex" } : { kind: "acpx", agent: "claude" },
    session: { normalizedSessionId: sessionId, driverKind: provider === "codex" ? "codex_app_server" : "acpx_runtime",
      protocolVersion: 1, lifecyclePolicy: { mode: "per_turn" } } } as NativeExecutionInput;
  const target: AdapterSshExecutionTarget = { kind: "remote", transport: "ssh", environmentId, leaseId,
    factoryWorkerPolicy: FACTORY_WORKER_POLICY, ...(mode ? { factoryProviderAdmission: { ...admission } } : {}),
    remoteCwd: cwd, spec: { host: config.host, port: config.port, username: config.username, remoteCwd: cwd, remoteWorkspacePath: cwd,
      knownHosts: config.knownHosts, strictHostKeyChecking: true, privateKey: "synthetic-not-read" } };
  const run = { id: runId, companyId: FACTORY_COMPANY_ID, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "running",
    wakeupRequestId: randomUUID(), invocationSource: "on_demand", triggerDetail: "manual", retryOfRunId: null,
    runnerInstanceId, runnerProfileJson: { nativeExecutionInput: structuredClone(execution) }, executionControlDeadlineAt: new Date(Date.now() + 60_000) };
  const lease = { id: leaseId, environmentId, heartbeatRunId: runId, executionWorkspaceId: workspaceId, issueId,
    status: "active", provider: "ssh", releasedAt: null, expiresAt: null, metadata: { remoteCwd: cwd } };
  const environment = { driver: "ssh", status: "active", config };
  const wake = { id: run.wakeupRequestId, companyId: FACTORY_COMPANY_ID, agentId, runId, status: "claimed", finishedAt: null,
    coalescedCount: 0, source: "on_demand", triggerDetail: "manual", payload: { manualUserWake: true },
    requestedByActorType: "user", requestedByActorId: "synthetic-user", requestedAt: new Date(Date.now() - 1000) };
  const user = { id: "synthetic-user", email: "synthetic@example.invalid" };
  const rows = new Map<unknown, unknown>([[heartbeatRuns, run], [environmentLeases, lease],
    [environments, environment], [executionWorkspaces, { status: "active" }], [agentWakeupRequests, wake], [authUsers, user]]);
  const db = { select: () => ({ from: (table: unknown) => {
    const joined = { innerJoin: () => joined, where: async () => [{ run, wake, user }] };
    return { where: async () => [rows.get(table)], innerJoin: () => joined };
  } }) } as unknown as Db;
  return { db, execution, target, sessionId, runnerInstanceId, run, lease, environment, wake, user };
}

describe("Factory provider DB-current admission", () => {
  it("keeps legacy credential-free and prevents old caller downgrade of explicit mode", async () => {
    const f = fixture(false);
    expect(await createAuthorizedFactoryWorkerAdmission(f)).not.toHaveProperty("providerAdmission");
    expect(await createAuthorizedFactoryWorkerLease(f)).toMatchObject({ runId: f.run.id });
    await expect(createAuthorizedFactoryWorkerLease(fixture())).rejects.toThrow();
  });
  it.each(["codex", "claude"] as const)("binds %s IDs/plan and creates fresh attempt IDs after authorization", async provider => {
    const f = fixture(true, provider);
    const a = await createAuthorizedFactoryWorkerAdmission(f), b = await createAuthorizedFactoryWorkerAdmission(f);
    expect(a.providerAdmission).toMatchObject({ schema: "factory.provider-worker-binding.v2", provider, normalizedSessionId: f.sessionId, runnerInstanceId: f.runnerInstanceId,
      workerPlanSha256: f.target.factoryProviderAdmission!.workerPlanSha256 });
    expect(a.providerAdmission!.admissionId).not.toBe(b.providerAdmission!.admissionId);
    expect(a.providerAdmission!.capabilityId).not.toBe(b.providerAdmission!.capabilityId);
    expect(a.workerLease.deadlineUnixMs).toBe(f.run.executionControlDeadlineAt.getTime());
    expect(a.providerAdmission!.authorization).toEqual({ schema: "factory.direct-board-wakeup.v1", actorType: "user",
      actorId: f.user.id, actorEmail: f.user.email, wakeupRequestId: f.wake.id, agentId: f.run.agentId,
      requestedAtUnixMs: f.wake.requestedAt.getTime() });
    await expect(a.revalidateProviderAdmission!()).resolves.toBeUndefined();
    f.user.email = "changed@example.invalid";
    await expect(a.revalidateProviderAdmission!()).rejects.toThrow("native_execution_ownership_unverified");
  });
  it.each(["codex", "claude"] as const)("rechecks %s wake cancellation, actor identity and current lease before signing", async provider => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.wake.status = "cancelled"; },
      (f: ReturnType<typeof fixture>) => { f.wake.payload.manualUserWake = false; },
      (f: ReturnType<typeof fixture>) => { f.wake.requestedByActorType = "agent"; },
      (f: ReturnType<typeof fixture>) => { f.wake.requestedByActorId = "different-user"; },
      (f: ReturnType<typeof fixture>) => { f.wake.coalescedCount = 1; },
      (f: ReturnType<typeof fixture>) => { f.lease.status = "released"; },
    ]) {
      const f = fixture(true, provider), admitted = await createAuthorizedFactoryWorkerAdmission(f);
      change(f);
      await expect(admitted.revalidateProviderAdmission!()).rejects.toThrow("native_execution_ownership_unverified");
    }
  });
  it.each(["codex", "claude"] as const)("rejects %s provider substitution at each admission boundary", async provider => {
    const otherProvider = provider === "codex" ? "claude" : "codex";
    for (const boundary of ["registration", "selected target", "execution", "stored execution", "driver", "stored driver"]) {
      const f = fixture(true, provider), other = fixture(true, otherProvider).execution;
      if (boundary === "registration") f.environment.config.factoryProviderAdmission!.provider = otherProvider;
      else if (boundary === "selected target") Reflect.set(f.target.factoryProviderAdmission!, "provider", otherProvider);
      else if (boundary === "execution") f.execution = { ...f.execution, provider: other.provider, session: { ...f.execution.session, driverKind: other.session.driverKind } } as NativeExecutionInput;
      else if (boundary === "driver") f.execution = { ...f.execution, session: { ...f.execution.session, driverKind: other.session.driverKind } };
      else {
        const stored = f.run.runnerProfileJson.nativeExecutionInput;
        f.run.runnerProfileJson.nativeExecutionInput = { ...stored,
          ...(boundary === "stored execution" ? { provider: other.provider } : {}),
          session: { ...stored.session, driverKind: other.session.driverKind } } as NativeExecutionInput;
      }
      await expect(createAuthorizedFactoryWorkerAdmission(f), boundary).rejects.toMatchObject({
        name: "NativeRunnerOwnershipUnverifiedError", reason: "ssh_foreground_ownership_unverified",
      });
    }
  });
  it("rejects a different ACPX agent and provider changes before signing", async () => {
    const f = fixture(true, "claude"), admitted = await createAuthorizedFactoryWorkerAdmission(f);
    f.environment.config.factoryProviderAdmission!.provider = "codex";
    await expect(admitted.revalidateProviderAdmission!()).rejects.toThrow();
    for (const stored of [false, true]) {
      const f = fixture(true, "claude");
      const execution = stored ? f.run.runnerProfileJson.nativeExecutionInput : f.execution;
      execution.provider = { kind: "acpx", agent: "codex" } as NativeExecutionInput["provider"];
      await expect(createAuthorizedFactoryWorkerAdmission(f)).rejects.toThrow();
    }
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
