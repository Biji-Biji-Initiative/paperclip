import { describe, expect, it } from "vitest";
import {
  LEGACY_FACTORY_COMPANY_ID, factoryEnrollmentMatchesCompany, factoryProviderEnrollmentSchema,
  sameFactoryProviderEnrollment,
  factoryEnrollmentMatchesPolicy, factoryWorkerScopeMatchesCompany,
} from "@paperclipai/shared/factory-worker-realm";

const botak = "a2b00000-0000-4000-8000-000000000001";
const mereka = "a2b00000-0000-4000-8000-000000000002";
const legacy = { provider: "codex", workerPlanSha256: "a".repeat(64) };
const tenant = { ...legacy, schema: "factory.provider-enrollment.v3",
  realm: { schema: "factory.worker-realm.v1", companyId: botak, authorityId: "factory-botak-g2" } };

describe("explicit Factory worker realms", () => {
  it("never downgrades a realm to legacy policy or admits an unenrolled v3 scope", () => {
    expect(factoryEnrollmentMatchesPolicy(tenant, "factory-worker-scope-v3")).toBe(true);
    expect(factoryEnrollmentMatchesPolicy(tenant, "factory-worker-scope-v2")).toBe(false);
    expect(factoryEnrollmentMatchesPolicy(legacy, "factory-worker-scope-v3")).toBe(false);
    expect(factoryEnrollmentMatchesPolicy(undefined, "factory-worker-scope-v3")).toBe(false);
    expect(factoryWorkerScopeMatchesCompany("factory-worker-scope-v3", tenant, botak)).toBe(true);
    expect(factoryWorkerScopeMatchesCompany("factory-worker-scope-v3", tenant, mereka)).toBe(false);
    expect(factoryWorkerScopeMatchesCompany("factory-worker-scope-v2", undefined, botak)).toBe(false);
    expect(factoryWorkerScopeMatchesCompany("factory-worker-scope-v2", undefined, LEGACY_FACTORY_COMPANY_ID)).toBe(true);
  });
  it("retains the legacy shape only for its original company", () => {
    const parsed = factoryProviderEnrollmentSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(factoryEnrollmentMatchesCompany(parsed, LEGACY_FACTORY_COMPANY_ID)).toBe(true);
    expect(factoryEnrollmentMatchesCompany(parsed, botak)).toBe(false);
    expect(factoryEnrollmentMatchesCompany(parsed, mereka)).toBe(false);
  });

  it("binds a versioned enrollment to exactly one company and authority", () => {
    const parsed = factoryProviderEnrollmentSchema.parse(tenant);
    expect(factoryEnrollmentMatchesCompany(parsed, botak)).toBe(true);
    expect(factoryEnrollmentMatchesCompany(parsed, mereka)).toBe(false);
    expect(factoryEnrollmentMatchesCompany(parsed, LEGACY_FACTORY_COMPANY_ID)).toBe(false);
    expect(sameFactoryProviderEnrollment(parsed, factoryProviderEnrollmentSchema.parse(tenant))).toBe(true);
    for (const changed of [
      { ...tenant, realm: { ...tenant.realm, companyId: mereka } },
      { ...tenant, realm: { ...tenant.realm, authorityId: "factory-mereka-g2" } },
      { ...tenant, workerPlanSha256: "b".repeat(64) },
      { ...tenant, provider: "claude" }, legacy,
    ]) expect(sameFactoryProviderEnrollment(parsed, factoryProviderEnrollmentSchema.parse(changed))).toBe(false);
  });

  it("refuses unknown fields, wildcard companies, missing identity and profile selection", () => {
    for (const value of [
      { ...tenant, schema: "factory.provider-enrollment.v4" },
      { ...tenant, realm: { ...tenant.realm, companyId: "*" } },
      { ...tenant, realm: { ...tenant.realm, companyId: [botak, mereka] } },
      { ...tenant, realm: { ...tenant.realm, authorityId: "*" } },
      { ...tenant, realm: { schema: tenant.realm.schema, companyId: botak } },
      { ...tenant, realm: { ...tenant.realm, profile: "other-staff" } },
      { ...tenant, canonicalProfile: "g2t" },
    ]) expect(factoryProviderEnrollmentSchema.safeParse(value).success).toBe(false);
  });
});
