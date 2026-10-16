/** Closed native subscription failures. Never classify model prose or tool text. */
export const NATIVE_PROVIDER_AUTH_OPERATOR_REQUIRED = "native_provider_auth_operator_required";
export const NATIVE_PROVIDER_AUTH_HOLD_MESSAGE =
  "Subscription access requires operator review. Automatic retries and replacement sessions are stopped. Verify worker retirement before explicitly admitting a new run.";
export type NativeProviderAuthHoldCode =
  | "codex_external_auth_operator_required"
  | "factory_claude_access_unverified";

const NATIVE_REASONS = new Set([
  "missing_source", "unsafe_source", "source_already_consumed", "malformed_capability",
  "oversize_capability", "source_timeout", "foreign_authority", "binding_mismatch",
  "expired_capability", "incompatible_provider", "conflicting_authentication",
  "unsafe_configuration", "refresh_required", "authentication_rejected", "identity_unverified",
  "provider_reflection", "provider_protocol", "provider_exited", "recovery_not_permitted",
  "conflicting_provider", "unsafe_startup_slots", "malformed_binding", "unverified_bootstrap",
  "unsupported_platform", "artifact_descriptor", "unsafe_descriptor_layout", "sidecar_rejected",
]);
const LOCAL_REASONS = new Set(["invalid_hold_metadata", "provider_terminal", "runner_exit_unverified"]);

export function isNativeProviderAuthHoldCode(value: unknown): value is NativeProviderAuthHoldCode {
  return value === "codex_external_auth_operator_required" || value === "factory_claude_access_unverified";
}

export class NativeProviderAuthHoldError extends Error {
  readonly code = NATIVE_PROVIDER_AUTH_OPERATOR_REQUIRED;
  readonly retryable = false;
  readonly operatorRequired = true;
  constructor(readonly providerHoldCode: NativeProviderAuthHoldCode, readonly reason: string) {
    super(NATIVE_PROVIDER_AUTH_HOLD_MESSAGE);
    if (!isNativeProviderAuthHoldCode(providerHoldCode) || (!NATIVE_REASONS.has(reason) && !LOCAL_REASONS.has(reason))) {
      throw new Error("Invalid native subscription hold metadata");
    }
    this.name = "NativeProviderAuthHoldError";
  }
}

/** Call only on the inner result of a durably authenticated runner command. */
export function nativeProviderAuthHoldFromResult(value: unknown): NativeProviderAuthHoldError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (!isNativeProviderAuthHoldCode(result.code)) return null;
  // A recognized auth code with malformed metadata still cannot authorize retry.
  const reason = result.retryable === false && result.operatorRequired === true
    && typeof result.reason === "string" && NATIVE_REASONS.has(result.reason)
    ? result.reason : "invalid_hold_metadata";
  return new NativeProviderAuthHoldError(result.code, reason);
}
