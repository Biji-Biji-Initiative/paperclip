import { describe, expect, it } from "vitest";
import { normalizeEnvironmentConfig, normalizeEnvironmentConfigForProbe, parseEnvironmentDriverConfig } from "../services/environment-config.js";

describe("explicit Factory provider enrollment", () => {
  const base = { host: "fixture.invalid", username: "node", remoteWorkspacePath: "/workspace/fixture" };
  const mode = { provider: "codex", workerPlanSha256: "a".repeat(64) };
  it("preserves absence and the exact registered mode across config paths", () => {
    expect(normalizeEnvironmentConfig({ driver: "ssh", config: base })).not.toHaveProperty("factoryProviderAdmission");
    const config = { ...base, factoryWorkerPolicy: "factory-worker-scope-v2", factoryProviderAdmission: mode };
    for (const normalize of [normalizeEnvironmentConfig, normalizeEnvironmentConfigForProbe]) {
      expect(normalize({ driver: "ssh", config })).toMatchObject({ factoryProviderAdmission: mode });
    }
    expect(parseEnvironmentDriverConfig({ driver: "ssh", config })).toMatchObject({ config: { factoryProviderAdmission: mode } });
  });
  it("rejects missing enrollment, unknown provider/keys/hash and null", () => {
    for (const bad of [mode, { ...mode, provider: "claude" }, { ...mode, account: "untrusted" },
      { ...mode, workerPlanSha256: "invalid" }, null]) {
      const config = { ...base, ...(bad === mode ? {} : { factoryWorkerPolicy: "factory-worker-scope-v2" }), factoryProviderAdmission: bad };
      expect(() => normalizeEnvironmentConfig({ driver: "ssh", config })).toThrow();
      expect(() => normalizeEnvironmentConfigForProbe({ driver: "ssh", config })).toThrow();
    }
  });
});
