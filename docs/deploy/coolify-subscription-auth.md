---
title: Coolify subscription CLI auth
summary: Run Paperclip on Coolify with Codex and Claude subscription logins instead of model API keys
---

# Coolify Subscription CLI Auth

Paperclip's local adapters run vendor CLIs as child processes of the Paperclip
server. In a Docker/Coolify deployment, "subscription auth" means the CLI is
logged in inside the running Paperclip container, and the login files live on a
persistent volume.

For a Coolify app, use the container user's `$HOME` as the durable auth root.
In the factory deployment this is `/paperclip`, mounted from the app data
volume. Do not rely on your laptop login, a host-level CAAM active profile, or a
temporary helper container. The running Paperclip server container must be able
to read the auth files.

## Codex

Codex subscription auth is stored in `$CODEX_HOME/auth.json`. The normal default
is:

```sh
/paperclip/.codex/auth.json
```

To seed from CAAM without browser login, copy the chosen CAAM vault auth file
into the persistent Paperclip home:

```sh
PROFILE=g5
docker exec -i <paperclip-server-container> sh -lc '
  mkdir -p /paperclip/.codex
  cat > /paperclip/.codex/auth.json
  chmod 700 /paperclip/.codex
  chmod 600 /paperclip/.codex/auth.json
'
```

Pipe the local CAAM file into that command:

```sh
cat ~/.local/share/caam/vault/codex/$PROFILE/auth.json | \
  ssh <server> "docker exec -i <paperclip-server-container> sh -lc 'mkdir -p /paperclip/.codex && cat > /paperclip/.codex/auth.json && chmod 700 /paperclip/.codex && chmod 600 /paperclip/.codex/auth.json'"
```

For multiple accounts, keep one home per profile:

```text
/paperclip/caam-codex-profiles/g5/codex_home/auth.json
/paperclip/caam-codex-profiles/g6/codex_home/auth.json
/paperclip/caam-codex-profiles/g7/codex_home/auth.json
```

Then set an individual agent's adapter env to:

```dotenv
CODEX_HOME=/paperclip/caam-codex-profiles/g6/codex_home
OPENAI_API_KEY=
```

Deployment-level `OPENAI_API_KEY` can exist for explicit API-key tooling or
fallback use, but subscription-backed Codex agents should blank it in their own
adapter env. If `OPENAI_API_KEY` is non-empty in the effective process
environment, Paperclip records the run as API-key mode and Codex may bypass the
subscription login.

Verify from the running container with the API key explicitly unset:

```sh
docker exec <paperclip-server-container> sh -lc '
  cd /paperclip &&
  env -u OPENAI_API_KEY CODEX_HOME=/paperclip/.codex \
    codex exec --json --skip-git-repo-check - <<EOF
Reply exactly PAPERCLIP_CODEX_OK
EOF
'
```

The output should include an agent message with `PAPERCLIP_CODEX_OK`.

## Claude

Claude subscription auth is stored under the Claude config directory. For a
container deployment, seed these files into the persistent Paperclip home:

```text
/paperclip/.claude/.credentials.json
/paperclip/.claude/.claude.json
/paperclip/.claude/settings.json
```

For remote managed execution, the Claude adapter snapshots this config and
materializes it for each run. Deployment-level `ANTHROPIC_API_KEY` can exist for
explicit API-key fallback, but subscription-backed Claude agents should blank it
in their adapter env when subscription billing is desired. If `ANTHROPIC_API_KEY`
is non-empty in the effective process environment, Claude Code uses API-key mode
instead of local subscription credentials.

Verify with:

```sh
docker exec <paperclip-server-container> sh -lc '
  cd /paperclip &&
  env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=/paperclip/.claude \
    claude --print - --output-format stream-json --verbose <<EOF
Reply exactly PAPERCLIP_CLAUDE_OK
EOF
'
```

## Coolify Env Rules

- The Paperclip data volume must persist `/paperclip`.
- Model API keys may remain in Coolify for explicit fallback or special tooling,
  but do not rely on them for default Codex/Claude agents when subscription
  billing is intended.
- For subscription-backed agents, set profile-specific auth homes in adapter env
  and blank the matching model API-key variable:
  - Codex: `CODEX_HOME=/paperclip/caam-codex-profiles/<profile>/codex_home` and `OPENAI_API_KEY=`
  - Claude: `CLAUDE_CONFIG_DIR=/paperclip/caam-claude-profiles/<profile>/claude_config` and `ANTHROPIC_API_KEY=`
- Redeploy/restart after deployment-level env changes; verify the running
  container, not only the Coolify API status string.

## Proof Checklist

Before declaring subscription auth ready:

1. `docker exec` shows `HOME=/paperclip`.
2. `/paperclip/.codex/auth.json` exists for the default Codex account.
3. Any per-agent Codex homes exist under `/paperclip/caam-codex-profiles/...`.
4. `codex exec` succeeds with `OPENAI_API_KEY` unset.
5. Claude is either not used, or `claude --print` succeeds with
   `ANTHROPIC_API_KEY` unset.
6. Subscription-backed agents have profile-specific adapter env and blank
   model-key overrides.
7. The public health endpoint returns `{"status":"ok"}` after restart.
