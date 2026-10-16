# Native SSH foreground ownership — qualification contract

Oracle handoff baseline: `aef2d6e299e9af78b48cbbf9ab56998e2894888a`.
Integrated after the argv correction in `129aec010`.
Scope: native SSH foreground runner ownership and argv correctness. No CAAM,
provider-account, worker-image/controller, fleet, database-schema or production
configuration changes are included.

## Implemented boundary

Generic SSH command runners retain their login-profile and configured identity
behavior. Both generic and native one-shot commands preserve the executable and
entire argument vector, including shell `$0`, positional arguments, empty strings,
quotes, newlines and environment values. Environment names and NUL are checked.

`createRunnerdBackendWithinSessionClaim` explicitly selects `owned_foreground`
for native SSH. That mode uses the aef application's qualified absolute SSH client
path `/usr/local/bin/ssh`, one temporary dedicated identity and the supplied
known-hosts file. It disables SSH agents/config files/alternate certificates,
connection multiplexing, forwarding, proxy commands and interactive fallback.
It never sources user profiles. Generic host behavior is not globally changed.

The native SSH launcher uses `openDuplexChannel`, awaits staging, then keeps a
foreground SSH command for runnerd's lifetime. Native `dial_wss` PRP remains the
work/control transport. Sandbox/provider launchers keep the original detached
launcher. Missing SSH duplex support is an error, never a detached fallback.

No remote PID is invented or inspected from a different SSH namespace. Process
metadata does not relabel the local SSH client's PID as runnerd's PID.

## Exit, Stop and ownership

OpenSSH exit codes 0..254, without a local cancellation/signal/error, are remote
command exit observations. Exit 255 is ambiguous with a transport failure and is
always classified as unverified. Unverified process completion rejects rather
than resolving `{code:null}`: the baseline PRP watcher treats a resolved
completion as an observed exit. A local SSH kill/close is NEVER a remote tree
retirement receipt, even if the updated worker normally retires its namespace.

The secret-free `ssh-foreground-owner.json` in the existing controller-owned
native session root is acquired exclusively before launching/staging under that
launcher. It contains a nonce, run/runner identities and lifecycle state, not
credentials, argv, bootstrap tickets or provider output. Admission checks it
before native SSH backend staging/authority rotation. It is retained on ambiguity.

Only this live owner, a known remote command exit, successful SSH cleanup, and the
existing native PRP `settled` checkpoint permit automatic retirement of the
active receipt. The last receipt is retained under a nonce-named history file.
Unsettled/unknown ownership, transport loss or a changed receipt fails through
`NativeRunnerOwnershipUnverifiedError`. A pre-existing native checkpoint exception
keeps its original classification while the durable receipt still blocks reuse.

`child.kill()` latches cancellation even before channel open. Late-open channels
are stopped and closed. Stop/close are idempotent; TERM escalates to local SIGKILL
within bounded deadlines. A stage which ignores cancellation cannot later launch
a runner; its incomplete outcome retains a hold. This patch cannot cancel an
arbitrary already-running staging API promise, so bounded return does not claim
that every underlying staging side effect has ended.

## Deliberate limitations

* Automatic SSH controller-restart adoption/reattachment and warm-transition
  recovery are refused in this increment. No cross-command PID fallback is used.
  The old owner receipt survives a controller crash. A missing controller or
  elapsed time is not permission to clear it or replay an accepted turn.
* Do not blindly delete the receipt. Existing operator reconciliation must prove
  the original worker lease/tree retired and reconcile possible accepted work
  before quarantining the hold and authorizing a fresh human continuation. No
  automatic hold-clear or provider-credential operation is supplied.
* A remote SSH exit is useful only with the independently qualified worker
  lifetime boundary. This patch does not implement that worker boundary, global
  worker concurrency, per-role home isolation or TLS ClientHello validation.
* PRP settlement and application hold propagation must be verified end to end on
  the candidate image. The focused tests do not replace that test.
* The native path requires its declared dedicated key and host pin. Existing
  generic profiles are not silently converted into dedicated worker identities.

