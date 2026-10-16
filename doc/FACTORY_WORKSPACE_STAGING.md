# Factory workspace staging ownership

Factory SSH environments with `factory-worker-scope-v2` acquire a durable staging
owner before the first remote workspace command. Generic SSH behavior is unchanged.
The worker model slot is acquired later and remains a separate boundary. The first
subscription pilot stays serial until the complete runtime path is qualified.

`server/src/services/factory-workspace-staging.ts` owns admission. A PostgreSQL
transaction locks the SHA-256 scope using `pg_advisory_xact_lock`, checks persisted
company/run/workspace/enrollment bindings and inserts the environment lease. The
scope includes company, exact `/workspace/<company>/<workspace UUID>` path and one
pinned SSH public host key. Different environment IDs, hostnames and forwarded ports
for the same worker do not grant overlapping staging ownership. Different fixed
workspaces can stage independently; worker admission still serializes model work.

Fresh acquisition precedes native envelope admission. An unresolved legacy run
may express native intent only through its database-bound Paperclip runner agent,
exact task/workspace context, current legacy controller boot and unexpired
controller lease. The heartbeat also requires the native feature to be enabled.
Already-resolved legacy runs are refused. Do not rewrite the runtime mode early:
the preparation controller still needs its existing lease-renewal contract.
The distinct `factory_workspace_staging_unverified` running/terminal-failure hold
is recognized by both in-memory and SQL ownership predicates in this early phase.

A same-controller, same-run capacity retry may reuse its exact active lease after
initial preparation completes. The pinned enrollment, environment, company,
workspace and run must still match. Re-entry performs no second preparation;
foreign controllers and changed enrollment cannot adopt the lease.

The lease's `factoryWorkspaceStaging` metadata is a durable ownership journal, not
an expiring lock. Generic lease release, terminal run status, cancellation, controller
restart and elapsed time do not clear it. An existing active pre-gate SSH lease for
the same workspace also blocks admission. A preparation failure remains held because
an SSH error does not prove the remote upload or command stopped. Errors persisted
by this helper are fixed strings and contain no SSH output or provider results.

Normal completion must invoke the internal `settleFactoryWorkspaceStaging` hook
with the exact controller DB instance, run and lease. Its `verifyQuiescence` callback
must await the owned foreground checkpoint and all staging SSH/SFTP children. A
verified worker-busy refusal must keep this owner held across same-lease retries.
Scheduler re-entry reuses only that controller's exact lease. Invoke `assertFactoryWorkspaceStagingOwned`
before each resumed upload; do not release on busy unless the retry also reacquires
the gate before uploading. A receipt-shaped object or the absence of a foreground
owner is insufficient proof for release.
The callback and process-local ownership capability are host code, never model/API
arguments. The database update compares the durable owner ID and exact lease/run.
A new controller cannot reconstruct this capability from persisted metadata.

Staging contention is a separate nondispatched capacity condition. It must not be
represented as a worker-admission receipt, provider failure, consumed provider
attempt, fallback or permission to upload. The heartbeat environment-acquisition
path must defer it before entering native execution.
Only fresh foreign-holder contention may schedule a new nondispatched run. An
admitted input, self-holder, explicit ownership hold, expired execution deadline
or stale legacy controller requires reconciliation; it never permits automatic
takeover or an endless capacity retry against an uncertain owner.

## Fresh tasks and bounded uploads

Enroll each SSH environment against one fixed workspace and set the project's
`executionWorkspacePreference` to `reuse_existing`. A new Factory task starts a
fresh normalized provider session and runner identity, with the previous task's
bounded document/summary handoff. It cannot reuse an old run's durable lease or
checkpoint. A verified same-run capacity retry preserves its admitted identity.

Factory preparation never probes host Git configuration or stages generic GitHub
wrappers through the raw SSH adapter. The initial pilot has no configured GitHub
access; configured GitHub dispatch remains held until its native credential path
is qualified. No host credential default or broker token bypasses that boundary.

`native-runtime/factory-remote-staging.ts` pins destination directories through
no-follow file descriptors and atomically replaces regular files. Directory
uploads validate bounded archives into a fresh tree, preserve confined relative
package links and reject escaping links, hard links, special files and path
traversal. They do not extract through a model-owned destination directory.
The staging ownership gate still spans these uploads and foreground retirement.

## Reconcile an uncertain owner

There is deliberately no automatic takeover or age-based reclaim operation.
An operator must first stop scheduling the affected worker/workspace and preserve
the exact lease/run/owner journal and controller receipts for review. Enumerate
aliases by the pinned host key and workspace, not by one environment UUID.

Prove the old controller and every staging SSH/SFTP child have retired, and obtain
independent worker process/namespace and durable-owner readback. A successful new
SSH connection, terminal database run status or empty worker slot alone does not
prove old uploaders have stopped. Preserve human work products; reconcile partial
runtime assets against the qualified manifest before another launch.

Only after that proof may an explicit operator repair transaction take the same
advisory scope lock, compare the exact held lease/run/owner ID, and mark that
journal released with an immutable reconciliation-evidence reference. Snapshot the
old metadata and prepare rollback before changing production state. Do not delete
lease rows, alter timestamps to simulate expiry, or clear unrelated owners.
Re-enable scheduling and demonstrate the next acquisition precedes all uploads.

## Evidence

`factory-workspace-staging.integration.test.ts` uses real PostgreSQL and independent
controller connections. It checks competing aliases, distinct workspaces, durable
failed preparation, cancellation/expiry/generic-release refusal, failed quiescence,
valid settlement, stale completion and unauthorized bindings. These tests establish
database exclusion; they do not replace a real worker upload/retirement proof or
qualify the provider account and production pilot.

`factory-remote-staging.test.ts` exercises the actual Python filesystem program.
Separate credential-free staged-worker checks validate the same program through
the existing dedicated SSH staging route; neither proof enrolls a provider.
