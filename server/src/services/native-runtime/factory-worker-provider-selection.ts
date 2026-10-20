import type { FactoryAdmissionProvider } from "@paperclipai/adapter-utils/factory-provider-admission";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

export function isFactoryProviderEnrollment(value: unknown): value is {
  provider: FactoryAdmissionProvider; workerPlanSha256: string;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const mode = value as Record<string, unknown>;
  return Object.keys(mode).length === 2 && (mode.provider === "codex" || mode.provider === "claude") &&
    typeof mode.workerPlanSha256 === "string" && /^[a-f0-9]{64}$/.test(mode.workerPlanSha256);
}

/** The host authority accepts only the corresponding native subscription driver. */
export function factoryExecutionProvider(execution: Pick<NativeExecutionInput, "provider" | "session">): FactoryAdmissionProvider | undefined {
  if (execution.provider.kind === "codex" && execution.session.driverKind === "codex_app_server") return "codex";
  if (execution.provider.kind === "acpx" && execution.provider.agent === "claude" &&
      execution.session.driverKind === "acpx_runtime") return "claude";
  return undefined;
}
