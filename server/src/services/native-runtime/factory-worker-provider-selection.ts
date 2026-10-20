import type { FactoryAdmissionProvider } from "@paperclipai/adapter-utils/factory-provider-admission";
import { factoryProviderEnrollmentSchema, type FactoryProviderEnrollment } from "@paperclipai/shared/factory-worker-realm";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

export function isFactoryProviderEnrollment(value: unknown): value is FactoryProviderEnrollment {
  return factoryProviderEnrollmentSchema.safeParse(value).success;
}

/** The host authority accepts only the corresponding native subscription driver. */
export function factoryExecutionProvider(execution: Pick<NativeExecutionInput, "provider" | "session">): FactoryAdmissionProvider | undefined {
  if (execution.provider.kind === "codex" && execution.session.driverKind === "codex_app_server") return "codex";
  if (execution.provider.kind === "acpx" && execution.provider.agent === "claude" &&
      execution.session.driverKind === "acpx_runtime") return "claude";
  return undefined;
}
