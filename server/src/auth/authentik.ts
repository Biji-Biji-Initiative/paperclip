import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { activityLog, authAccounts, authUsers, companies, companyMemberships, instanceUserRoles, principalPermissionGrants, type Db } from "@paperclipai/db";
import { accessService } from "../services/access.js";

const KEYS = ["PAPERCLIP_AUTHENTIK_ISSUER", "PAPERCLIP_AUTHENTIK_CLIENT_ID", "PAPERCLIP_AUTHENTIK_CLIENT_SECRET", "PAPERCLIP_AUTHENTIK_COMPANY_ID"] as const;
export const AUTHENTIK_ADMIN_SCOPE = "factory_admin";
export const AUTHENTIK_ADMIN_CLAIM = "https://factory.mereka.io/claims/authorization";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function authentikConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const values = KEYS.map((key) => env[key]);
  const [issuerValue, clientId, clientSecret, companyValue] = values;
  const adminOption = env.PAPERCLIP_AUTHENTIK_ADMIN_CLAIM_ENABLED?.trim();
  const adminCompanies = env.PAPERCLIP_AUTHENTIK_ADMIN_COMPANY_IDS?.trim();
  if (!values.some((value) => value?.trim())) {
    if ((adminOption && adminOption !== "false") || adminCompanies) throw new Error("Authentik admin projection requires staff SSO configuration");
    if (env.PAPERCLIP_AUTHENTIK_REQUIRED === "true") throw new Error("Required staff SSO configuration is missing");
    return null;
  }
  if (!issuerValue?.trim() || !clientId?.trim() || !clientSecret?.trim() || !companyValue?.trim()) {
    throw new Error("Authentik requires issuer, client ID, client secret and company ID together");
  }
  let issuer: URL;
  try {
    issuer = new URL(issuerValue);
  } catch {
    throw new Error("Authentik issuer must be a canonical HTTPS URL");
  }
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new Error("Authentik issuer must be a canonical HTTPS URL");
  }
  const companyId = companyValue.trim();
  if (!UUID.test(companyId)) {
    throw new Error("Authentik company ID must be a UUID");
  }
  if (adminOption !== undefined && adminOption !== "true" && adminOption !== "false") {
    throw new Error("Authentik admin claim projection must be true or false");
  }
  const adminClaimEnabled = adminOption === "true";
  if (adminClaimEnabled !== Boolean(adminCompanies)) {
    throw new Error("Authentik admin claim projection requires enabled and company IDs together");
  }
  const adminCompanyIds = adminCompanies ? adminCompanies.split(",").map((id) => id.trim().toLowerCase()).sort() : [];
  if (adminCompanyIds.some((id) => !UUID.test(id)) || new Set(adminCompanyIds).size !== adminCompanyIds.length ||
      (adminClaimEnabled && !adminCompanyIds.includes(companyId.toLowerCase()))) {
    throw new Error("Authentik admin company IDs must be unique UUIDs including the staff company");
  }
  const recoveryOption = env.PAPERCLIP_AUTHENTIK_ALLOW_PASSWORD_LOGIN?.trim();
  if (recoveryOption !== undefined && recoveryOption !== "true" && recoveryOption !== "false") {
    throw new Error("Authentik password recovery override must be true or false");
  }
  const recoveryEmail = env.PAPERCLIP_AUTHENTIK_RECOVERY_EMAIL?.trim().toLowerCase();
  const recoveryUntil = Date.parse(env.PAPERCLIP_AUTHENTIK_RECOVERY_UNTIL ?? "");
  if (recoveryOption === "true" && (!recoveryEmail || !Number.isFinite(recoveryUntil) ||
      recoveryUntil > Date.now() + 3600_000)) {
    throw new Error("Password recovery requires one operator email and an expiry within one hour");
  }
  return {
    issuer: issuer.href.replace(/\/$/, "") + "/",
    clientId: clientId.trim(),
    clientSecret,
    companyId,
    adminClaimEnabled, adminCompanyIds,
    allowPasswordLogin: recoveryOption === "true" && recoveryUntil > Date.now(),
    recoveryEmail, recoveryUntil,
  };
}

