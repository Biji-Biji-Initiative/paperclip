# Factory subscription-only AI policy

Factory sets the operator-owned `PAPERCLIP_AI_BILLING_POLICY=subscriptions_only`
deployment variable. An absent variable preserves upstream behavior; an unknown
value fails closed. Task settings and account preferences cannot change it.

The policy checks the resolved account method before selecting credentials,
validating a provider API key, reading usage, reconnecting an account or setting
its default. API account creation and re-enabling are rejected. Disabling an
existing account remains possible. A subscription preference does not authorize
an API account selected through a responsible-user default.

Unmanaged execution and unmanaged adapter tests are held. A protected Factory
worker must use its registered host subscription authority and cannot combine it
with a stored company AI binding, even a stored subscription. That check precedes
managed credential preparation, preventing copied authentication homes. Explicit
provider authentication overrides are rejected before resolving their secrets.
Initially only the registered protected Codex contract qualifies; Claude remains
held until its separate host and native contracts are integrated and qualified.

This is the control plane's AI account and execution policy. It does not prove
that arbitrary third-party plugins or assigned network tools cannot independently
contact a paid service. The first pilot therefore keeps unrelated grants disabled
and still requires process isolation, transport and actual account proof.

Four focused policy tests and two database regressions pass. The current live
Factory company has no shared AI connections, grants or defaults to revoke.
This source and deployment setting require a qualified new image before they
apply to production; they are not evidence that a live inference run succeeded.
