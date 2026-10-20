import { describe, expect, it } from "vitest";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { factoryExecutionProvider, isFactoryProviderEnrollment } from "./factory-worker-provider-selection.js";

describe("Factory subscription provider selection", () => {
  it("accepts only explicit provider and immutable plan enrollment", () => {
    for (const provider of ["codex", "claude"]) {
      const mode = { provider, workerPlanSha256: "a".repeat(64) };
      expect(isFactoryProviderEnrollment(mode)).toBe(true);
      expect(isFactoryProviderEnrollment({ ...mode, account: "arbitrary" })).toBe(false);
      expect(isFactoryProviderEnrollment({ ...mode, workerPlanSha256: "invalid" })).toBe(false);
    }
    for (const value of [undefined, null, [], {}, { provider: "claude_managed", workerPlanSha256: "a".repeat(64) }]) {
      expect(isFactoryProviderEnrollment(value)).toBe(false);
    }
  });
  it("recognizes the versioned realm without admitting absent or wildcard identity", () => {
    const mode = { schema: "factory.provider-enrollment.v3", provider: "codex", workerPlanSha256: "a".repeat(64),
      realm: { schema: "factory.worker-realm.v1", companyId: "a2b00000-0000-4000-8000-000000000001", authorityId: "factory-botak-g2" } };
    expect(isFactoryProviderEnrollment(mode)).toBe(true);
    expect(isFactoryProviderEnrollment({ ...mode, realm: undefined })).toBe(false);
    expect(isFactoryProviderEnrollment({ ...mode, realm: { ...mode.realm, companyId: "*" } })).toBe(false);
    expect(isFactoryProviderEnrollment({ ...mode, canonicalProfile: "other-staff" })).toBe(false);
  });
  it("requires the provider's corresponding native driver", () => {
    const selected = (provider: unknown, driverKind: string) => factoryExecutionProvider({ provider,
      session: { driverKind } } as Pick<NativeExecutionInput, "provider" | "session">);
    expect(selected({ kind: "codex" }, "codex_app_server")).toBe("codex");
    expect(selected({ kind: "acpx", agent: "claude" }, "acpx_runtime")).toBe("claude");
    for (const [provider, driver] of [
      [{ kind: "codex" }, "acpx_runtime"], [{ kind: "acpx", agent: "claude" }, "codex_app_server"],
      [{ kind: "acpx", agent: "codex" }, "acpx_runtime"], [{ kind: "opencode" }, "opencode"],
      [{ kind: "claude_managed" }, "acpx_runtime"],
    ] as const) expect(selected(provider, driver)).toBeUndefined();
  });
});