## Reproduce focused tests

After applying the patch to the pinned checkout with development dependencies:

```sh
node scripts/test-native-ssh-foreground.mjs
pnpm --filter @paperclipai/adapter-utils typecheck
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/adapter-utils build
pnpm --filter @paperclipai/server exec vitest run \
  src/services/native-runtime/native-ssh-command-runner.test.ts
```

The focused runner compiles the new modules in a disposable directory and extracts
its assignment-check interfaces from the actual checkout. Its tests use local
child processes and controlled channels. They never contact SSH or a provider.
The existing output-budget test remains generic by default; add the actual strict
worker path to the private integration suite rather than inserting credentials in
that unit fixture. Full package/server checks and live SSH are release gates.

## Mandatory real-worker / native PRP acceptance (not run by this handoff)

Use a private candidate control-plane copy and the exact approved, credential-free
worker. Keep production agents paused and Local archived.

1. Verify source/image identity, dedicated client executable, exact worker key
   and pinned host key. Wrong/missing key or pin, available operator agent, and
   a hostile user SSH config must not enable a connection. Confirm actual argv,
   stdin, EOF, nonzero status, large staging transfer and exact artifact bytes.
2. Start the real Rust runner foreground through native SSH and `dial_wss` PRP,
   with a synthetic/non-inference provider fixture. Staging must complete first;
   startup must not detach or use a cross-command PID to claim liveness.
3. Complete a fixture turn, prove PRP drain/suspension, receive real SSH exit and
   checkpoint the artifact/session. The active owner receipt must retire only
   after all those conditions. A new human fixture continuation must preserve
   the artifact and revise it without replaying the prior turn.
4. Stop before staging completes, before open, during authentication, during a
   turn, and during close. Include TERM-resistant, double-fork and setsid tool
   descendants. Inspect from the worker owner's namespace that every child is
   gone; the local SSH PID disappearing is not the observation.
5. Drop the TCP relay, kill the SSH client, restart/crash the candidate controller,
   interrupt PRP while SSH stays open, and return exit 255. Verify durable holds,
   no silent successor, no automatic accepted-turn replay and no detached fallback.
   Prove any owned worker shutdown independently before operator reconciliation.
6. Request Stop twice and shutdown twice. Prove bounded return, one cleanup path,
   no overwritten failure classification, and no loss of late exit/output events.
7. Re-run the unchanged sandbox/provider launcher acceptance. This increment
   must not change its PID/nonce-based detached-process lifecycle.

Only after these pass should the separate CAAM external-authority slice begin.

## Local qualification — 2026-10-16

The checksum-verified Oracle bundle was integrated without reverting the argv
correction. The focused compiler runner uses the installed TypeScript CLI,
including TypeScript7, and extracts the actual checkout interfaces. The channel
kill test allows the production two-second kill-observation grace rather than
assuming process reaping within30ms on a loaded host.

Executed:31 focused tests,20 existing SSH/ownership tests, adapter typecheck,
and server `tsc --noEmit` pass. SSH uncertainty now enters the scheduler's durable
ownership hold; local PID absence cannot clear that hold.
The existing executor's17 selected ownership/recovery cases,5 remote wiring
cases and the missing-key/pin rejection case also pass. The latter cases use
non-network fixture identities; actual SSH is covered by the separate live probe.

Gitleaks passes over the complete diff plus all new files. UBS completes on11
new/helper files with0critical,17warning and212informational findings. Warnings
are the deliberately killed interval fixtures, fail-fast test JSON parsing,
guarded owner/channel/credential assertions, an abort listener removed by
`finish`, and a promise with both fulfillment and rejection handlers. The broad
15-file scan including the large scheduler/executor times out at300s with0files
reported; it is incomplete, not a passing scan. The ordinary server typecheck
script also builds the unchanged Rust runner; direct `tsc --noEmit` is the
completed server compilation check recorded here.

