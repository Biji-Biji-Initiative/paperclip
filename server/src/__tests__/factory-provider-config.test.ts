import { describe, expect, it } from "vitest";
import { normalizeEnvironmentConfig, normalizeEnvironmentConfigForProbe, parseEnvironmentDriverConfig } from "../services/environment-config.js";

describe("explicit Factory provider enrollment", () => {
  const base = { host: "fixture.invalid", username: "node", remoteWorkspacePath: "/workspace/fixture" };
  const mode = { provider: "codex", workerPlanSha256: "a".repeat(64) };
  it.each(["codex", "claude"])("preserves absence and exact %s enrollment across config paths", provider => {
    expect(normalizeEnvironmentConfig({ driver: "ssh", config: base })).not.toHaveProperty("factoryProviderAdmission");
    const mode = { provider, workerPlanSha256: "a".repeat(64) };
    const config = { ...base, factoryWorkerPolicy: "factory-worker-scope-v2", factoryProviderAdmission: mode };
    for (const normalize of [normalizeEnvironmentConfig, normalizeEnvironmentConfigForProbe]) {
      expect(normalize({ driver: "ssh", config })).toMatchObject({ factoryProviderAdmission: mode });
    }
    expect(parseEnvironmentDriverConfig({ driver: "ssh", config })).toMatchObject({ config: { factoryProviderAdmission: mode } });
  });
  it("rejects missing enrollment, unknown provider/keys/hash and null", () => {
    for (const bad of [mode, { ...mode, provider: "claude_managed" }, { ...mode, provider: "anthropic" }, { ...mode, account: "untrusted" },
      { ...mode, workerPlanSha256: "invalid" }, null]) {
      const config = { ...base, ...(bad === mode ? {} : { factoryWorkerPolicy: "factory-worker-scope-v2" }), factoryProviderAdmission: bad };
      expect(() => normalizeEnvironmentConfig({ driver: "ssh", config })).toThrow();
      expect(() => normalizeEnvironmentConfigForProbe({ driver: "ssh", config })).toThrow();
    }
  });
  it("preserves explicit tenant identity on persistence, probe and runtime paths", () => {
    const mode = { schema: "factory.provider-enrollment.v3", provider: "claude", workerPlanSha256: "b".repeat(64),
      realm: { schema: "factory.worker-realm.v1", companyId: "a2b00000-0000-4000-8000-000000000001", authorityId: "factory-botak-g2" } };
    const config = { ...base, factoryWorkerPolicy: "factory-worker-scope-v3", factoryProviderAdmission: mode };
    for (const normalize of [normalizeEnvironmentConfig, normalizeEnvironmentConfigForProbe]) {
      expect(normalize({ driver: "ssh", config })).toMatchObject({ factoryProviderAdmission: mode });
      for (const realm of [{ ...mode.realm, companyId: "*" }, { ...mode.realm, authorityId: "*" },
        { schema: mode.realm.schema, companyId: mode.realm.companyId }]) {
        expect(() => normalize({ driver: "ssh", config: { ...config, factoryProviderAdmission: { ...mode, realm } } })).toThrow();
      }
    }
    expect(parseEnvironmentDriverConfig({ driver: "ssh", config })).toMatchObject({ config: { factoryProviderAdmission: mode } });
    for (const invalid of [
      { ...config, factoryWorkerPolicy: "factory-worker-scope-v2" },
      { ...config, factoryProviderAdmission: { provider: "claude", workerPlanSha256: mode.workerPlanSha256 } },
      { ...base, factoryWorkerPolicy: "factory-worker-scope-v3" },
    ]) expect(() => normalizeEnvironmentConfig({ driver: "ssh", config: invalid })).toThrow();
  });
});
