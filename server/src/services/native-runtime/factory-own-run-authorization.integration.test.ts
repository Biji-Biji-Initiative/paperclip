import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { FACTORY_COMPANY_ID } from "@paperclipai/adapter-utils/factory-worker-lease";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { readFactoryOwnRunAuthorization } from "./factory-worker-runtime.js";

describe("Factory own-run authorization from actual relational wakeup records", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = FACTORY_COMPANY_ID, foreignCompanyId = randomUUID();
  const agentId = randomUUID(), foreignAgentId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("factory-own-run-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values([{ id: companyId, name: "Own-run proof", issuePrefix: "OWN" },
      { id: foreignCompanyId, name: "Foreign proof", issuePrefix: "FRN" }]);
    await db.insert(agents).values([{ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner", status: "active" },
      { id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign", adapterType: "paperclip_runner", status: "active" }]);
  }, 120_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const actorId = randomUUID(), wakeupRequestId = randomUUID(), runId = randomUUID(), requestedAt = new Date(Date.now() - 1000);
    const actorEmail = actorId + "@example.invalid", now = new Date();
    await db.insert(authUsers).values({ id: actorId, name: "Synthetic operator", email: actorEmail,
      emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, runId,
      source: "on_demand", triggerDetail: "manual", status: "claimed", requestedAt, claimedAt: now,
      requestedByActorType: "user", requestedByActorId: actorId, payload: { manualUserWake: true } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, wakeupRequestId,
      status: "running", runtimeMode: "native", invocationSource: "on_demand", triggerDetail: "manual" });
    const binding = { companyId, agentId, runId, issueId: randomUUID(), executionWorkspaceId: randomUUID() };
    return { actorId, actorEmail, wakeupRequestId, runId, requestedAt, binding };
  }

  it("projects only exact linked requester/user rows and observes current email/cancellation", async () => {
    const f = await fixture();
    await db.update(agentWakeupRequests).set({ payload: { manualUserWake: true,
      actorId: "forged-body-principal", actorEmail: "forged@example.invalid" } })
      .where(eq(agentWakeupRequests.id, f.wakeupRequestId));
    await db.update(heartbeatRuns).set({ responsibleUserId: "delegated-user",
      contextSnapshot: { actorId: "forged-context-principal", actorEmail: "forged@example.invalid" } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await readFactoryOwnRunAuthorization(db, f.binding)).toEqual({ schema: "factory.direct-board-wakeup.v1",
      actorType: "user", actorId: f.actorId, actorEmail: f.actorEmail, wakeupRequestId: f.wakeupRequestId,
      agentId, requestedAtUnixMs: f.requestedAt.getTime() });
    const changedEmail = "changed-" + f.actorEmail;
    await db.update(authUsers).set({ email: changedEmail }).where(eq(authUsers.id, f.actorId));
    expect(await readFactoryOwnRunAuthorization(db, f.binding)).toHaveProperty("actorEmail", changedEmail);
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, f.wakeupRequestId));
    await expect(readFactoryOwnRunAuthorization(db, f.binding)).rejects.toThrow("native_execution_ownership_unverified");
  });

  it("rejects foreign/reversed/missing DB links even when context claims an authorized requester", async () => {
    const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>> = [
      f => db.update(agentWakeupRequests).set({ companyId: foreignCompanyId }).where(eq(agentWakeupRequests.id, f.wakeupRequestId)),
      f => db.update(agentWakeupRequests).set({ agentId: foreignAgentId }).where(eq(agentWakeupRequests.id, f.wakeupRequestId)),
      f => db.update(agentWakeupRequests).set({ runId: randomUUID() }).where(eq(agentWakeupRequests.id, f.wakeupRequestId)),
      f => db.update(heartbeatRuns).set({ wakeupRequestId: null }).where(eq(heartbeatRuns.id, f.runId)),
      f => db.update(agentWakeupRequests).set({ requestedByActorId: "missing-user" }).where(eq(agentWakeupRequests.id, f.wakeupRequestId)),
      f => db.delete(authUsers).where(eq(authUsers.id, f.actorId)),
    ];
    for (const change of mutations) {
      const f = await fixture();
      await db.update(heartbeatRuns).set({ responsibleUserId: f.actorId,
        contextSnapshot: { actorId: f.actorId, triggeredBy: "board", responsibleUserId: f.actorId, manualUserWake: true } })
        .where(eq(heartbeatRuns.id, f.runId));
      await change(f);
      await expect(readFactoryOwnRunAuthorization(db, f.binding)).rejects.toThrow("native_execution_ownership_unverified");
    }
  });

  it("refuses coalesced, replayed, delegated, forged principal and inactive receipts", async () => {
    const wakeMutations = [
      { status: "coalesced" }, { coalescedCount: 1 }, { finishedAt: new Date() },
      { requestedByActorType: "agent" }, { requestedByActorType: "system" },
      { payload: { manualUserWake: false, actorId: "forged", actorEmail: "forged@example.invalid" } },
      { payload: { actorId: "forged", actorEmail: "forged@example.invalid" } },
      { source: "automation" }, { triggerDetail: "system" },
    ];
    for (const change of wakeMutations) {
      const f = await fixture();
      await db.update(agentWakeupRequests).set(change).where(eq(agentWakeupRequests.id, f.wakeupRequestId));
      await expect(readFactoryOwnRunAuthorization(db, f.binding)).rejects.toThrow("native_execution_ownership_unverified");
    }
    for (const change of [{ status: "cancelled" }, { runtimeMode: "legacy" }, { continuationAttempt: 1 },
      { processLossRetryCount: 1 }, { scheduledRetryAttempt: 1 }, { invocationSource: "automation" }]) {
      const f = await fixture();
      await db.update(heartbeatRuns).set(change).where(eq(heartbeatRuns.id, f.runId));
      await expect(readFactoryOwnRunAuthorization(db, f.binding)).rejects.toThrow("native_execution_ownership_unverified");
    }
    const f = await fixture();
    await db.update(heartbeatRuns).set({ retryOfRunId: f.runId }).where(eq(heartbeatRuns.id, f.runId));
    await expect(readFactoryOwnRunAuthorization(db, f.binding)).rejects.toThrow("native_execution_ownership_unverified");
  });
});
