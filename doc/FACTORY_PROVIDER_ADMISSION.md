# Factory signed provider admission

`openDedicatedSshDuplex` accepts an explicit `providerAdmission` binding only with
a worker lease. This chooses the separate Codex-only
`factory-worker-provider-lease-v1` protocol. Ordinary workerLease callers retain
the credential-free v1/scope-v2 protocol.

The adapter validates the actual native argv run/lease/session/runner IDs, awaits
the preparing challenge, binds nonce/boot/creation/deadline to its current frozen
plan and signs canonical metadata. Signing uses the existing temporary scoped
SSH key and `/usr/local/bin/ssh-keygen` from the application image, with namespace
`factory-provider-admission-v1@mereka.io`. No key or provider bearer enters the
wire record. Abort, timeout, premature EOF or unexpected channel data closes the
owned channel and cancels its signer. Only a matching accepted receipt admits the
lifetime channel; a strict busy receipt additionally requires real exit 75.

The registered SSH environment may explicitly contain
`factoryProviderAdmission: { provider: "codex", workerPlanSha256: "<64 lowercase hex>" }`
alongside the existing Factory worker policy. Absence preserves credential-free
execution. Unknown keys/providers, missing policy and malformed hashes are rejected.
No live environment is enrolled by this source change.

`createAuthorizedFactoryWorkerAdmission` rereads the current run/company/workspace,
active environment lease and registered config after staging. The target's selected
mode must exactly match current registration. Codex mode additionally requires
the actual stored native session and runner instance; each admitted attempt gets
fresh admission/capability IDs. The foreground owner validates its own runner and
the exact native argv, then forwards `providerAdmission` alongside workerLease.
The older lease-only helper rejects an explicitly registered provider mode.
Authority never comes from model text; the v2 default is unchanged.

The root-host fixed policy chooses the canonical CAAM profile/account/source;
the signed request never selects source paths or account material. Host receiver
installation, source mapping, entitlement, native FD consumption and actual tool
confinement remain deployment gates. These source helpers do not connect accounts.
Claude needs a distinct reviewed provider contract rather than Codex account fields.

Focused checks: run Vitest for `factory-provider-admission.test.ts` and
`factory-provider-lease-channel.test.ts`, then adapter-utils typecheck. Fixtures
use disposable signing keys and synthetic channels; no account or provider calls.
Rollback before enrollment removes unused opt-in source. After enrollment, stop
issuing admissions and retain host irreversible claim journals across rollback.
