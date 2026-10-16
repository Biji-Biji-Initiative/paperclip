import { describe, expect, it } from "vitest";
import {
  isNativeRunnerOwnershipHeld,
  NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
  requiresDurableNativeOwnershipHold,
} from "./native-runner-ownership.js";

describe("durable native runner ownership hold", () => {
  it.each([
    "adopted_runner_authentication_timeout",
    "native_chat_workspace_scope_mismatch",
    "ssh_foreground_ownership_unverified",
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
