import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, environments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("retries issue prefix allocation when Drizzle wraps the unique constraint error", async () => {
    await db.insert(companies).values({
      name: "Mereka",
      issuePrefix: "MER",
    });

    const created = await companyService(db).create({
      name: "Mereka LMS",
    });

    expect(created.name).toBe("Mereka LMS");
    expect(created.issuePrefix).toBe("MERA");

    const localEnvironments = await db
      .select()
      .from(environments)
      .where(eq(environments.companyId, created.id));
    expect(localEnvironments).toHaveLength(1);
  });
});
