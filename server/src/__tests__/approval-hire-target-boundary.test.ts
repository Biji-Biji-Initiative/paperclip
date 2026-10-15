import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, approvals, companies, createDb, principalPermissionGrants } from "@paperclipai/db";
import { approvalService } from "../services/approvals.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const { wakeup, notify } = vi.hoisted(() => ({ wakeup: vi.fn(), notify: vi.fn() }));
vi.mock("../services/hire-hook.js", () => ({ notifyHireApproved: notify }));
const routes = hoistModuleGraph(() => {
  vi.doMock("../services/index.js", () => ({
    approvalService,
    accessService: () => ({ decide: async () => ({ allowed: true }) }),
    heartbeatService: () => ({ wakeup }),
    issueApprovalService: () => ({ listIssuesForApproval: async () => [], linkManyForApproval: async () => [] }),
    logActivity: async () => {},
    secretService: () => ({ normalizeHireApprovalPayloadForPersistence: async (_company: string, payload: unknown) => payload }),
  }));
}, async () => ({
  approvalRoutes: (await import("../routes/approvals.js")).approvalRoutes,
  errorHandler: (await import("../middleware/index.js")).errorHandler,
}));
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("hire approval target boundary through real routes and PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-hire-target-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });
  beforeEach(() => {
    vi.clearAllMocks();
    wakeup.mockResolvedValue(null);
    notify.mockResolvedValue(undefined);
  });

  async function fixture(status: string, foreign: boolean) {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const targetCompanyId = foreign ? otherCompanyId : companyId;
    await db.insert(companies).values([
      { id: companyId, name: "Approver company", issuePrefix: "A" + companyId.slice(0, 7) },
      { id: otherCompanyId, name: "Other company", issuePrefix: "B" + otherCompanyId.slice(0, 7) },
    ]);
    await db.insert(agents).values({ id: agentId, companyId: targetCompanyId, name: "Protected agent",
      role: "engineer", status, adapterType: "process", adapterConfig: { command: "original-command" },
      runtimeConfig: {}, permissions: { canCreateAgents: false, canCreateSkills: false } });
    await db.insert(agentApiKeys).values({ agentId, companyId: targetCompanyId, name: "Existing fixture key", keyHash: randomUUID() });
    await db.insert(principalPermissionGrants).values({ companyId: targetCompanyId, principalType: "agent",
      principalId: agentId, permissionKey: "issues:read", scope: null });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "approval-fixture-user", source: "session",
        isInstanceAdmin: false, companyIds: [companyId] };
      next();
    });
    app.use("/api", routes.value.approvalRoutes(db));
    app.use(routes.value.errorHandler);
    const payload = { agentId, name: "Changed agent", adapterType: "process",
      adapterConfig: { command: "changed-command" }, budgetMonthlyCents: 0 };
    const created = await request(app).post(`/api/companies/${companyId}/approvals`).send({ type: "hire_agent", payload });
    expect(created.status).toBe(201);
    const snapshot = async () => ({
      agent: await db.select().from(agents).where(eq(agents.id, agentId)),
      keys: await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agentId)),
      grants: await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, agentId)),
    });
    return { app, companyId, agentId, approvalId: created.body.id as string, snapshot };
  }

  it.each([
    ["approve", "pending_approval", true, 404], ["reject", "pending_approval", true, 404],
    ["approve", "paused", true, 404], ["reject", "paused", true, 404],
    ["approve", "paused", false, 422], ["reject", "paused", false, 422],
    ["approve", "idle", false, 422], ["reject", "idle", false, 422],
  ] as const)("refuses %s for %s target (foreign=%s) without target or decision effects", async (decision, status, foreign, expectedStatus) => {
    const f = await fixture(status, foreign);
    const before = await f.snapshot();
    const response = await request(f.app).post(`/api/approvals/${f.approvalId}/${decision}`).send({});
    expect(response.status).toBe(expectedStatus);
    expect(await f.snapshot()).toEqual(before);
    const [stored] = await db.select().from(approvals).where(eq(approvals.id, f.approvalId));
    expect(stored).toMatchObject({ status: "pending", decidedAt: null, decidedByUserId: null });
    expect(wakeup).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(["approve", "reject"] as const)("resolves a legitimate pending hire with idempotent %s", async (decision) => {
    const f = await fixture("pending_approval", false);
    const first = await request(f.app).post(`/api/approvals/${f.approvalId}/${decision}`).send({});
    expect(first.status).toBe(200);
    const after = await f.snapshot();
    expect(after.agent[0]?.status).toBe(decision === "approve" ? "idle" : "terminated");
    if (decision === "reject") expect(after.keys[0]?.revokedAt).toBeInstanceOf(Date);
    const repeated = await request(f.app).post(`/api/approvals/${f.approvalId}/${decision}`).send({});
    expect(repeated.status).toBe(200);
    expect(await f.snapshot()).toEqual(after);
    expect(notify).toHaveBeenCalledTimes(decision === "approve" ? 1 : 0);
  });

  it("preserves the supported legacy no-target creation path", async () => {
    const f = await fixture("paused", false);
    const created = await request(f.app).post(`/api/companies/${f.companyId}/approvals`).send({
      type: "hire_agent", payload: { name: "Legacy hire", adapterType: "process", adapterConfig: { command: "true" } },
    });
    expect(created.status).toBe(201);
    const response = await request(f.app).post(`/api/approvals/${created.body.id}/approve`).send({});
    expect(response.status).toBe(200);
    const rows = await db.select().from(agents).where(eq(agents.companyId, f.companyId));
    expect(rows.find(row => row.name === "Legacy hire")?.status).toBe("idle");
  });
});
