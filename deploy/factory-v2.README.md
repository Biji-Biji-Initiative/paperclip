# Paperclip Factory v2 deployment contract

`factory-v2.coolify.compose.yaml` is a fresh, isolated Paperclip Factory
runtime based on the current upstream source snapshot. It is deliberately not
an in-place update of the legacy `factory-deploy` workload.

## Security boundary

- No CAAM, Codex, Claude, Hermes, or host-home directory is mounted.
- No OpenAI, Anthropic, Gemini, or Google provider key is injected into the
  server process.
- `HEARTBEAT_SCHEDULER_ENABLED=false` ensures no agent heartbeats run during
  rollout or validation.
- `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` keeps a public v2 instance closed
  until the owner claims a one-time bootstrap invite.
- The dedicated v2 signing keys are stored in Infisical; they are not inherited
  from the legacy instance.

## Rollout sequence

1. Provision a separate Coolify application and bind it to this compose file.
2. Set the keys from `factory-v2.env.example` in the dedicated Infisical path.
3. Prove `/api/health`, strict auth, no scheduler activity, no CAAM mounts, and
   no ambient provider environment variables.
4. Create and securely store a one-time first-admin bootstrap invite.
5. Install a v2-specific database-plus-state backup/restore job and prove it.
6. Only then perform a controlled domain cutover, retaining the legacy app as
   rollback until the monitoring window closes.

The current source includes the `hermes_local` and `hermes_gateway` adapters,
but neither is enabled by this compose file. `hermes_local` requires a dedicated
Hermes CLI/runtime and scoped credentials; `hermes_gateway` requires an explicit
remote HTTPS API and a scoped Paperclip task-bridge key. Neither belongs in this
public control-plane container by default.
