import { z } from "zod";

/** Compatibility identity for the original, unversioned Factory enrollment. */
export const LEGACY_FACTORY_COMPANY_ID = "740ad7ee-0c28-4e07-b9d1-ca7b35da820d";

const companyIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const authorityIdSchema = z.string().regex(/^[A-Za-z0-9_.:@+-]{1,128}$/);
const provider = z.enum(["codex", "claude"]);
const workerPlanSha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Public identity only. Registration never supplies credentials or grants execution. */
export const factoryWorkerRealmSchema = z.object({
  schema: z.literal("factory.worker-realm.v1"),
  companyId: companyIdSchema,
  authorityId: authorityIdSchema,
}).strict();

export const factoryProviderEnrollmentSchema = z.union([
  z.object({ provider, workerPlanSha256 }).strict(),
  z.object({
    schema: z.literal("factory.provider-enrollment.v3"),
    provider,
    workerPlanSha256,
    realm: factoryWorkerRealmSchema,
  }).strict(),
]);

export type FactoryWorkerRealm = z.infer<typeof factoryWorkerRealmSchema>;
export type FactoryProviderEnrollment = z.infer<typeof factoryProviderEnrollmentSchema>;

/** Environments are instance-wide; their selected realm must match the DB company. */
export function factoryEnrollmentMatchesCompany(enrollment: FactoryProviderEnrollment, companyId: string): boolean {
  if (!companyIdSchema.safeParse(companyId).success) return false;
  return "realm" in enrollment
    ? enrollment.realm.companyId === companyId
    : companyId === LEGACY_FACTORY_COMPANY_ID;
}

export function sameFactoryProviderEnrollment(left: FactoryProviderEnrollment, right: FactoryProviderEnrollment): boolean {
  if (left.provider !== right.provider || left.workerPlanSha256 !== right.workerPlanSha256) return false;
  if ("realm" in left) {
    return "realm" in right && left.realm.companyId === right.realm.companyId
      && left.realm.authorityId === right.realm.authorityId;
  }
  return !("realm" in right);
}