A credential-free controller probe using the qualified image's absolute SSH
client reached the actual g2 worker. Full argv/environment/stdin, bidirectional
streaming, normal exit plus checkpoint release, and an uncertain Stop hold
surviving a fresh owner object passed. An independent worker namespace inspection
found no remaining marked TERM-resistant fork/setsid descendants. The disposable
controller was removed after exit0. No provider inference was requested.

This qualifies the transport and owner seam. The real Rust `dial_wss` PRP,
whole-application checkpoint/recovery behavior, workspace continuation, worker
scope/admission and subscription accounts remain release gates. No worker
enrollment or production deployment is authorized by these transport results.

## Explicit Factory lease opt-in — 2026-10-16

Dedicated SSH accepts an optional validated Factory worker descriptor. Its exact
fixed marker and bounded JSON stdin header preserve argv/environment without
placing the launch payload in the SSH command string. Admission consumes one
identity-bound receipt before returning the lifetime channel. A busy refusal is
retryable only after the matching nondispatch receipt, actual SSH exit75 and
successful cleanup. An accepted runner's exit75, malformed receipt, loss or failed
cleanup cannot become safe busy. The foreground owner releases its local fence
only for that verified nondispatch case; uncertainty retains the durable hold.

The optional descriptor does not select a production worker or enroll an account.
No executor metadata defaults or model-provided IDs are accepted. Authoritative
resolved run/environment binding, scheduler busy integration and the actual
native bootstrap environment allowlist remain required before activation.

`node scripts/test-factory-worker-lease.mjs` runs the focused lease tests. Set
`FACTORY_FOREGROUND_TEST_DIRECTORY` to `scripts/tests/native-ssh-foreground` to
include the original tests:50 cases pass locally. `FACTORY_NODE_TYPES` can point
to the installed adapter package's `node_modules/@types/node`; no package download
is performed. The original foreground harness still extracts and compiles the
actual interface contracts and independently passes31 cases. Both harnesses use
the installed TypeScript CLI. Adapter typecheck and direct server `tsc --noEmit`
also pass; no full Rust rebuild is claimed for this TypeScript-only change.

A separate disposable candidate on g2 passes32 Python tests with zero skips under
the actual enforcing AppArmor/seccomp, cap-free UID1000 policy. Pristine actual
forced-command tests prove scoped mounts, sibling/control denial, persistent own
artifacts, read-only common binaries, fresh homes, admission and retirement. A
pinned SSH fixture using these compiled client modules passes two artifact
revisions, typed busy before dispatch and EOF143 with no exact-argv workloads
remaining. Full native Rust PRP through this scoped candidate remains unproved;
the earlier Rust lifecycle receipts refer to worker014. No provider credentials,
inference, production worker registration or deployment was performed.

Focused UBS scans4 changed client modules:0 critical,5 warning,74 info. Warnings
are non-null assertions following validated key material, acknowledged admission,
claimed owner state or assigned channel. The Python worker scan and fixture
failure history are retained in deploy.mereka.io's candidate qualification proof.
These scans are not an image vulnerability clean bill.


## Policy revision2 and real scoped native runner

`factory-worker-scope-v2` additionally accepts only native PRP bootstrap ticket
syntax `bootstrap_<canonical UUID>`. This is one-use runner authority, not a
provider account credential. API keys, provider tokens and endpoint overrides
remain rejected. UUID length is checked explicitly, including trailing-newline
negatives. Old policy descriptors are refused by the new candidate.

The51 focused lease/foreground cases pass. Both focused harnesses now create
relative package links so their retained builds work inside disposable Docker
qualification controllers. Adapter and direct server TypeScript checks pass.

The exact corrected candidate passes real Rust normal and interrupted scripted
turns inside its scoped lease, with settled checkpoint and foreground release.
An actual startup disconnect race found and corrected in the worker is covered
by24 immediate EOF cases and33 Python tests under the actual worker policy.
The production public PRP route, actual CAAM account connection and full native
server/browser task continuation are still separate gates; no environment or
provider account was enrolled. Exact image/source identities and failed runs
remain in deploy.mereka.io's revision2 qualification proof.
