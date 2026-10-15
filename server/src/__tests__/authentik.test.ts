import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, authAccounts, authSessions, authUsers, companies, companyMemberships, createDb, instanceUserRoles, principalPermissionGrants } from "@paperclipai/db";
import { authentikAuthOptions, authentikConfiguration } from "../auth/authentik.js";
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
    expect(() => authentikConfiguration({ PAPERCLIP_AUTHENTIK_REQUIRED: "true" })).toThrow(/Required/);
    expect(() => authentikConfiguration({ ...settings, PAPERCLIP_AUTHENTIK_ALLOW_PASSWORD_LOGIN: "true" })).toThrow(/one operator/);
    expect(() => authentikConfiguration({ ...settings, PAPERCLIP_AUTHENTIK_ALLOW_PASSWORD_LOGIN: "true",
      PAPERCLIP_AUTHENTIK_RECOVERY_EMAIL: "operator@mereka.my", PAPERCLIP_AUTHENTIK_RECOVERY_UNTIL: new Date(Date.now() - 1000).toISOString() })).toThrow(/expiry/);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported && process.env.PAPERCLIP_REQUIRE_EMBEDDED_POSTGRES_TESTS === "true") throw new Error("Release qualification requires migrated PostgreSQL tests");
(support.supported ? describe : describe.skip)("Authentik with real auth library and migrated PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let auth: ReturnType<typeof createBetterAuthInstance>;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" };
  let discoveryOverride: Record<string, unknown> = {};
  let omitIdToken = false;
  const exchanges = new Map<string, { email: string; verified: boolean; claims: Record<string, unknown>; nonce: string; challenge: string; corruptVerifier: boolean }>();
  let exchangeCounter = 0;
  const subjects = new Map<string, string>();
  function subjectFor(email: string) {
    if (!subjects.has(email)) subjects.set(email, randomUUID());
    return subjects.get(email)!;
  }
  function tokenFor(email: string, verified = true, extra: Record<string, unknown> = {}) {
    const { fixtureBadSignature, ...claimsExtra } = extra;
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-key" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: "factory-fixture", sub: subjectFor(email), email,
      email_verified: verified, name: "Fixture Staff", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+120, ...claimsExtra })).toString("base64url");
    const data = header + "." + claims;
    const signature = sign("RSA-SHA256", Buffer.from(data), keys.privateKey);
    if (fixtureBadSignature) signature[0] ^= 1;
    return data + "." + signature.toString("base64url");
  }
  async function login(email: string, verified = true, claims: Record<string, unknown> = {}, instance = auth, linkingCookie?: string, flow: { state?: string; omitCookie?: boolean; corruptVerifier?: boolean; replay?: boolean } = {}) {
    const start = await instance.handler(new Request(origin + "/api/auth/" + (linkingCookie ? "link-social" : "sign-in/social"), {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(linkingCookie ? { Cookie: linkingCookie } : {}) },
      body: JSON.stringify({ provider: "authentik", callbackURL: "/SSO/issues", errorCallbackURL: "/auth", disableRedirect: true }),
    }));
    if (start.status !== 200) return start;
    const authorize = new URL((await start.json()).url);
    const nonce = authorize.searchParams.get("nonce");
    expect(nonce).toBeTruthy();
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    const code = "exchange-" + exchangeCounter++;
    exchanges.set(code, { email, verified, claims, nonce: nonce ?? "", challenge: authorize.searchParams.get("code_challenge") ?? "", corruptVerifier: flow.corruptVerifier ?? false });
    const cookie = start.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const callbackUrl = origin + "/api/auth/callback/authentik?code=" + code + "&state=" + encodeURIComponent(flow.state ?? authorize.searchParams.get("state") ?? "");
    const headers = { Cookie: flow.omitCookie ? "" : cookie + (linkingCookie ? "; " + linkingCookie : "") };
    let callback = await instance.handler(new Request(callbackUrl, { headers }));
    if (flow.replay) callback = await instance.handler(new Request(callbackUrl, { headers }));
    const location = new URL(callback.headers.get("location") ?? "/auth?error=missing_redirect", origin);
    // Preserve the actual callback cookies, but make failed redirects explicit
    // to each assertion rather than treating every HTTP302 as authentication.
    return new Response(null, { headers: callback.headers, status: location.searchParams.has("error") ? 401 : callback.status });
  }
  async function seedBoundIdentity(userId: string, email: string) {
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, email, name: "Bound fixture", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(authAccounts).values({ id: randomUUID(), userId, providerId: "authentik", accountId: subjectFor(email), issuer, createdAt: now, updatedAt: now });
  }
  beforeAll(async () => {
    for (const [key, value] of Object.entries(settings)) vi.stubEnv(key, value);
    vi.stubEnv("BETTER_AUTH_SECRET", "authentik-integration-fixture-secret-not-for-deployment");
    vi.stubEnv("PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "false");
    vi.stubGlobal("fetch", vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === issuer + ".well-known/openid-configuration") return Response.json({ issuer,
        authorization_endpoint: issuer + "authorize", token_endpoint: issuer + "token", userinfo_endpoint: issuer + "userinfo",
        jwks_uri: issuer + "jwks", end_session_endpoint: issuer + "end-session", id_token_signing_alg_values_supported: ["RS256"], response_types_supported: ["code"], ...discoveryOverride });
      if (url === issuer + "token") {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const exchange = exchanges.get(params.get("code") ?? "");
        if (!exchange) return Response.json({ error: "invalid_grant" }, { status: 400 });
        exchanges.delete(params.get("code") ?? "");
        const verifier = exchange.corruptVerifier ? "incorrect-verifier" : params.get("code_verifier");
        if (!verifier || createHash("sha256").update(verifier).digest("base64url") !== exchange.challenge) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({ access_token: "fixture-access", token_type: "Bearer", expires_in: 120,
          ...(omitIdToken ? {} : { id_token: tokenFor(exchange.email, exchange.verified, { nonce: exchange.nonce, ...exchange.claims }) }) });
      }
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
    expect((await login("miranda@mereka.my")).status).toBe(302);
    const [user] = await db.select().from(authUsers).where(eq(authUsers.email, "miranda@mereka.my"));
    expect(await db.select().from(companyMemberships)).toMatchObject([{ companyId, principalId: user.id, membershipRole: "operator", status: "active" }]);
    expect(await db.select().from(instanceUserRoles)).toHaveLength(0);
    expect(await db.select().from(principalPermissionGrants)).toMatchObject([{ principalId: user.id, permissionKey: "tasks:assign" }]);
    const [session] = await db.select().from(authSessions).where(eq(authSessions.userId, user.id));
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeLessThanOrEqual(3600_000);
    expect((await login("miranda@mereka.my")).status).toBe(302);
    expect(await db.select().from(companyMemberships)).toHaveLength(1);
  });
  it("rejects unverified identities and wrong issuers/audiences before granting access", async () => {
    for (const [email, verified, claims] of [["unverified@mereka.my", false, {}], ["wrong-issuer@mereka.my", true, { iss: "https://wrong.fixture/" }], ["wrong-audience@mereka.my", true, { aud: "another-app" }]] as const) {
      expect((await login(email, verified, claims)).status).toBeGreaterThanOrEqual(400);
      expect(await db.select().from(authUsers).where(eq(authUsers.email, email))).toHaveLength(0);
    }
  });
  it("rejects invalid signatures, expiry, nonce and non-boolean verification claims", async () => {
    const cases = [{ fixtureBadSignature: true }, { exp: Math.floor(Date.now()/1000)-30 }, { nonce: "incorrect-nonce" },
      { email_verified: undefined }, { email_verified: "true" }, { email_verified: 1 }, { sub: undefined }];
    for (const [index, claims] of cases.entries()) {
      const email = "invalid-claims-" + index + "@mereka.my";
      expect((await login(email, true, claims)).status).toBe(401);
      expect(await db.select().from(authUsers).where(eq(authUsers.email, email))).toHaveLength(0);
    }
  });
  it("rejects absent/wrong state and PKCE mismatches without provisioning", async () => {
    for (const [index, flow] of [{ state: "incorrect-state" }, { omitCookie: true }, { corruptVerifier: true }].entries()) {
      const email = "invalid-flow-" + index + "@mereka.my";
      expect((await login(email, true, {}, auth, undefined, flow)).status).toBe(401);
      expect(await db.select().from(authUsers).where(eq(authUsers.email, email))).toHaveLength(0);
    }
  });
  it("does not issue a second session when an authorization callback is replayed", async () => {
    expect((await login("state-replay@mereka.my", true, {}, auth, undefined, { replay: true })).status).toBe(401);
    const [user] = await db.select().from(authUsers).where(eq(authUsers.email, "state-replay@mereka.my"));
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, user.id))).toHaveLength(1);
  });
  it("keeps concurrent callback identities isolated", async () => {
    const emails = ["parallel-a@mereka.my", "parallel-b@mereka.my"];
    expect((await Promise.all(emails.map((email) => login(email)))).map((result) => result.status)).toEqual([302, 302]);
    for (const email of emails) {
      const [user] = await db.select().from(authUsers).where(eq(authUsers.email, email));
      const [account] = await db.select().from(authAccounts).where(eq(authAccounts.userId, user.id));
      const [membership] = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, user.id));
      expect(account.accountId).toBe(subjectFor(email));
      expect(membership.companyId).toBe(companyId);
    }
  });
  it("completes the code flow with PKCE/nonce and invalidates the session on logout", async () => {
    const callback = await login("code-flow@mereka.my");
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get("location")!, origin).href).toBe(origin + "/SSO/issues");
    const [account] = await db.select().from(authAccounts).where(eq(authAccounts.accountId, subjectFor("code-flow@mereka.my")));
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

  it("rejects client-supplied ID tokens on sign-in and linking", async () => {
    for (const endpoint of ["sign-in/social", "link-social"]) {
      const result = await auth.handler(new Request(origin + "/api/auth/" + endpoint, { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "authentik", idToken: { token: tokenFor("replay@mereka.my") } }) }));
      expect(result.status).toBe(400);
    }
    expect(await db.select().from(authUsers).where(eq(authUsers.email, "replay@mereka.my"))).toHaveLength(0);
  });
  it("rejects a code exchange without an ID token", async () => {
    omitIdToken = true;
    try { expect((await login("no-id-token@mereka.my")).status).toBe(401); }
    finally { omitIdToken = false; }
    expect(await db.select().from(authUsers).where(eq(authUsers.email, "no-id-token@mereka.my"))).toHaveLength(0);
  });
  it("rejects mismatched discovery issuer and endpoint authority", async () => {
    for (const override of [{ issuer: "https://other.fixture/" }, { token_endpoint: "https://other.fixture/token" }]) {
      discoveryOverride = override;
      try {
        const invalid = createBetterAuthInstance(db, { deploymentMode: "authenticated", deploymentExposure: "public",
          authBaseUrlMode: "explicit", authPublicBaseUrl: origin, authDisableSignUp: true } as Config, [origin]);
        await expect(invalid.$context).rejects.toThrow(/Authentik discovery/);
      } finally { discoveryOverride = {}; }
    }
  });
  it("reports failed revocation and clears cookies without pretending the copied session is revoked", async () => {
    const callback = await login("logout-fault@mereka.my");
    expect(callback.status).toBe(302);
    const cookie = callback.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const context = await auth.$context;
    const deletion = vi.spyOn(context.internalAdapter, "deleteSession").mockRejectedValueOnce(new Error("Injected storage failure"));
    try {
      const result = await auth.handler(new Request(origin + "/api/auth/sign-out", { method: "POST", headers: {
        Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: "{}" }));
      expect(result.status).toBe(500);
      expect(result.headers.getSetCookie().some((v) => v.includes("Max-Age=0"))).toBe(true);
      const replay = await auth.handler(new Request(origin + "/api/auth/get-session", { headers: { Cookie: cookie } }));
      expect((await replay.json()).user.email).toBe("logout-fault@mereka.my");
    } finally { deletion.mockRestore(); }
    const retry = await auth.handler(new Request(origin + "/api/auth/sign-out", { method: "POST", headers: {
      Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: "{}" }));
    expect(retry.status).toBe(200);
    const replay = await auth.handler(new Request(origin + "/api/auth/get-session", { headers: { Cookie: cookie } }));
    expect(await replay.json()).toBeNull();
  });

  it("does not transfer identities when subjects or email ownership change", async () => {
    const [original] = await db.select().from(authUsers).where(eq(authUsers.email, "code-flow@mereka.my"));
    expect((await login("code-flow@mereka.my", true, { sub: randomUUID() })).status).toBe(401);
    expect((await login("changed-mailbox@mereka.my", true, { sub: subjectFor("code-flow@mereka.my") })).status).toBe(401);
    const [preserved] = await db.select().from(authUsers).where(eq(authUsers.id, original.id));
    expect(preserved.email).toBe(original.email);
    expect(await db.select().from(authUsers).where(eq(authUsers.email, "changed-mailbox@mereka.my"))).toHaveLength(0);
  });
  it("fails closed when an Authentik callback lacks its request receipt", async () => {
    const before = authentikAuthOptions(db, origin, settings).databaseHooks?.session?.create?.before;
    if (!before) throw new Error("Missing staff session gate");
    await expect(before({ userId: "unverified-context" } as never, { path: "/callback/authentik" } as never)).rejects.toThrow(/receipt/);
  });
  it("requires the receipt on the real library callback route", async () => {
    const context = await auth.$context;
    if (!context.options.user?.validateUserInfo) throw new Error("Missing staff identity validator");
    const missingReceipt = vi.spyOn(context.options.user, "validateUserInfo").mockImplementation(() => undefined);
    try {
      expect((await login("missing-receipt@mereka.my")).status).toBe(401);
      const [user] = await db.select().from(authUsers).where(eq(authUsers.email, "missing-receipt@mereka.my"));
      if (user) {
        expect(await db.select().from(authSessions).where(eq(authSessions.userId, user.id))).toHaveLength(0);
        expect(await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, user.id))).toHaveLength(0);
      }
    } finally { missingReceipt.mockRestore(); }
  });

  it("rolls membership, initial grant and audit back together when audit persistence fails", async () => {
    const userId = "audit-rollback-user";
    const email = "audit-rollback@mereka.my";
    await seedBoundIdentity(userId, email);
    // This is the suite's isolated migrated database, never a runtime database.
    await db.execute(sql`ALTER TABLE activity_log ADD CONSTRAINT fixture_reject_staff_audit CHECK (entity_id <> 'audit-rollback-user')`);
    try {
      expect((await login(email)).status).toBe(401);
      expect(await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, userId))).toHaveLength(0);
      expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId))).toHaveLength(0);
      expect(await db.select().from(authSessions).where(eq(authSessions.userId, userId))).toHaveLength(0);
    } finally { await db.execute(sql`ALTER TABLE activity_log DROP CONSTRAINT fixture_reject_staff_audit`); }
    expect((await login(email)).status).toBe(302);
    expect((await login(email)).status).toBe(302);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, userId))).toHaveLength(1);
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId))).toHaveLength(1);
  });
  it("retries idempotently after session persistence fails after membership commits", async () => {
    const userId = "session-failure-user";
    const email = "session-failure@mereka.my";
    await seedBoundIdentity(userId, email);
    await db.execute(sql`ALTER TABLE session ADD CONSTRAINT fixture_reject_staff_session CHECK (user_id <> 'session-failure-user')`);
    try {
      expect((await login(email)).status).toBe(401);
      expect(await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, userId))).toHaveLength(1);
      expect(await db.select().from(authSessions).where(eq(authSessions.userId, userId))).toHaveLength(0);
    } finally { await db.execute(sql`ALTER TABLE session DROP CONSTRAINT fixture_reject_staff_session`); }
    expect((await login(email)).status).toBe(302);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, userId))).toHaveLength(1);
    expect(await db.select().from(authAccounts).where(eq(authAccounts.userId, userId))).toHaveLength(1);
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, userId))).toHaveLength(1);
  });
  it("does not slide session expiry and rejects a copied cookie after expiry", async () => {
    const callback = await login("fixed-expiry@mereka.my");
    const cookie = callback.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const [user] = await db.select().from(authUsers).where(eq(authUsers.email, "fixed-expiry@mereka.my"));
    const expiresAt = new Date(Date.now() + 30_000);
    await db.update(authSessions).set({ createdAt: new Date(Date.now()-172800_000), expiresAt }).where(eq(authSessions.userId, user.id));
    const request = () => auth.handler(new Request(origin + "/api/auth/get-session", { headers: { Cookie: cookie } }));
    expect((await (await request()).json()).user.id).toBe(user.id);
    const [session] = await db.select().from(authSessions).where(eq(authSessions.userId, user.id));
    expect(session.expiresAt.getTime()).toBe(expiresAt.getTime());
    await db.update(authSessions).set({ expiresAt: new Date(Date.now()-1000) }).where(eq(authSessions.userId, user.id));
    expect(await (await request()).json()).toBeNull();
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
    vi.stubEnv("PAPERCLIP_AUTHENTIK_RECOVERY_EMAIL", "local-founder@biji-biji.com");
    vi.stubEnv("PAPERCLIP_AUTHENTIK_RECOVERY_UNTIL", new Date(Date.now() + 1800_000).toISOString());
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
      const link = await login(original.email, true, {}, recovery, cookie);
      expect(link.status).toBe(302);
      expect((await login(original.email)).status).toBe(302);
      const [account] = await db.select().from(authAccounts).where(eq(authAccounts.providerId, "authentik")).then((rows) => rows.filter((row) => row.userId === original.id));
      expect(account.userId).toBe(original.id);
      const [membership] = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, original.id));
      expect(membership.membershipRole).toBe("owner");
    } finally {
      vi.stubEnv("PAPERCLIP_AUTHENTIK_ALLOW_PASSWORD_LOGIN", "false");
    }
  });

  it("refuses implicit inheritance of an existing verified local identity", async () => {
    const now = new Date();
    await db.insert(authUsers).values({ id: "existing-founder", email: "gurpreet@biji-biji.com", name: "Founder", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "existing-founder", membershipRole: "owner" });
    expect((await login("gurpreet@biji-biji.com")).status).toBe(401);
    expect(await db.select().from(authAccounts).where(eq(authAccounts.userId, "existing-founder"))).toHaveLength(0);
    const [membership] = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, "existing-founder"));
    expect(membership.membershipRole).toBe("owner");
  });
});
