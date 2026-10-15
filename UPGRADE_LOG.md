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

### Local runner control-plane origin

A private native proposal rehearsal reached neither the AI provider nor a saved artifact: local PRP commands timed out while the runner repeatedly received WebSocket HTTP 502 responses from the public ingress. The registered local authority had zero connections and all commands remained pending. Startup had incorrectly reused the public/remote-agent API origin for same-process runner control. The PRP listener now derives its local URL from the actual bind host and selected port, including IPv6-only listeners. Board and remote-agent API discovery retain their existing public origin. Focused runtime URL and PRP route tests cover the listener mapping; a live private rerun is required before this change qualifies for production.

### Codex cost provenance

A completed private API-key pilot saved an editable626-word proposal and a registered4302-byte Markdown artifact. It recorded258693 input tokens,227658 cached input tokens and2612 output tokens, but the normalized native projection supplied costUsd0 and labeled it reported. Codex has no authoritative billed-USD receipt in this contract. Native cost normalization now preserves that unknown instead of accepting the synthetic zero; token counters remain intact. A focused regression reproduces the incorrect reported zero before the fix. This change makes accounting truthful; it does not implement pricing or make billed-cent budgets a hard provider spend cap. Scheduled autonomy remains disabled pending an independently qualified cost/admission mechanism.

Validation: seven focused native usage tests pass (the new regression fails before the correction); server TypeScript and Gitleaks pass. UBS was invoked on the actual executor and its test, but its JavaScript module exceeded the300-second limit and returned exit2 without a completed finding report. This is a scanner coverage limitation, not a clean UBS result. The live baseline's stored reported-zero receipt is retained as failure evidence and is not rewritten as an invoice.

### Whole-image audit and runtime dependency cleanup

The source5397 image's unfiltered Trivy0.76.0 OS/library audit completed with10 critical and161 high findings; the earlier production npm audit did not cover these image contents. That candidate remains unqualified. Old esbuild binaries and the Go-based TypeScript compiler arrived through development dependencies. A separate runtime-app stage now installs production dependencies only, offline and with the frozen lockfile, after all builds. Server startup explicitly imports tsx, so tsx moves into its production dependencies. The unpruned build stage remains available for remote provider packs and cloud plugin compilation.

The final image replaces Debian's outdated gh with upstream2.102.0 and builds OpenSSH10.6p1 client tools against the same Debian libraries. Publisher checksums are pinned for both supported gh architectures and the portable OpenSSH archive. Distribution packages are removed from the final filesystem/package inventory; no SSH daemon or compiler is copied from the client build stage. Sources: https://github.com/cli/cli/releases/tag/v2.102.0 and https://www.openssh.org/txt/release-10.6. Debian currently lists CVE-2026-60002 as unfixed in trixie; replacing the client avoids relying on that exception.

Local validation: pnpm9.15.4 accepts the frozen lockfile offline, git diff --check and Gitleaks pass, and UBS scans two manifest files with zero findings (it does not analyze the Dockerfile). Four existing authorization test files returned40 passing and6 failing tests: the agent cross-tenant file timed out in its first two tests and had four resume permission/mock expectation failures. These failures remain unresolved evidence, not a green authorization qualification. The rebuilt image still needs an unfiltered audit, runtime startup/provider smoke tests and source-level assessment of the five Paperclip advisories matched against the checkout's0.3.1 package metadata. No production rollout is authorized by these local checks alone.

The six authorization failures were traced to a cold route import exceeding the first test's deadline, after which its asynchronous requests continued against later tests' reset mocks. The import now completes in a120-second suite setup hook before any test resets mocks. All13 tests pass with unchanged authorization assertions, including cross-company key listing/creation/revocation. npm also advances to upstream12.2.0, supported by the image's Node24.22.0, to replace vulnerable bundled transport/cache dependencies without hand-editing npm's internals. Actual removal and remaining findings require the next exact-image scan.

The first cleanup image0538982ba exposed a limitation in the filtered reinstall: development symlinks disappeared but orphaned old esbuild binaries remained in the virtual store. Its unfiltered image scan therefore still has8critical/160high findings, despite the gh/OpenSSH replacements. Production dependencies now install into a completely fresh tree in a separate stage retaining the original offline content store. The runtime copy first removes its build-time module trees, then overlays only those fresh production dependencies. This must be verified by the resulting image inventory; no scanner exclusions or severity filters are used. A network-disabled, nonroot startup smoke of the first cleanup image reached the deliberately refused test database with no module-resolution error; that is import coverage, not healthy-server proof.

### Accurate first-party release metadata

Source checkouts retain0.3.1 development package versions while the pinned base is stablev2026.1012.0 and health already exposes the supplied Factory release version/commit. The normal npm publication script temporarily versions those packages; Docker had skipped that step. Image builds with both a supplied release version and full source commit now stamp only the first-party packages in the existing release manifest before compilation and after the fresh dependency overlay. A focused test verifies dependency ranges, workspace links and unrelated package metadata remain unchanged, and rejects missing/invalid provenance and mismatched package identities. This corrects package inventory, including the five April-advisory matches against0.3.1; a version stamp itself is not a security fix or proof of route authorization. The original raw audit remains retained. The source-level auth controls and regression evidence are assessed independently, and the next unfiltered image scan remains required.

