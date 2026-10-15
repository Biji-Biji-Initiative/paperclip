# Factory dependency qualification — 2026-10-15

Base release: upstream `v2026.1012.0` / `bba6a45f0d364cfd962ac59b3bdf2426a8222adb`.

| Change | Reason and verification |
|---|---|
| Repair release lockfile | A frozen install rejected the tag's manifest because the server MCP SDK and light-my-request importer entries were absent. Lock-only reconciliation added 27 lines, retaining existing resolutions. A subsequent frozen install succeeds. |
| proxy-addr 2.0.7 → 2.0.8 | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h). The old library trusts an unrelated IPv4 peer under `::/1`; the patched library refuses it. Both pnpm override authorities and the lockfile are synchronized. The application regression covers that accepted configuration and a valid IPv4 subnet. Proxy/request-guard tests pass. |
| Node 24 build base → immutable digest | Pin `node:24-trixie-slim` at `sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315`, observed from the official image registry on 2026-10-15. Full image qualification remains separate from source checks. |

After the proxy-addr update, the source production dependency audit reports **0 critical, 20 high,
33 moderate and 9 low** advisories. This is not a claim that all remaining
findings are reachable, resolved, or present in every runtime. Qualify each
compatible update separately; do not make untested major-version overrides.
Native provider pins remain unchanged, including Codex 0.160.0, to preserve the
release's qualified native runtime window.

The previously rehearsed official image and the deployed old image do not gain
these fixes from a source commit. A newly built, identified and rehearsed image
is required. Public staff access and real provider execution remain gated on
separate live acceptance evidence.

## Subsequent URI patch

`fast-uri` 3.1.2 → 3.1.7 addresses the authority-injection and normalization
advisories, including [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3).
The old dependency serializes a crafted port into a different host. The patched
dependency throws, and valid URI serialization and AJV schema/reference behavior
remain correct. Targeted dependency/auth integration checks: 28 tests pass.
This patch is restricted to the existing 3.x dependency line. It requires a new
identified image; it does not alter the earlier image build already running.

After the URI patch, the production dependency audit reports **0 critical and 13 high** advisories.

## Undici 8.x security patch

`undici` 8.10.0 → 8.10.2 follows the upstream security patch for WebSocket,
BalancedPool TLS and cache-origin isolation. The override is restricted to 8.x;
no untested cross-major upgrade is applied to the older Cursor SDK transport.
The application's jsdom consumers pass all 57 targeted UI tests. The production
source audit now reports **0 critical and 10 high** advisories (6 low, 28 moderate).

## Sharp native image security patch

`sharp` 0.35.4 → 0.35.5 includes librsvg 2.63.2 for
[GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).
The installed native library reports Sharp 0.35.5, librsvg 2.63.2 and
libvips 8.18.7. Avatar, Telegram photo and Teams inline-image tests pass
(58 tests). The production source audit reports 0 critical, 9 high,
28 moderate and 6 low advisories. The pending image build predates this patch;
only a subsequent identified rebuild will include it.

## Native authentication review corrections

The independent follow-up identified application-lifecycle defects beyond the
initial callback helper. Startup now preserves missing human grant rows; agent
membership compatibility remains. Existing role/default authorization is a
separate policy and is not represented as a grant-removal deny.

The narrow pinned Better Auth 1.7.2 patch binds consumed discovery metadata to
the configured issuer and HTTPS authority, requires an ID token for Authentik,
and returns an error after clearing cookies if database revocation fails.
Factory rejects direct ID-token sign-in/linking, disables implicit account
linking, and consumes a provider-subject/local-account-bound request receipt.
Recovery is scoped to one operator with a one-hour maximum expiry. Required SSO
configuration can fail startup on complete projection loss. See doc/AUTHENTIK.md
for old-session revocation and the remaining real staff acceptance gates.

The image's global Codex CLI is pinned to the release-qualified 0.160.0,
matching its native compatibility window; an unbounded latest CLI would make
an otherwise identified image inherit an unsupported runtime.

Factory Compose now builds the selected fork source instead of using the stock
upstream image that lacks the integration. It requires SOURCE_COMMIT as the
build stamp, exact existing external volumes, a pre-existing staff company and
provider secret, required SSO, closed signup and disabled scheduled heartbeats.
Recovery stays off by default. Coolify's source-commit build setting must be
explicitly enabled, and the resulting image identity qualified before rollout.
Compose rendering passes with fixture values and no daemon or deployment writes.

## Express route-pattern bound

