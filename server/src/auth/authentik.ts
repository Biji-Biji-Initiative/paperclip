import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { activityLog, authAccounts, authUsers, companies, companyMemberships, principalPermissionGrants, type Db } from "@paperclipai/db";

const KEYS = ["PAPERCLIP_AUTHENTIK_ISSUER", "PAPERCLIP_AUTHENTIK_CLIENT_ID", "PAPERCLIP_AUTHENTIK_CLIENT_SECRET", "PAPERCLIP_AUTHENTIK_COMPANY_ID"] as const;

export function authentikConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const values = KEYS.map((key) => env[key]);
  const [issuerValue, clientId, clientSecret, companyValue] = values;
  if (!values.some((value) => value?.trim())) {
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
    throw new Error("Authentik company ID must be a UUID");
  }
  const recoveryOption = env.PAPERCLIP_AUTHENTIK_ALLOW_PASSWORD_LOGIN?.trim();
  if (recoveryOption !== undefined && recoveryOption !== "true" && recoveryOption !== "false") {
    throw new Error("Authentik password recovery override must be true or false");
  }
  const recoveryEmail = env.PAPERCLIP_AUTHENTIK_RECOVERY_EMAIL?.trim().toLowerCase();
  const recoveryUntil = Date.parse(env.PAPERCLIP_AUTHENTIK_RECOVERY_UNTIL ?? "");
  if (recoveryOption === "true" && (!recoveryEmail || !Number.isFinite(recoveryUntil) ||
      recoveryUntil <= Date.now() || recoveryUntil > Date.now() + 3600_000)) {
    throw new Error("Password recovery requires one operator email and an expiry within one hour");
  }
  return {
    issuer: issuer.href.replace(/\/$/, "") + "/",
    clientId: clientId.trim(),
    clientSecret,
    companyId,
    allowPasswordLogin: recoveryOption === "true",
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

export function authentikAuthOptions(db: Db, publicUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): BetterAuthOptions {
  const config = authentikConfiguration(env);
  if (!config) return {};
  if (!publicUrl || new URL(publicUrl).protocol !== "https:" || new URL(publicUrl).origin !== publicUrl.replace(/\/$/, "")) {
    throw new Error("Authentik requires an explicit canonical HTTPS application origin");
  }
  // Better Auth passes the same request-scoped endpoint context to identity
  // validation and DB hooks. This receipt cannot be supplied by the browser or
  // reused across requests; membership is granted before the session is issued.
  const verifiedContexts = new WeakMap<object, { email: string; userId?: string; subject: string }>();
  return {
    hooks: { before: createAuthMiddleware(async (context) => {
      if (context.path === "/sign-in/email" || context.path === "/sign-up/email") {
        if (!config.allowPasswordLogin || Date.now() >= config.recoveryUntil ||
            context.body?.email?.trim().toLowerCase() !== config.recoveryEmail) {
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
      requireIdTokenVerification: true, scopes: ["openid", "profile", "email"], pkce: true,
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
        verifiedContexts.set(context, { email: user.email, userId: user.id, subject });
      },
    },
    databaseHooks: {
      session: { create: { before: async (session, context) => {
        const receipt = context ? verifiedContexts.get(context) : undefined;
        if (context) verifiedContexts.delete(context);
        if (context?.path === "/callback/authentik" && !receipt) {
          throw new APIError("FORBIDDEN", { message: "Verified staff identity receipt is required" });
        }
        if (receipt) {
          if (receipt.userId && receipt.userId !== session.userId) throw new APIError("FORBIDDEN", { message: "Staff identity mismatch" });
          const [account] = await db.select().from(authAccounts).where(and(
            eq(authAccounts.userId, session.userId), eq(authAccounts.providerId, "authentik"),
            eq(authAccounts.accountId, receipt.subject),
          ));
          if (!account) throw new APIError("FORBIDDEN", { message: "Staff account binding is required" });
          await joinAuthentikCompany(db, config.companyId, session.userId, receipt.email);
        }
      } } },
    },
  };
}
