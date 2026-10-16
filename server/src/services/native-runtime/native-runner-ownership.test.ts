import { describe, expect, it } from "vitest";
import {
  isNativeRunnerOwnershipHeld,
  NativeRunnerOwnershipUnverifiedError,
  FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE,
  NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
  requiresDurableNativeOwnershipHold,
} from "./native-runner-ownership.js";

describe("durable native runner ownership hold", () => {
  it.each([
    "adopted_runner_authentication_timeout",
    "native_chat_workspace_scope_mismatch",
    "ssh_foreground_ownership_unverified",
    "factory_workspace_staging_unverified",
  ] as const)("persists %s independently of local process observations", (reason) => {
    expect(requiresDurableNativeOwnershipHold(reason)).toBe(true);
  });
  it.each(["live_process_identifier", "observed_owner_unverified"] as const)(
    "keeps local observation %s eligible for process reconciliation",
    (reason) => expect(requiresDurableNativeOwnershipHold(reason)).toBe(false),
  );
  const held = {
    runtimeMode: "native",
    status: "running",
    nativePhase: "terminal_failure",
    errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
  };
  it("retains the authentication hold through process absence and coordinator expiry", () => {
    expect(isNativeRunnerOwnershipHeld(held)).toBe(true);
    expect(
      isNativeRunnerOwnershipHeld({
        ...held,
        nativePhase: "observed",
        errorCode: "native_adopted_runner_authentication_timeout",
      }),
    ).toBe(true);
  });
  it("distinguishes a Factory pre-admission hold from generic native uncertainty", () => {
    expect(new NativeRunnerOwnershipUnverifiedError("factory_workspace_staging_unverified").message)
      .toBe(FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE);
    for (const runtimeMode of ["legacy", "native", null, undefined]) {
      expect(isNativeRunnerOwnershipHeld({ ...held, runtimeMode, errorCode: FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE })).toBe(true);
    }
    expect(isNativeRunnerOwnershipHeld({ ...held, runtimeMode: "legacy", nativePhase: "observed",
      errorCode: FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE })).toBe(false);
    expect(isNativeRunnerOwnershipHeld({ ...held, runtimeMode: "legacy", status: "cancelled",
      errorCode: FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE })).toBe(false);
  });
  it.each([
    { runtimeMode: "legacy" },
    { status: "failed" },
    { status: "succeeded" },
    { nativePhase: "observed" },
    { nativePhase: "retryable_failure" },
    { errorCode: "native_session_retry_exhausted" },
  ])("does not change ordinary or resolved recovery: %j", (override) => {
    expect(isNativeRunnerOwnershipHeld({ ...held, ...override })).toBe(false);
  });
});