The native AI-connection suite initially returned52pass/2fail: the inherited-sandbox adoption case dynamically imported the large agent route graph inside its15-second request deadline and overlapped the next case when it timed out. That cold import now runs once in suite setup under the fixture home, before the request tests begin. Assertions and application authorization behavior remain unchanged; final rerun results are recorded separately.

Validation: all54 native AI-connection tests pass against migrated embedded PostgreSQL, including human audiences, uninstalled/revoked grants and both inherited-sandbox adoption variants. The release-metadata unit test passes. Gitleaks scanned the actual changed diff and both new scripts without findings. UBS scanned3files:20critical/38warning/476informational, with criticals confined to existing test credential fixtures/comparisons, not the metadata helper. Its JSON parsing warnings deliberately surface malformed build inputs as failures. This is reviewed scanner output, not a zero-finding claim.

### Exclude unused authentication development peers

The fresh-tree5eebf95cd image completed its unfiltered scan with3critical/153high findings. Its remaining critical binaries were not orphans: Better Auth's optional drizzle-kit peer pulled the schema generator and obsolete esbuild binaries into the production dependency closure. Its optional Vitest peer also imported test tooling. The pinned readPackage hook now removes both peer declarations and their optional metadata at resolution time, only for Better Auth1.7.2. Removing only a declaration can recreate a wildcard peer from the retained metadata. The actual Drizzle ORM adapter and other runtime peers remain unchanged; database tooling and Vitest remain available as declared development dependencies.

The regenerated frozen lockfile no longer makes either tool a server production dependency. All41 native staff-auth/metadata tests pass against migrated PostgreSQL after this change. The peer-policy unit test checks the exact version, preservation of ORM/React peers, refusal of a changed required-peer contract and repeated application. UBS scans the hook/test with0critical/0warning/3informational. A new exact image still requires a full unfiltered scan and runtime/provider rehearsal. Upstream latest stable was rechecked at16:15UTC: v2026.1012.0, published2026-10-12T21:06:53Z.

### Keep the static UI dependency tree out of runtime

Imagee675af93b completed its unfiltered scan with0critical/101high/180medium/206low/16unknown findings across2082package observations. A network-disabled nonroot inventory confirms obsolete esbuild, Drizzle Kit and Vitest are absent, and all first-party release identities match health metadata. TypeScript's native Go compiler remains solely through the UI's Lexical peer graph. The production dependency install now excludes only the UI workspace; the compiled UI bundle and all other runtime workspace roots remain. Server and CLI have no dependency on the UI package, and the recursive production why-query identifies the UI as the compiler's sole consumer. The next image must prove both its absence and successful static UI serving; no risk claim transfers from this predecessor's scan. Remaining upstream Debian/npm/GitHub CLI advisories stay visible for explicit assessment rather than scanner exclusions.

### Show missing prices in cost summaries

The853b022705 image completed its unfiltered scan with0critical/88high/173medium/204low/11unknown findings across1692package observations; raw report SHA2564e33cf21a79b8d9e80352e78e1ecbdbcc5c386ac4d4212f9407eef193d49b608. Its inventory confirms the native TypeScript compiler is absent. The remaining88high observations are80Debian,4npm and4GitHub CLI findings; their vendor dispositions and limited pilot exposure are recorded in the deployment evidence packet, without suppressions. This image is being delivered for private startup proof, not production rollout.

The cost review found that correctly persisted unpriced usage was still summed into dollar displays without identifying missing charges. Company and issue-tree summaries now count unpriced events using the existing cost_status field and the same query scope. The UI names recorded charges, displays the missing-price count, and explains that its recorded-charge budgets cannot cap unpriced provider spending. A reported zero remains distinct from an absent price. No schema migration or invented provider price is introduced. Exact-image browser and provider qualification must use the resulting source; the earlier image is retained as a predecessor.

Validation:17cost-service tests pass, including real PostgreSQL mixed-price/date/descendant aggregation;9focused native executor usage/cost tests pass (513unselected tests skipped). Server and UI TypeScript checks and UI token gates pass. Gitleaks scans the changed implementation/test diff without findings. UBS directly scans5files and reports1critical/976warning/1009informational observations, not a clean result. Its critical points to the existing detached textarea entity decoder, outside this change: a Chromium control confirms the adversarial input remains text, no image node or event executes, while an ordinary inserted HTML positive control executes the same harmless sentinel. Other observations are primarily existing large-component hooks/deep access and conservative SQL/number checks. The new aggregate uses the existing company/range/visibility filters and does not interpolate input into SQL text.

### Disclose unpriced dashboard usage

The actual populated-workspace browser check found that the dashboard still labeled its aggregate as Month Spend, even when the Costs page correctly disclosed missing prices. The dashboard now labels recorded monthly spend and reports the monthly unpriced-event count with an explicit incomplete-total and budget limitation. The count shares the existing company and UTC-month query filters; reported zero charges remain priced events. No schema change is needed.