/** Only a fresh, verified Authentik exchange may call this, never a browser header. */
export async function joinAuthentikCompany(db: Db, companyId: string, userId: string, verifiedEmail: string) {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(authUsers).where(eq(authUsers.id, userId));
    const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
    if (!user || user.email.toLowerCase() !== verifiedEmail.toLowerCase() || company?.status !== "active") {
      throw new APIError("FORBIDDEN", { code: "staff_company_unavailable", message: "Staff company access is unavailable" });
    }
    const inserted = await tx.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    }).onConflictDoNothing().returning({ id: companyMemberships.id });
    const [membership] = await tx.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId),
    )).for("update");
    if (membership?.status !== "active") {
      throw new APIError("FORBIDDEN", { code: "staff_membership_disabled", message: "Company membership is disabled" });
    }
    // Existing roles, suspensions and individually removed grants remain intact.
    if (inserted.length === 0) return;
    await tx.insert(principalPermissionGrants).values({
      companyId, principalType: "user", principalId: userId, permissionKey: "tasks:assign", grantedByUserId: null,
    }).onConflictDoNothing();
    await tx.insert(activityLog).values({
      companyId, actorType: "system", actorId: "authentik", action: "authentik.staff_joined",
      entityType: "user", entityId: userId, details: { membershipRole: "operator" },
    });
  });
}

/** Called only with the single-use receipt of a verified provider exchange. */
async function projectAuthentikAdmin(db: Db, companyIds: string[], auditCompanyId: string, userId: string, email: string, issuer: string, subject: string) {
  await db.transaction(async (tx) => {
    // Serialize callbacks for this existing user before testing/inserting its native role.
    await tx.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId)).for("update");
    // Native services use the transaction's query API; nested transactions are savepoints.
    const txDb = tx as unknown as Db;
    for (const companyId of companyIds) await joinAuthentikCompany(txDb, companyId, userId, email);
    const access = accessService(txDb);
    if (await access.isInstanceAdmin(userId)) return;
    const role = await access.promoteInstanceAdmin(userId, { source: "authentik", issuer, subject });
    await tx.insert(activityLog).values({
      companyId: auditCompanyId, actorType: "system", actorId: "authentik", action: "authentik.instance_admin_granted",
      entityType: "user", entityId: userId, responsibleUserId: userId,
      details: { roleId: role.id, claimVersion: 1, role: "instance_admin" },
    });
  });
}

/** Remove only an explicitly managed grant for this verified bound issuer/subject.
 * Unattributed historical rows, local appointments and company grants are retained.
 */
async function removeAuthentikAdmin(db: Db, auditCompanyId: string, userId: string, issuer: string, subject: string) {
  await db.transaction(async (tx) => {
    await tx.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId)).for("update");
    const [role] = await tx.select().from(instanceUserRoles).where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"))).for("update");
    const origin = role?.grantProvenance;
    if (origin?.source !== "authentik" || origin.issuer !== issuer || origin.subject !== subject) return;
    await tx.delete(instanceUserRoles).where(eq(instanceUserRoles.id, role.id));
    await tx.insert(activityLog).values({
      companyId: auditCompanyId, actorType: "system", actorId: "authentik", action: "authentik.instance_admin_removed",
      entityType: "user", entityId: userId, responsibleUserId: userId,
      details: { roleId: role.id, claimVersion: 1, role: "instance_admin", grantProvenance: origin },
    });
  });
}

