# Factory dependency qualification — 2026-10-15

Base release: upstream `v2026.1012.0` / `bba6a45f0d364cfd962ac59b3bdf2426a8222adb`.

| Change | Reason and verification |
|---|---|
| Repair release lockfile | A frozen install rejected the tag's manifest because the server MCP SDK and light-my-request importer entries were absent. Lock-only reconciliation added 27 lines, retaining existing resolutions. A subsequent frozen install succeeds. |
| proxy-addr 2.0.7 → 2.0.8 | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h). The old library trusts an unrelated IPv4 peer under `::/1`; the patched library refuses it. Both pnpm override authorities and the lockfile are synchronized. The application regression covers that accepted configuration and a valid IPv4 subnet. Proxy/request-guard tests pass. |
| Node 24 build base → immutable digest | Pin `node:24-trixie-slim` at `sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315`, observed from the official image registry on 2026-10-15. Full image qualification remains separate from source checks. |

The source production dependency audit now reports **0 critical, 20 high,
33 moderate and 9 low** advisories. This is not a claim that all remaining
findings are reachable, resolved, or present in every runtime. Qualify each
compatible update separately; do not make untested major-version overrides.
Native provider pins remain unchanged, including Codex 0.160.0, to preserve the
release's qualified native runtime window.

The previously rehearsed official image and the deployed old image do not gain
these fixes from a source commit. A newly built, identified and rehearsed image
is required. Public staff access and real provider execution remain gated on
separate live acceptance evidence.
