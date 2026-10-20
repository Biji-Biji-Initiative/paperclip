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
});
