# Factory worker realms

Protected worker enrollment is operator configuration. It does not select a
provider account, create a worker or authorize an agent run.

The original `{ provider, workerPlanSha256 }` enrollment belongs only to
Biji-Biji company `740ad7ee-0c28-4e07-b9d1-ca7b35da820d`. Its fields and existing
worker history remain unchanged. A different company must have an explicit
`factory.provider-enrollment.v3` containing a `factory.worker-realm.v1` with
one company UUID and one authority ID, alongside its provider and immutable plan.
There are no wildcard or multi-company realm values.

Environments are instance-wide. Selecting an environment is not company
authorization. The acquired run, lease, agent and execution workspace must all
match the enrollment's company. The registered and selected enrollment must
also agree on provider, plan, company and authority. Account ownership remains
an independent host CAAM policy and authenticated direct-wake check.

The enrollment schema alone does not enable new tenants. Versioned realm
execution remains refused until the signed launch, native receiver and root-owned
worker policy all carry and verify its expected identity. The original Biji-Biji
enrollment remains the only executable legacy path. Each new realm requires
isolated worker home/workspace/key/authority state and actual native delivery, Stop and artifact
qualification. Existing Biji-Biji journals and held records must not be reset.
