import { expect, it } from "vitest";
import { NativeProviderAuthHoldError, nativeProviderAuthHoldFromResult } from "./native-provider-auth-hold.js";

it.each(["codex_external_auth_operator_required", "factory_claude_access_unverified"] as const)(
  "projects authenticated %s results to a fixed nonretry operator hold", (code) => {
    const hold = nativeProviderAuthHoldFromResult({ code, reason: "expired_capability", retryable: false,
      operatorRequired: true, message: "SYNTHETIC_PRIVATE_REFLECTION" });
    expect(hold).toBeInstanceOf(NativeProviderAuthHoldError);
    expect(hold).toMatchObject({ code: "native_provider_auth_operator_required", providerHoldCode: code,
      reason: "expired_capability", retryable: false, operatorRequired: true });
    expect(String(hold)).not.toContain("SYNTHETIC_PRIVATE_REFLECTION");
  },
);

it("does not promote prose or unknown error codes to native auth authority", () => {
  for (const value of [null, "codex_external_auth_operator_required:expired_capability",
    { code: "command_execution_failed", message: "factory_claude_access_unverified:expired_capability" },
    { code: "factory_claude_access_unverified_extra", retryable: false, operatorRequired: true }]) {
    expect(nativeProviderAuthHoldFromResult(value)).toBeNull();
  }
});

it("holds malformed native auth metadata without reflecting it or accepting retry", () => {
  const hold = nativeProviderAuthHoldFromResult({ code: "factory_claude_access_unverified",
    reason: "SYNTHETIC_PRIVATE_REFLECTION", retryable: true, operatorRequired: false });
  expect(hold).toMatchObject({ reason: "invalid_hold_metadata", retryable: false, operatorRequired: true });
  expect(JSON.stringify(hold)).not.toContain("SYNTHETIC_PRIVATE_REFLECTION");
});
