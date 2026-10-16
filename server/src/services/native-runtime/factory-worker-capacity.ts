import { and, eq, isNull } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { isFactoryWorkerBusyError } from "@paperclipai/adapter-utils/factory-worker-lease";

export const FACTORY_WORKER_BUSY = "factory_worker_busy";
export class FactoryWorkerCapacityDeferredError extends Error {
  constructor(readonly nextAttemptAt: Date) { super(FACTORY_WORKER_BUSY); }
}

export function hasFactoryBusyReceipt(coordinator: {
  failureCode: string | null; failureDetail: unknown; attempt: number;
}, runId: string): boolean {
  const detail = coordinator.failureDetail as Record<string, unknown> | null;
  return coordinator.failureCode === FACTORY_WORKER_BUSY && coordinator.attempt > 0 &&
    detail?.schema === "factory.worker.capacity.v1" && detail.runId === runId &&
    detail.attempt === coordinator.attempt && detail.dispatchAttempted === false &&
    detail.localOwnerReleased === true;
}

/** Reserve the same provider attempt after a proven non-dispatch. Never decrement it. */
export function factoryProviderAttempt(coordinator: {
  failureCode: string | null; failureDetail: unknown; attempt: number;
}, runId: string): number | undefined {
  return hasFactoryBusyReceipt(coordinator, runId) ? coordinator.attempt : undefined;
}

export async function deferFactoryWorkerCapacity(input: {
  db: Db; runId: string; companyId: string; issueId: string;
  leaseOwner: string; attempt: number; error: unknown; now?: Date;
}): Promise<FactoryWorkerCapacityDeferredError> {
  if (!isFactoryWorkerBusyError(input.error)) throw new Error("factory_worker_busy_unverified");
  const now = input.now ?? new Date();
  const nextAttemptAt = new Date(now.getTime() + 30_000);
  await input.db.transaction(async tx => {
    const run = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.status, "running"),
    )).for("update").then(rows => rows[0]);
    if (!run || run.processPid !== null || run.processGroupId !== null) throw new Error("factory_worker_capacity_binding_lost");
    const [updated] = await tx.update(nativeRunFinalizations).set({
      phase: "retryable_failure", failureCode: FACTORY_WORKER_BUSY,
      failureDetail: { schema: "factory.worker.capacity.v1", runId: input.runId,
        attempt: input.attempt, dispatchAttempted: false, localOwnerReleased: true },
      nextAttemptAt, leaseOwner: null, leaseExpiresAt: null, controlDeadlineAt: null, updatedAt: now,
    }).where(and(
      eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.companyId, input.companyId),
      eq(nativeRunFinalizations.issueId, input.issueId), eq(nativeRunFinalizations.phase, "observed"),
      eq(nativeRunFinalizations.leaseOwner, input.leaseOwner), eq(nativeRunFinalizations.attempt, input.attempt),
      isNull(nativeRunFinalizations.resultId),
    )).returning({ id: nativeRunFinalizations.runId });
    if (!updated) throw new Error("factory_worker_capacity_binding_lost");
    await tx.update(heartbeatRuns).set({ nativePhase: "retryable_failure", nativePhaseUpdatedAt: now,
      executionControlDeadlineAt: null, updatedAt: now }).where(eq(heartbeatRuns.id, input.runId));
  });
  return new FactoryWorkerCapacityDeferredError(nextAttemptAt);
}
