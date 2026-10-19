# Factory spend account attribution

Work record: deploy.mereka.io `deploy-p5x.7.6.1.1`. Existing Costs reporting had
provider, biller, model, agent/project, dates and budgets. It lacked a Settings
entry and an account breakdown. Add those using existing cost events and saved
heartbeat metadata, without a schema change or another ledger.

The company cost-read boundary stays in place. The normal AI connection metadata
service determines which account references a human may inspect. Join events to
runs only on run/company/agent identity, then expose a saved connection/grant pair
only if it matches a visible provider account. All other usage stays in a null
account bucket; totals do not change when account visibility changes. Current
agent configuration, email, model and mutable connection names are not historical
attribution. Agent readers receive no human account identities.

The Accounts tab uses the selected dates and shows provider/biller/model, billing
type, token total, recorded charges, unpriced count, matched run and event counts.
Errors remain visible. No provider quota/auth read or refresh follows from this
view. The qualified protected host has no stored managed account binding; absent
an authoritative retained account receipt, its account stays unknown. Unpriced
subscription usage is not free or bounded by recorded-dollar thresholds.

Verification covers real PostgreSQL aggregation above int32, historical selection
preservation, invisible/missing/foreign-company/wrong-agent references, unchanged
unknown totals, date filters, route audience/authorization, and rendered known,
unknown, error and inactive-tab states. Run focused cost and UI tests, shared and
server/UI compile checks, the token gate and UI build. Live acceptance remains
the separate `.1.2` task after a bounded subscription pilot; local fixtures cannot
establish provider charges or a deployed Settings journey.
