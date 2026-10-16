# Factory native subscription ingress

This is a source contract, not permission to enroll credentialed workers. The
Factory server still admits Codex only; the native Claude implementation needs
separate account, artifact and complete worker qualification before admission.
Generic callers without an explicit protected ingress retain existing behavior.

## Selection and ownership

The worker delivers one bounded anonymous read pipe under
`PAPERCLIP_CODEX_EXTERNAL_AUTH_FD` or `PAPERCLIP_CLAUDE_EXTERNAL_AUTH_FD`.
Selecting both, an incompatible startup mode, an unsafe source, a foreign run or
retained provider state is a hold. The executable owns the descriptor before
startup parsing and consumes/closes it before providers or tools start.

The closed envelope is `{reference, accessToken, accessTokenExpiresAtUnixMs}`.
Reference fields bind the company, authorized profile and current run, lease,
normalized session, runner and admission deadline. Claude additionally compares
the worker's independently supplied `--factory-worker-plan-sha256` selector.
Task/provider JSON cannot supply that selector or private ingress authority.
Provider-bound signed admission and host policy are described in
[FACTORY_PROVIDER_ADMISSION.md](FACTORY_PROVIDER_ADMISSION.md).

Codex consumes at most 32 KiB; Claude consumes at most 16 KiB. Both require EOF
within two seconds, a current admission and access expiry covering admission plus
the host delivery margin. The private capability is consumed once; failed
projection/startup cannot restore it. Access and refresh credentials never enter
provider configuration, argv, persisted runner state or bearer environment values.
Canonical CAAM owns refresh; workers cannot renew or choose another account.

## Codex

Protected Codex initializes the app-server, privately submits
`account/login/start` with `chatgptAuthTokens`, verifies account/plan readback and
then creates a fresh thread. It rejects configured session IDs, resume requests,
API credentials/endpoints, local auth configuration and both external-sandbox
selectors before starting the provider. A final expiry check precedes spawn.

Authentication frames bypass normal raw-frame tracing. Protected tracing contains
fixed lifecycle metadata only; asynchronous and pending-RPC messages pass the same
reflection/identity guard before events or diagnostics. Known raw, base64,
base64url, hex and percent representations are checked; this is not a claim
against arbitrary covert encodings. Explicit foreign account/plan update fields
hold. Raw stderr is not retained. Refresh callbacks get a bounded fixed denial
and retire the owned provider.

## Claude

Native Claude selects only a qualified cold ACPX Claude profile with the expected
permission mode. It rejects retained state, reattachment, foreign identities and
admission changes. Its public session-open binding comes from the consumed host
authority, not from a provider descriptor.

Before threads start, the executable retains its own empty FD3/4 guards. A
non-cloneable, parent-consumed launch layout maps independent public metadata and
private access to child FD3/4. Trusted program/bootstrap artifacts use CLOEXEC
descriptors above those slots. Parent flags remain private; the binary alone
contains the narrow raw-descriptor and child mapper operations. The library keeps
`#![forbid(unsafe_code)]`. Reusing a command cannot replay the private layout.

The builtin-only TypeScript bootstrap consumes both frames before importing
runtime modules. Native checks wall and monotonic deadlines around transport
operations; the downstream access deadline is capped to the admission deadline.
Cleanup commands remain usable after expiry. The pinned guardian and SDK
descriptor interface provide the subsequent credential boundary; see
[FACTORY_CLAUDE_ACCESS.md](FACTORY_CLAUDE_ACCESS.md), including the persistent
ACPX-record rejection and its exclusive-ownership requirement.

## Evidence and remaining gates

The coordinated real crate passes an offline one-job Cargo check for the library,
binaries, examples and test targets. This compiles tests; it does not execute them.
Executed source checks include:

- 30 Codex guard tests and 34 actual provider/supervisor fixture tests, with
  external networking denied and synthetic credentials.
- Six executable Codex descriptor-ownership tests from the original handoff.
- 16 Claude contract/pipe and 13 actual child-descriptor tests importing the
  shared helper source.
- Four shared ACPX transport parsing/classification tests and a separate shared
  supervisor process fixture using pinned program/bootstrap descriptors.
- 80 TypeScript ACPX adapter tests and the runner TypeScript check.

Six additional native integration regressions compile but have not been run.
Focused Rust harnesses use documented light stubs for unrelated dependencies;
they do not replace the real crate integration check. Secret scans pass.
Completed UBS slices have warnings; larger/TypeScript attempts include timeouts.
No clean whole-crate scanner claim is made.

Still required before credentialed jobs: typed operator-hold delivery through
native terminal results and application retry/recovery handling; exact new
artifact/image identification and scans; actual signed host-to-worker pipe
execution; public runner protocol round-trip; named company subscription
entitlement; provider/tool/proc confinement; expiry, cancellation and controller
loss; and the human staff-login/task pilot. Owned process-group retirement is
not proof that every possible escaped descendant has retired.

Do not infer operational readiness from these source tests. Never enable an API
billing fallback or restore a consumed/revoked capability to bypass a hold.

## Factory native image build

Factory image builds must pass `--build-arg PAPERCLIP_RUNNER_SUBSCRIPTIONS_ONLY=true`.
The same inherited build argument disables default Cargo features for dependency
cooking, the final runner build and later recursive package builds. This omits
managed API provider dependencies;
the resulting runner explicitly rejects managed provider selection and retained
managed state. The default remains `false` for ordinary upstream images; any
other value fails the build before invoking Cargo. Runtime billing policy remains
a separate required application setting.
Bounded builders can also pass `--build-arg CARGO_BUILD_JOBS=1`; this is inherited
by the native stages and recursive package build without changing the default.

The build-mode shell regression verifies actual arguments in both stages. It is
not an image build, native artifact, compiler/ABI or provider qualification.
