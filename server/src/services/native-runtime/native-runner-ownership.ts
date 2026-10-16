import { heartbeatRuns } from "@paperclipai/db";
import { sql } from "drizzle-orm";

export const NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE =
  "native_execution_ownership_unverified";
export const FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE =
  "factory_workspace_staging_unverified";
export const NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT =
  "native_adopted_runner_authentication_timeout";

/** An unauthenticated retained process is not evidence that execution stopped. */
export class NativeRunnerOwnershipUnverifiedError extends Error {
  constructor(
    readonly reason:
      | "adopted_runner_authentication_timeout"
      | "ssh_foreground_ownership_unverified"
      | "factory_workspace_staging_unverified"
      | "native_chat_workspace_scope_mismatch" = "adopted_runner_authentication_timeout",
  ) {
    super(reason === "factory_workspace_staging_unverified"
      ? FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE : NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE);
    this.name = "NativeRunnerOwnershipUnverifiedError";
  }
}

/** Transport uncertainty must survive a reaper finding no local process. */
export function requiresDurableNativeOwnershipHold(
  reason: NativeRunnerOwnershipUnverifiedError["reason"]
    | "live_process_identifier"
    | "observed_owner_unverified",
): boolean {
  return reason !== "live_process_identifier" && reason !== "observed_owner_unverified";
}

export function isNativeRunnerOwnershipHeld(run: {
  runtimeMode?: string | null;
  status?: string | null;
  errorCode?: string | null;
  nativePhase?: string | null;
}): boolean {
  return run.status === "running" && (
    (run.errorCode === FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE && run.nativePhase === "terminal_failure") ||
    (run.runtimeMode === "native" && (
      (run.errorCode === NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE && run.nativePhase === "terminal_failure") ||
      run.errorCode === NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT
    ))
  );
}

/** Null-safe database counterpart, evaluated atomically by claims and writes. */
export function nativeRunnerOwnershipNotHeldCondition() {
  return sql`not coalesce(
    ${heartbeatRuns.status} = 'running' and (
      (${heartbeatRuns.errorCode} = ${FACTORY_WORKSPACE_STAGING_UNVERIFIED_ERROR_CODE}
        and ${heartbeatRuns.nativePhase} = 'terminal_failure')
      or (${heartbeatRuns.runtimeMode} = 'native' and (
        (${heartbeatRuns.errorCode} = ${NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE}
          and ${heartbeatRuns.nativePhase} = 'terminal_failure')
        or ${heartbeatRuns.errorCode} = ${NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT}
      ))
    ), false
  )`;
}
