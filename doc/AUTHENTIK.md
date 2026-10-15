# Staff sign-in through Authentik

This optional integration uses Better Auth 1.7.2's Generic OAuth provider. It
creates normal Paperclip sessions, uses OIDC discovery and signing-key checks,
and keeps PKCE, issuer, audience and nonce validation enabled. Browser identity
headers and email suffixes never establish company access.

Set these four values together through the owning secret projection:

| Variable | Meaning |
|---|---|
| `PAPERCLIP_AUTHENTIK_ISSUER` | Canonical HTTPS issuer, including its per-application path |
| `PAPERCLIP_AUTHENTIK_CLIENT_ID` | Confidential OAuth client ID |
| `PAPERCLIP_AUTHENTIK_CLIENT_SECRET` | Client credential; never store in source |
| `PAPERCLIP_AUTHENTIK_COMPANY_ID` | Existing active company UUID |

The auth public base URL must be an explicit canonical HTTPS origin. Partial
configuration stops startup. With no configuration, existing authentication
behavior remains. No new database schema is required beyond the base release.

## Factory provider contract

Factory's intended production issuer is
`https://auth0.mereka.io/application/o/factory/`. This is a proposed provider
contract until the infrastructure owner realizes it and verifies discovery.
Register the exact authorization callback
`https://factory.mereka.io/api/auth/callback/authentik` and logout return
`https://factory.mereka.io/auth` using the current Authentik provider schema.
Use the estate's existing staff admission rules and reviewed verified-email
mapping. Stock Authentik email mapping reports false; do not change the shared
mapping or invent an app-local managed-domain verification rule.

Provider, admission policy, signing key, blueprint realization and AUTH_REGISTRY
belong in `bbi-infrastructure`, through its current held-production GitOps route.
This consumer repository does not own those runtime resources. Do not copy
archived reference blueprints into a second authority. Project isolation is not
provided by project names within a shared company.

## Accounts and membership

A fresh verified Authentik exchange creates an `operator` membership in the
configured company, with the existing role's minimal task-assignment grant.
It never grants instance administration. Existing roles, removed grants and
suspended memberships are preserved; a suspended membership blocks new staff
sessions. Membership writes and their audit event are transactional and occur
before the session is issued. No company is silently created.

New staff—including `miranda@mereka.my`—use **Continue with Staff SSO**. Authentik
owns Google/MFA/passkey choices and staff admission. Password sign-in is disabled
when this integration is enabled, unless the operator explicitly sets
`PAPERCLIP_AUTHENTIK_ALLOW_PASSWORD_LOGIN=true` for controlled recovery, together
with `PAPERCLIP_AUTHENTIK_RECOVERY_EMAIL` and `PAPERCLIP_AUTHENTIK_RECOVERY_UNTIL`
(an ISO timestamp within one hour). Only that operator may use password recovery;
the request hook enforces the expiry even without a restart. Keep
`PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` throughout production use and recovery.

Existing local accounts, verified or unverified, cannot be silently merged
by matching an IdP email. Preserve this Better Auth protection. For the existing
operator, enable the controlled password recovery option, sign into the existing
account normally, open Profile settings and choose **Connect staff SSO**. The
IdP must verify the same email. Prove SSO returns the original user ID, company
role and AI account ownership, then disable the recovery option. Do not reset a
staff password or set a verification flag in SQL to skip linking.

## Sessions and removal

Sessions have a fixed one-hour lifetime without sliding renewal. Central staff
removal is enforced at the next Authentik exchange; existing app sessions can
persist until that fixed expiry. Revoke local sessions as well when immediate
removal is required. Local membership suspension/removal is independently
checked by company authorization. This implementation does not claim OIDC
back-channel logout.

OAuth access/refresh tokens use Better Auth's at-rest encryption. Preserve
`BETTER_AUTH_SECRET` across restarts and recovery. Logout clears the local
session and account caches before navigating to the discovered IdP logout URL;
its navigation does not wait on a health refresh. App logout does not establish
that every other relying party has logged out.

## Qualification

Focused tests use the real auth library, signed fixture tokens and a real migrated
PostgreSQL database. They cover the authorization-code/PKCE/nonce flow, invalid
identities, minimal grants, unchanged existing identities/roles, authenticated
linking, suspension, token encryption and logout/session invalidation. UI tests
cover the staff button, hidden password form, profile linking and logout.
These are controlled protocol tests; they are not real Miranda/Google/MFA proof.

Before enabling this in Factory, build and identify the actual changed image,
rehearse its migration and application behavior on copied state, qualify the
central provider/policies, and prove real staff login, denied nonstaff access,
company boundaries, logout and expiry. Then bind each agent to the responsible
user's intended AI connection and prove a bounded real task. No live staff
access or successful agent run follows merely from enabling SSO configuration.

## Enabling and recovery acceptance

Set `PAPERCLIP_AUTHENTIK_REQUIRED=true` in the production deployment after
qualification: loss of all four SSO settings must fail startup, rather than
silently accepting a password-only deployment. Revoke pre-existing sessions
through supported session management when enabling SSO, and again after the
operator links the existing profile and recovery is closed. New one-hour session
settings do not rewrite old session expiry rows. Preserve the encryption secret.

The pinned Better Auth patch validates the discovery metadata actually consumed:
exact configured issuer and HTTPS endpoints on that issuer's origin. Authentik
code exchanges must return an ID token; user-info fallback is refused. Public
client-supplied ID tokens are rejected for sign-in and linking. Request receipts
are single-use and bound to the verified provider subject and local account.
Implicit mailbox matching cannot inherit an existing account; authenticated
linking is required. An email change on an already bound subject fails membership
provisioning until an operator resolves it; it cannot transfer another identity.

Startup no longer restores missing human grant rows. Role defaults and simple
company mode remain separate authorization policies: removing a row alone is not
an explicit deny of every role/default capability. Use supported role changes or
membership suspension/removal for effective denial. Existing instance admins are
not demoted by a company membership change.

Membership, its initial grant and its audit event commit together. The wider
OAuth account/session lifecycle is not one transaction: session persistence can
fail after an idempotent membership is committed. Retry must preserve existing
users, roles and connection ownership; no distributed compensation is claimed.

Logout deletion failure clears browser cookies but returns a server error, and
the UI clears account state on every logout attempt. Failed revocation routes to
an explicit uncertainty/retry screen. A copied session cookie can still work
until revocation succeeds; never report that failure as completed sign-out.
Provider logout endpoints come only from the origin-validated discovery data.
