import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { authAccounts, authSessions, authUsers, companies, companyMemberships, createDb, instanceUserRoles, principalPermissionGrants } from "@paperclipai/db";
import { authentikConfiguration } from "../auth/authentik.js";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const issuer = "https://authentik.fixture/application/o/factory/";
const origin = "https://factory.fixture";
const companyId = "0da2d522-a3c2-4658-87e9-c089698fc111";
const settings = { PAPERCLIP_AUTHENTIK_ISSUER: issuer, PAPERCLIP_AUTHENTIK_CLIENT_ID: "factory-fixture",
  PAPERCLIP_AUTHENTIK_CLIENT_SECRET: "test-fixture-not-a-real-secret", PAPERCLIP_AUTHENTIK_COMPANY_ID: companyId };

describe("Authentik configuration", () => {
  it("is opt-in and rejects partial or unsafe configuration", () => {
    expect(authentikConfiguration({})).toBeNull();
    expect(() => authentikConfiguration({ PAPERCLIP_AUTHENTIK_CLIENT_ID: "partial" })).toThrow(/together/);
    for (const url of ["http://authentik.fixture/", "https://user:password@authentik.fixture/", issuer + "?query=1"]) {
      expect(() => authentikConfiguration({ ...settings, PAPERCLIP_AUTHENTIK_ISSUER: url })).toThrow(/HTTPS/);
    }
    expect(() => authentikConfiguration({ ...settings, PAPERCLIP_AUTHENTIK_COMPANY_ID: "missing" })).toThrow(/UUID/);
    expect(authentikConfiguration(settings)?.allowPasswordLogin).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Authentik with real auth library and migrated PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let auth: ReturnType<typeof createBetterAuthInstance>;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" };
  let callbackNonce = "";
  function tokenFor(email: string, verified = true, extra: Record<string, unknown> = {}) {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-key" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: "factory-fixture", sub: email, email,
      email_verified: verified, name: "Fixture Staff", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+120, ...extra })).toString("base64url");
    const data = header + "." + claims;
    return data + "." + sign("RSA-SHA256", Buffer.from(data), keys.privateKey).toString("base64url");
  }
  async function login(email: string, verified = true, extra: Record<string, unknown> = {}) {
    const token = tokenFor(email, verified, extra);
    return auth.handler(new Request(origin + "/api/auth/sign-in/social", { method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ provider: "authentik", idToken: { token }, callbackURL: "/" }) }));
  }
  beforeAll(async () => {
    for (const [key, value] of Object.entries(settings)) vi.stubEnv(key, value);
    vi.stubEnv("BETTER_AUTH_SECRET", "authentik-integration-fixture-secret-not-for-deployment");
    vi.stubEnv("PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "false");
    vi.stubGlobal("fetch", vi.fn(async (input: Request | URL | string) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === issuer + ".well-known/openid-configuration") return Response.json({ issuer,
        authorization_endpoint: issuer + "authorize", token_endpoint: issuer + "token", userinfo_endpoint: issuer + "userinfo",
        jwks_uri: issuer + "jwks", end_session_endpoint: issuer + "end-session", id_token_signing_alg_values_supported: ["RS256"], response_types_supported: ["code"] });
      if (url === issuer + "token") return Response.json({ access_token: "fixture-access", token_type: "Bearer", expires_in: 120,
        id_token: tokenFor("code-flow@mereka.my", true, { nonce: callbackNonce }) });
      if (url === issuer + "jwks") return Response.json({ keys: [jwk] });
      throw new Error("Unexpected fixture network request");
    }));
    database = await startEmbeddedPostgresTestDatabase("paperclip-authentik-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Factory fixture", issuePrefix: "SSO" });
    auth = createBetterAuthInstance(db, { deploymentMode: "authenticated", deploymentExposure: "public",
      authBaseUrlMode: "explicit", authPublicBaseUrl: origin, authDisableSignUp: true } as Config, [origin]);
  }, 60_000);
  afterAll(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await database?.cleanup(); });
  it("issues verified staff sessions with operator membership and no instance admin", async () => {
    expect((await login("miranda@mereka.my")).status).toBe(200);
    const [user] = await db.select().from(authUsers).where(eq(authUsers.email, "miranda@mereka.my"));
    expect(await db.select().from(companyMemberships)).toMatchObject([{ companyId, principalId: user.id, membershipRole: "operator", status: "active" }]);
    expect(await db.select().from(instanceUserRoles)).toHaveLength(0);
    expect(await db.select().from(principalPermissionGrants)).toMatchObject([{ principalId: user.id, permissionKey: "tasks:assign" }]);
    const [session] = await db.select().from(authSessions).where(eq(authSessions.userId, user.id));
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeLessThanOrEqual(3600_000);
    expect((await login("miranda@mereka.my")).status).toBe(200);
    expect(await db.select().from(companyMemberships)).toHaveLength(1);
  });
  it("rejects unverified identities and wrong issuers/audiences before granting access", async () => {
    for (const [email, verified, claims] of [["unverified@mereka.my", false, {}], ["wrong-issuer@mereka.my", true, { iss: "https://wrong.fixture/" }], ["wrong-audience@mereka.my", true, { aud: "another-app" }]] as const) {
      expect((await login(email, verified, claims)).status).toBeGreaterThanOrEqual(400);
      expect(await db.select().from(authUsers).where(eq(authUsers.email, email))).toHaveLength(0);
    }
  });
  it("completes the code flow with PKCE/nonce and invalidates the session on logout", async () => {
    const start = await auth.handler(new Request(origin + "/api/auth/sign-in/social", { method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ provider: "authentik", callbackURL: "/SSO/issues", disableRedirect: true }) }));
    const authorize = new URL((await start.json()).url);
    callbackNonce = authorize.searchParams.get("nonce")!;
    expect(callbackNonce).toBeTruthy();
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    const cookie = start.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const callback = await auth.handler(new Request(origin + "/api/auth/callback/authentik?code=fixture-code&state=" + encodeURIComponent(authorize.searchParams.get("state")!), { headers: { Cookie: cookie } }));
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get("location")!, origin).href).toBe(origin + "/SSO/issues");
    const [account] = await db.select().from(authAccounts).where(eq(authAccounts.accountId, "code-flow@mereka.my"));
    expect(account.accessToken).toBeTruthy();
    expect(account.accessToken).not.toBe("fixture-access");
    const sessionCookie = callback.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const session = await auth.handler(new Request(origin + "/api/auth/get-session", { headers: { Cookie: sessionCookie } }));
    expect((await session.json()).user.email).toBe("code-flow@mereka.my");
    const logout = await auth.handler(new Request(origin + "/api/auth/sign-out", { method: "POST", headers: {
      Cookie: sessionCookie, Origin: origin, "Content-Type": "application/json" }, body: "{}" }));
    expect(logout.status).toBe(200);
    const result = await logout.json();
    expect(new URL(result.url).pathname).toContain("end-session");
    const reused = await auth.handler(new Request(origin + "/api/auth/get-session", { headers: { Cookie: sessionCookie } }));
    expect(await reused.json()).toBeNull();
  });

  it("preserves a suspended membership and refuses a new session", async () => {
    const [user] = await db.select().from(authUsers).where(eq(authUsers.email, "miranda@mereka.my"));
    const before = await db.select().from(authSessions);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, user.id));
    expect((await login("miranda@mereka.my")).status).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(authSessions)).toHaveLength(before.length);
  });
  it("requires authenticated linking for a pre-existing unverified local account", async () => {
    vi.stubEnv("PAPERCLIP_AUTHENTIK_ALLOW_PASSWORD_LOGIN", "true");
    try {
      const recovery = createBetterAuthInstance(db, { deploymentMode: "authenticated", deploymentExposure: "public",
        authBaseUrlMode: "explicit", authPublicBaseUrl: origin, authDisableSignUp: false } as Config, [origin]);
      // Fixture creation only: production keeps password signup closed.
      const signup = await recovery.handler(new Request(origin + "/api/auth/sign-up/email", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "local-founder@biji-biji.com", name: "Existing local founder", password: "fixture-password-for-auth-linking" }) }));
      expect(signup.status).toBe(200);
      const original = (await signup.json()).user;
      expect(original.emailVerified).toBe(false);
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: original.id, membershipRole: "owner" });
      expect((await login(original.email)).status).toBe(401);
      const cookie = signup.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
      const link = await recovery.handler(new Request(origin + "/api/auth/link-social", { method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "authentik", idToken: { token: tokenFor(original.email) }, callbackURL: "/" }) }));
      expect(link.status).toBe(200);
      expect((await login(original.email)).status).toBe(200);
      const [account] = await db.select().from(authAccounts).where(eq(authAccounts.providerId, "authentik")).then((rows) => rows.filter((row) => row.userId === original.id));
      expect(account.userId).toBe(original.id);
      const [membership] = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, original.id));
      expect(membership.membershipRole).toBe("owner");
    } finally {
      vi.stubEnv("PAPERCLIP_AUTHENTIK_ALLOW_PASSWORD_LOGIN", "false");
    }
  });

  it("links an existing verified identity without changing the local user ID or owner role", async () => {
    const now = new Date();
    await db.insert(authUsers).values({ id: "existing-founder", email: "gurpreet@biji-biji.com", name: "Founder", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "existing-founder", membershipRole: "owner" });
    expect((await login("gurpreet@biji-biji.com")).status).toBe(200);
    expect(await db.select().from(authAccounts).where(eq(authAccounts.userId, "existing-founder"))).toHaveLength(1);
    const [membership] = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, "existing-founder"));
    expect(membership.membershipRole).toBe("owner");
  });
});
