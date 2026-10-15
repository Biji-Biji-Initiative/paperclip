# Factory dependency qualification — 2026-10-15

Base release: upstream `v2026.1012.0` / `bba6a45f0d364cfd962ac59b3bdf2426a8222adb`.

| Change | Reason and verification |
|---|---|
| Repair release lockfile | A frozen install rejected the tag's manifest because the server MCP SDK and light-my-request importer entries were absent. Lock-only reconciliation added 27 lines, retaining existing resolutions. A subsequent frozen install succeeds. |
| proxy-addr 2.0.7 → 2.0.8 | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h). The old library trusts an unrelated IPv4 peer under `::/1`; the patched library refuses it. Both pnpm override authorities and the lockfile are synchronized. The application regression covers that accepted configuration and a valid IPv4 subnet. Proxy/request-guard tests pass. |
| Node 24 build base → immutable digest | Pin `node:24-trixie-slim` at `sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315`, observed from the official image registry on 2026-10-15. Full image qualification remains separate from source checks. |

After the proxy-addr update, the source production dependency audit reports **0 critical, 20 high,
33 moderate and 9 low** advisories. This is not a claim that all remaining
findings are reachable, resolved, or present in every runtime. Qualify each
compatible update separately; do not make untested major-version overrides.
Native provider pins remain unchanged, including Codex 0.160.0, to preserve the
release's qualified native runtime window.

The previously rehearsed official image and the deployed old image do not gain
these fixes from a source commit. A newly built, identified and rehearsed image
is required. Public staff access and real provider execution remain gated on
separate live acceptance evidence.

## Subsequent URI patch

`fast-uri` 3.1.2 → 3.1.7 addresses the authority-injection and normalization
advisories, including [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3).
The old dependency serializes a crafted port into a different host. The patched
dependency throws, and valid URI serialization and AJV schema/reference behavior
remain correct. Targeted dependency/auth integration checks: 28 tests pass.
This patch is restricted to the existing 3.x dependency line. It requires a new
identified image; it does not alter the earlier image build already running.

After the URI patch, the production dependency audit reports **0 critical and 13 high** advisories.

## Undici 8.x security patch

`undici` 8.10.0 → 8.10.2 follows the upstream security patch for WebSocket,
BalancedPool TLS and cache-origin isolation. The override is restricted to 8.x;
no untested cross-major upgrade is applied to the older Cursor SDK transport.
The application's jsdom consumers pass all 57 targeted UI tests. The production
source audit now reports **0 critical and 10 high** advisories (6 low, 28 moderate).

## Sharp native image security patch

`sharp` 0.35.4 → 0.35.5 includes librsvg 2.63.2 for
[GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).
The installed native library reports Sharp 0.35.5, librsvg 2.63.2 and
libvips 8.18.7. Avatar, Telegram photo and Teams inline-image tests pass
(58 tests). The production source audit reports 0 critical, 9 high,
28 moderate and 6 low advisories. The pending image build predates this patch;
only a subsequent identified rebuild will include it.