Validation: five PostgreSQL dashboard tests pass, including mixed reported-zero/reported-charge/unpriced events, another company and the previous-month boundary. The dashboard reconnect and inbox checks also pass. Initial database setup exceeded its old20-second hook before the database cases ran; the isolated rerun passed with a60-second setup allowance. Server and UI typechecks pass; the required Storybook and inbox fixtures include the added summary field. UI token gates pass. Gitleaks scans the staged implementation/test changes without findings.

### Allow the combined native provider startup budget

An actual c5 proposal run first failed at the controller's30-second session.open limit, then a traced diagnostic rerun completed with27,972ms of native startup. The original transient cause is not established. Independently, the controller timeout was shorter than the provider's sequential initialize/thread-open/thread-read requests, each individually bounded to30seconds. Session opening now has a bounded120-second combined allowance so those phases can complete or report their own errors; ordinary command limits are unchanged.

Validation uses the unchanged Rust runner extracted from the exact c5 image (SHA256ec8014ab6b9e1e199874b17fb863ead659b88c5259ec9f65448fe3537d9b5da7), with no model requests. A provider fixture delays both initialization and thread opening by16seconds: the real transport opens successfully after their combined delay. A separate rejected-initialization fixture propagates its error immediately, preserves the existing unrecoverable-checkpoint classification and proves the runner process exited. Both focused cases pass; runner TypeScript build and server/UI typechecks pass. The initial rejection test correctly exposed that close reports incomplete durable settlement after startup rejection; the final assertion verifies that classification rather than suppressing it.

The direct UBS scan covers nine changed files but is partial:11critical/124warning/1088informational observations, with a JavaScript taint-work limit in the large transport/test component. The critical observations point to existing public Storybook secret identifiers/prefixes and an existing comparison of the adapter name with grok, not secret bytes. This is not a clean or complete scan. The follow-up completes across the other eight files with10critical/40warning/336informational observations; its critical findings are the same public Storybook fixture identifiers/prefixes. UBS Doctor verifies installed helper checksums; it does not establish complete dataflow coverage. No scanner suppressions or unrelated source changes are introduced.

Private c5 execution evidence remains distinct from this next candidate: one642-word proposal was saved as an editable document and a checksum-verified Markdown attachment; an actual accepted provider turn was cancelled, turn.interrupted recorded, and no runner/Codex process remained. A fresh human continuation reached the provider but failed with usageLimitExceeded / Quota exceeded. Revised artifacts, expanded boundary checks, the next exact image, real staff SSO and production recovery/cutover remain unaccepted. No personal payer fallback or billing-limit claim is made.

### Select an independently restored recovery pair

Rollback preparation exposed a manifest gap: the runbook required attaching independently restored database/state volumes, but Compose fixed their physical names. Both external names now share one explicit PAPERCLIP_FACTORY_RECOVERY_SUFFIX. Empty preserves the original V4 volumes; a verified recovery suffix selects the matching restored pair without overwriting the original upgraded state. Application-image source and deployment-manifest source remain separate identities; this manifest-only change does not rebuild the qualified application image.

Validation: three tests resolve the actual Compose configuration for normal volumes, a paired recovery suffix and missing-image refusal; no resources start. The initial fixture omitted required DATABASE_URL and correctly failed interpolation; the corrected fixture uses only disposable test credentials. Gitleaks scans the change. UBS scans the test file and reports3critical/2warning/4informational observations: two dummy secret fixtures and conservative environment-to-subprocess taint. The command is a fixed argv vector running Compose config only, with all referenced application variables explicitly set to fixture values; no shell or production credentials are used. This is not a clean-scanner claim.

### Bind approval decisions to pending hires in their company

The independent staged-upgrade review found a reachable cross-company/lifecycle defect in generic hire approvals. Both decision paths now lock an existing target inside the approval transaction and require its company to match and its status to be pending_approval before activation or termination. Invalid target IDs are rejected before querying. A refused target rolls back the decision itself. The supported no-target legacy creation path and already-resolved idempotent decisions remain unchanged.

Validation:11real HTTP/PostgreSQL cases cover foreign pending/paused targets, already paused/idle same-company targets, legitimate approve/reject with repeated decisions, and legacy creation. Denied decisions preserve target configuration, API keys, permission grants and pending approval state, with no wake or hire hook. Seven existing service and five dashboard tests pass. The existing11route-idempotency cases exceeded their30-second cold graph hook in the combined run, then all passed alone with a90-second hook allowance. Server typecheck passes. UBS completes across six changed implementation/test files with1critical/6warning/179informational observations; its critical finding is the existing public secret-1 fixture identifier, not credential material. Gitleaks reports no findings on the staged diff. Neither scan is described as universal security clearance.

The dashboard UTC-month query now also excludes the next-month boundary and later events; its PostgreSQL fixture includes both. A third real-runner startup case never answers initialize: it fails after the provider's30-second limit, records one launch and one initialize only, submits no turn, proves the provider process retired, and retains the unrecoverable-checkpoint classification while closing the exact runner. This focused case passes independently of account quota or model inference.