`path-to-regexp` 8.3.0 → 8.4.0 is restricted to 8.x and addresses
[GHSA-j3q9-mxjg-w52f](https://github.com/advisories/GHSA-j3q9-mxjg-w52f).
The actual Express router dependency now rejects 32 sequential optional groups
before exponential expansion; normal company-scoped routes still match. Thirty
focused dependency, authentication-route and MCP HTTP tests pass.

## YAML merge-work bound

`js-yaml` 4.3.1 → 4.3.2 fixes
[GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh).
The editor's actual parser now counts empty merge sources against its work
limit; ordinary proposal frontmatter still parses correctly. Nine focused
parser and rendered Markdown tests pass. The override stays within 4.x.

## Source-map offset validation

`source-map-js` 1.2.1 → 1.2.2 addresses
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
The build pipeline's actual consumer rejects excessive indexed section offsets
and retains normal source locations. Ten parser/Markdown tests and the full UI
production build pass. The override stays within 1.x.

## MCP SDK credential issuer binding

`@modelcontextprotocol/sdk` 1.30.0 → 1.31.0 addresses
[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)
within its supported 1.x line. This application's production imports use the SDK
server interfaces; its remote HTTP client is separate. No bundled SDK
ClientCredentialsProvider/PrivateKeyJwtProvider configuration was found to require
an additional expectedIssuer migration. No OAuth credential flow is claimed
from a version bump alone.

129 focused tests pass: public/remote MCP (76), Paperclip MCP tools (14), Sheets
MCP (27) and demo MCP (12), including real loopback HTTP client/server exchanges.
The Paperclip tools fixture omitted the shared input schema's pre-existing
allowDuplicate=false default; its expected POST body now includes that safe
default. This was an existing fixture mismatch, not a relaxation of duplicate
protection. MCP package TypeScript checking passes.

## Cursor SDK transport update and current audit

`@cursor/sdk` 1.0.28 → 1.0.37 is the current stable patch on the same 1.0 line.
The upstream package metadata removes @connectrpc/connect-node, eliminating its
old Undici 5.x / busboy transport chain instead of forcing a cross-major
transitive override. The Node requirement remains >=22.13 (image runtime:24).
The actual SDK exports used by the adapter load successfully with network access
disabled. All21 focused Cursor Cloud adapter tests and its TypeScript check pass.
These are compatibility checks, not an authenticated Cursor Cloud run.

The final production source audit now reports **0critical, 0high, 19moderate and
3low** advisories. This describes the resolved source graph, not the older running
image or every globally installed CLI/OS package. Remaining findings and actual
image/runtime qualification are separate work. A frozen install and final
self-hosted image rehearsal remain required before rollout.

## Failure-path release qualification

The signed OIDC fixture now enforces the submitted PKCE verifier and consumes
codes once. Twenty PostgreSQL/auth tests pass with
PAPERCLIP_REQUIRE_EMBEDDED_POSTGRES_TESTS=true (unsupported PostgreSQL is a hard
failure for this gate). Negative/transition cases include invalid signature,
expiry, nonce/state/cookies, non-boolean verification claims, direct-token and
callback replay, concurrent identities, transactional audit failure, session
persistence failure with idempotent retry, and copied-cookie expiry/revocation.
Browser console diagnostics now omit raw network errors and HTTP response bodies;
eleven focused auth API tests pass, including marker-based non-disclosure checks.
The image built from the preceding source snapshot does not gain this frontend
change without a subsequent identified rebuild.

## Callback receipt route correction

A stronger test suppressed the validation receipt on a real library callback.
It reproduced a fail-open boundary: Better Auth dispatch names that endpoint
`/callback/:id`, while the initial guard compared only the literal URL. The gate
now recognizes the actual endpoint and Authentik provider parameter. The same
negative flow is denied, no session or membership is issued, and all21 migrated
PostgreSQL staff-auth tests pass. Server TypeScript checking passes. This is an
internal missing-validation fault test, not a claim of a browser-forged receipt
or a production incident; the native integration remains unenabled in production.
UBS scanned the auth module: its three critical reports are boolean recovery
option comparisons labelled as secret comparisons. They compare true/false
configuration values, not credentials; no scanner rule was disabled.

## Recovery expiry keeps staff SSO available

A real HTTP metadata test reproduced HTTP500 when a temporary recovery window
expired: the shared configuration parser rejected the stale deadline on every
metadata request. Expired recovery now becomes inactive, including at startup,
while staff SSO remains configured. Missing/malformed deadlines and windows
longer than one hour still fail validation; the request hook continues to deny
password recovery after the deadline without needing a restart. The same HTTP
test now returns200, advertises Staff SSO and hides password sign-in. All41
auth-route and migrated-PostgreSQL staff-auth tests pass with required database
support. The preceding 7fba1275 image does not contain this correction and is
retained only for earlier-image rehearsal until an identified rebuild qualifies.
Server TypeScript checking passes. UBS directly scanned the auth module and
retains the same three boolean-comparison false positives described above,
with zero warnings and17 informational items.
