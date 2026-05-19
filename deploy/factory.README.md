# Factory Paperclip deployment

This branch is the Mereka/Biji-Biji deployment fork for Paperclip AI at
`factory.mereka.io`.

## Source and version

- Upstream: `paperclipai/paperclip`
- Fork: `Biji-Biji-Initiative/paperclip`
- Deploy branch: `factory-deploy`
- Base release: `v2026.517.0`

The branch is pinned to a stable upstream release. Upstream `master` moves
quickly and publishes canary tags, so Coolify should deploy this branch rather
than `paperclipai/paperclip:master`.

## Coolify

Use Docker Compose with:

```txt
deploy/factory.coolify.compose.yaml
```

Service:

- app service: `server`
- app port: `3100`
- health check: `/api/health`
- worker: `deploy-apps-01`

Domains:

- canonical: `factory.mereka.io`
- shadow/proof: `paperclip-factory.deploy.mereka.io`

## Infisical

Authoritative path:

```txt
/deploy/paperclip-factory
```

Shared AI provider keys should be imported from:

```txt
/shared/ai
```

Do not commit generated `.env` files. Coolify variables should be synced from
Infisical or entered from Infisical readback.

## Auth model

Default launch mode is API-key-backed adapters through Infisical. This is the
least surprising production posture because the container only receives specific
provider keys.

Subscription-backed CLI auth is possible for Claude Code, Codex, and Gemini CLI,
but it should be enabled only after the app is healthy. Use
`deploy/factory.caam-subscription.override.yaml` and mount dedicated read-only
auth snapshots. Do not mount the whole CAAM vault.

## First boot

Keep `PAPERCLIP_AUTH_DISABLE_SIGN_UP=false` for first boot. Paperclip may emit a
one-time board-claim URL in logs for authenticated ownership setup. After the
first admin is claimed and invite flow is verified, set:

```txt
PAPERCLIP_AUTH_DISABLE_SIGN_UP=true
```

## Backup requirements

Back up both Docker volumes:

- `paperclip-factory-pgdata`
- `paperclip-factory-data`

`paperclip-factory-data` includes Paperclip instance files and secret material.
Losing the Paperclip secrets master key can make stored integration secrets
unrecoverable.