export function authentikAuthOptions(db: Db, publicUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): BetterAuthOptions {
  const config = authentikConfiguration(env);
  if (!config) return {};
  if (!publicUrl || new URL(publicUrl).protocol !== "https:" || new URL(publicUrl).origin !== publicUrl.replace(/\/$/, "")) {
    throw new Error("Authentik requires an explicit canonical HTTPS application origin");
  }
  // Better Auth passes the same request-scoped endpoint context to identity
  // validation and DB hooks. This receipt cannot be supplied by the browser or
  // reused across requests; membership is granted before the session is issued.
  const verifiedContexts = new WeakMap<object, { email: string; userId?: string; subject: string; instanceAdmin: boolean | null }>();
  return {
    hooks: { before: createAuthMiddleware(async (context) => {
      if (context.path === "/sign-in/email" || context.path === "/sign-up/email") {
        const email = typeof context.body?.email === "string" ? context.body.email.trim().toLowerCase() : null;
        if (!config.allowPasswordLogin || Date.now() >= config.recoveryUntil ||
            email !== config.recoveryEmail) {
          throw new APIError("FORBIDDEN", { message: "Password recovery is unavailable for this identity" });
        }
      }
      if ((context.path === "/sign-in/social" || context.path === "/link-social") &&
          context.body?.provider === "authentik" && context.body?.idToken !== undefined) {
        throw new APIError("BAD_REQUEST", { message: "Staff SSO requires a fresh authorization-code exchange" });
      }
    }) },
    plugins: [genericOAuth({ config: [{
      providerId: "authentik", name: "Staff SSO", clientId: config.clientId, clientSecret: config.clientSecret,
      discoveryUrl: config.issuer + ".well-known/openid-configuration",
      requireIdTokenVerification: true,
      scopes: ["openid", "profile", "email", ...(config.adminClaimEnabled ? [AUTHENTIK_ADMIN_SCOPE] : [])], pkce: true,
      postLogoutRedirectURI: new URL("/auth", publicUrl).href,
    }] })],
    account: { encryptOAuthTokens: true, accountLinking: { disableImplicitLinking: true } },
    session: { expiresIn: 60 * 60, disableSessionRefresh: true },
    user: {
      validateUserInfo: ({ user, source }, context) => {
        if (source.oauth?.providerId !== "authentik") return;
        if (user.emailVerified !== true || typeof user.email !== "string" || !user.email.trim()) {
          return { error: "staff_email_unverified", errorDescription: "A verified staff email is required" };
        }
        const subject = source.oauth.profile?.sub;
        if (typeof subject !== "string" || !subject) return { error: "staff_subject_missing" };
        const claim = source.oauth.profile?.[AUTHENTIK_ADMIN_CLAIM];
        const instanceAdmin = config.adminClaimEnabled && typeof claim === "object" && claim !== null &&
          "v" in claim && claim.v === 1 && "instance_admin" in claim && typeof claim.instance_admin === "boolean"
          ? claim.instance_admin : null;
        verifiedContexts.set(context, { email: user.email, userId: user.id, subject, instanceAdmin });
      },
    },
    databaseHooks: {
      session: { create: { before: async (session, context) => {
        const receipt = context ? verifiedContexts.get(context) : undefined;
        if (context) verifiedContexts.delete(context);
        const staffCallback = context?.path === "/callback/authentik" ||
          (context?.path === "/callback/:id" && context.params?.id === "authentik");
        if (staffCallback && !receipt) {
          throw new APIError("FORBIDDEN", { message: "Verified staff identity receipt is required" });
        }
        if (receipt) {
          if (receipt.userId && receipt.userId !== session.userId) throw new APIError("FORBIDDEN", { message: "Staff identity mismatch" });
          const [account] = await db.select().from(authAccounts).where(and(
            eq(authAccounts.userId, session.userId), eq(authAccounts.providerId, "authentik"),
            eq(authAccounts.accountId, receipt.subject), eq(authAccounts.issuer, config.issuer),
          ));
          if (!account) throw new APIError("FORBIDDEN", { message: "Staff account binding is required" });
          if (receipt.instanceAdmin) {
            await projectAuthentikAdmin(db, config.adminCompanyIds, config.companyId, session.userId, receipt.email, config.issuer, receipt.subject);
          } else {
            // Missing/malformed/disabled scope claims cannot remove grants. Explicit false
            // removes only this directory-owned native role after membership admission.
            await db.transaction(async (tx) => {
              const txDb = tx as unknown as Db;
              await joinAuthentikCompany(txDb, config.companyId, session.userId, receipt.email);
              if (receipt.instanceAdmin === false) await removeAuthentikAdmin(txDb, config.companyId, session.userId, config.issuer, receipt.subject);
            });
          }
        }
      } } },
    },
  };
}
