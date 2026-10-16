import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAiBillingMethod, assertAiBillingRuntime, assertProtectedSubscriptionConfig, prepareAiBillingRuntime, subscriptionsOnly } from "./ai-billing-policy.js";

afterEach(() => vi.unstubAllEnvs());

describe("operator subscription-only billing policy", () => {
  it("preserves upstream behavior when not configured", () => {
    vi.stubEnv("PAPERCLIP_AI_BILLING_POLICY", undefined);
    expect(subscriptionsOnly()).toBe(false);
    expect(() => assertAiBillingMethod("api_key")).not.toThrow();
    expect(() => assertAiBillingRuntime({ managedConnectionSelected: false })).not.toThrow();
  });
  it("requires actual subscription metadata and rejects unknown operator values", () => {
    vi.stubEnv("PAPERCLIP_AI_BILLING_POLICY", "subscriptions_only");
    expect(() => assertAiBillingMethod("subscription")).not.toThrow();
    for (const method of ["api_key", "subscription-fallback", undefined, null]) {
      expect(() => assertAiBillingMethod(method)).toThrow();
    }
    vi.stubEnv("PAPERCLIP_AI_BILLING_POLICY", "subscriptions_onyl");
    expect(() => assertAiBillingMethod("subscription")).toThrow();
  });
  it("denies unmanaged runtimes and direct credential overrides before materialization", () => {
    vi.stubEnv("PAPERCLIP_AI_BILLING_POLICY", "subscriptions_only");
    const prepare = vi.fn();
    const run = (method: unknown) => { assertAiBillingMethod(method); prepare(); };
    expect(() => run("api_key")).toThrow();
    expect(prepare).not.toHaveBeenCalled();
    expect(() => assertAiBillingRuntime({ managedConnectionSelected: false })).toThrow();
    expect(() => assertAiBillingRuntime({ managedConnectionSelected: true })).not.toThrow();
    expect(() => assertAiBillingRuntime({ managedConnectionSelected: false, protectedSubscription: true })).not.toThrow();
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "CODEX_HOME", "OPENAI_BASE_URL"]) {
      expect(() => assertProtectedSubscriptionConfig({ [key]: { type: "secret_ref", secretId: "synthetic-not-read" } })).toThrow();
    }
    expect(() => assertProtectedSubscriptionConfig({ PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: "bootstrap-not-a-provider-token" })).not.toThrow();
  });
  it("holds protected workers with stored subscription bindings before copying an auth home", () => {
    vi.stubEnv("PAPERCLIP_AI_BILLING_POLICY", "subscriptions_only");
    const prepareManaged = vi.fn();
    const run = () => prepareAiBillingRuntime({ managedConnectionSelected: true, protectedWorkerSelected: true,
      protectedSubscription: true }, prepareManaged);
    expect(run).toThrow();
    expect(prepareManaged).not.toHaveBeenCalled();
  });
});
