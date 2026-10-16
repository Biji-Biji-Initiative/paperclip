import { unprocessable } from "../errors.js";

/** Operator-owned deployment setting; absent preserves upstream behavior. */
export function subscriptionsOnly(): boolean {
  const value = process.env.PAPERCLIP_AI_BILLING_POLICY;
  if (value === undefined || value === "") return false;
  if (value !== "subscriptions_only") throw unprocessable("The operator AI billing policy is invalid", { code: "ai_billing_policy_invalid" });
  return true;
}

/** Call with resolved account metadata, never a responsible-user method hint. */
export function assertAiBillingMethod(method: unknown): void {
  if (subscriptionsOnly() && method !== "subscription") {
    throw unprocessable("This instance allows subscription AI accounts only", { code: "ai_subscription_required" });
  }
}

export function assertAiBillingRuntime(input: {
  managedConnectionSelected: boolean;
  protectedSubscription?: boolean;
  protectedWorkerSelected?: boolean;
}): void {
  if (subscriptionsOnly() && input.protectedWorkerSelected && input.managedConnectionSelected) {
    throw unprocessable("The protected worker uses its host subscription authority; remove stored AI account binding", { code: "ai_protected_subscription_binding_conflict" });
  }
  if (subscriptionsOnly() && !input.managedConnectionSelected && !input.protectedSubscription) {
    throw unprocessable("Select an approved subscription account or protected subscription worker", { code: "ai_subscription_required" });
  }
}

/** The runtime owns this call site; denied policy never invokes credential preparation. */
export function prepareAiBillingRuntime<T>(input: Parameters<typeof assertAiBillingRuntime>[0], prepare: () => T): T {
  assertAiBillingRuntime(input);
  return prepare();
}

/** Reject explicit provider auth before resolving any corresponding secret refs. */
export function assertProtectedSubscriptionConfig(...environments: unknown[]): void {
  if (!subscriptionsOnly()) return;
  for (const environment of environments) {
    if (!environment || typeof environment !== "object") continue;
    for (const [key, value] of Object.entries(environment)) {
      if (value !== undefined && value !== null && value !== "" &&
          (/^(?:OPENAI|CODEX|ANTHROPIC|CLAUDE|OPENROUTER|XAI|GROK|GEMINI|GOOGLE|ZAI)_(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|BASE_URL|API_BASE|CONFIG_DIR|HOME)$/.test(key) ||
            ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
              "OPENCODE_AUTH_JSON", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "PAPERCLIP_OPENCODE_PROVIDERS"].includes(key))) {
        throw unprocessable("Provider credential overrides are forbidden for the protected subscription worker", { code: "ai_subscription_required" });
      }
    }
  }
}
