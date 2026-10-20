# Factory worker realms

Protected worker enrollment is operator configuration. It does not select a
provider account, create a worker or authorize an agent run.

The original `{ provider, workerPlanSha256 }` enrollment belongs only to
Biji-Biji company `740ad7ee-0c28-4e07-b9d1-ca7b35da820d`. Its fields and existing
worker history remain unchanged. A different company must have an explicit
`factory.provider-enrollment.v3` containing a `factory.worker-realm.v1` with
one company UUID and one authority ID, alongside its provider and immutable plan.
It requires worker policy `factory-worker-scope-v3`; a legacy enrollment cannot
use that policy, and a v3 enrollment cannot downgrade to scope v2. There are no
wildcard or multi-company realm values.

Environments are instance-wide. Selecting an environment is not company
authorization. The acquired run, lease, agent and execution workspace must all
match the enrollment's company. The registered and selected enrollment must
also agree on provider, plan, company and authority. Account ownership remains
an independent host CAAM policy and authenticated direct-wake check.

The v3 launch, worker binding, preparing/accepted receipts and signed controller
record carry the same exact realm. Its SSHSIG namespace is
`factory-provider-admission-v3@mereka.io`; legacy v2 signatures do not authorize
v3 requests. The signer principal remains specific to the company UUID. The
root-owned worker and authority policy independently check that company,
authority, immutable plan and actual worker identity before selecting an account.

Only the worker appends the native `--factory-company-id` and
`--factory-authority-id` selectors. Request-provided selectors are refused. The
native runtime retains this independently expected realm with its owned
capability and checks both identities on the host-delivered reference. Without
the selectors, capability intake remains legacy Biji-Biji only. Claude also
checks the realm across its two inherited sidecar frames and private SDK handoff;
the public realm never carries account credentials or a profile selector.

Source support does not create or qualify a tenant runtime. Old receivers refuse
the distinct v3 marker, and a new tenant needs isolated worker home, workspace,
SSH keys, authority journal and slot/history state. Actual native delivery, Stop
and artifact qualification remain required before enabling agents. Existing
Biji-Biji journals and held records must not be reset. Workspace staging exclusion
uses the host key, company and workspace; changing a plan or authority cannot
bypass a held workspace owner.
