# Factory dependency advisory repair — 2026-10-16

Work record: `deploy-iys`. This is a source dependency repair; it does not
change the running Factory application or staged worker image.

## Baseline

The production-dependency lock audit (`pnpm 9.15.4 audit --prod --json`)
reported **0 critical, 0 high, 18 moderate and 3 low** advisories across 1,175
dependencies before this change. The critical `proxy-addr` and previous high
advisories were already addressed in this checkout's manifests and lockfile.
Older image reports are not a current source audit.

Both `package.json#pnpm.overrides` and `pnpm-workspace.yaml#overrides` must
carry the same policy: the installed newer pnpm launcher warns that it ignores
the former before dispatching to the declared `pnpm@9.15.4` toolchain.

## Narrow upgrades

| Dependency | Before | Target | Reason |
| --- | --- | --- | --- |
| `fast-uri@^3.0.0` override | 3.1.7 | 3.1.8 | Normalize percent-encoded host casing consistently. |
| `qs@^6.0.0` override | 6.15.0 / 6.15.3 / 6.16.0 | 6.16.0 | Close bracket-array limit bypass and hostile `constructor.isBuffer` crashes; preserve nested query parsing. |

Maintainer sources:

- [fast-uri 3.1.8 security release](https://github.com/fastify/fast-uri/releases/tag/v3.1.8)
  and [host normalization advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-hrr3-gc8f-f4qj).
- [qs 6.16.0 release](https://github.com/ljharb/qs/releases/tag/v6.16.0)
  and [hostile isBuffer advisory](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g).

## Verification

- The `fast-uri` 3.1.8 registry tarball matched its SHA-512 registry integrity.
  Direct regression checks passed for percent-encoded host equivalence,
  ordinary host parsing and relative URI resolution.
- Direct `qs` 6.16.0 checks passed for nested parsing, bracket-array limits,
  hostile constructor values and null/undefined comma-format serialization.
- Real loopback Express requests passed with an explicitly injected `qs`
  6.16.0 for extended query and URL-encoded body parsing; the shared install
  was not modified.
- Existing trust-proxy and Express auth wildcard suites passed: 2 files,
  15 tests. These used the existing shared installation; they do not establish
  that newly resolved packages were installed there.
- Lock-only resolution uses the pinned toolchain and `--ignore-scripts`;
  it does not run Rust prebuilds or replace the shared `node_modules` tree.
  An initial offline attempt could not resolve uncached Discord metadata;
  that failure is not a successful lock consistency check.

## Remaining qualification

Pinned pnpm 9.15.4 regenerated the lockfile successfully with only the target
updates and removal of their unused old transitive resolutions (10 additions,
47 removals). The offline `--frozen-lockfile --lockfile-only --ignore-scripts`
check passed. The post-change production audit reports **0 critical, 0 high,
12 moderate and 3 low** across 1,171 dependencies. Neither `qs` nor `fast-uri`
appears among the residual advisories; six moderate findings were removed.
The audit exits 1 because the remaining advisories are intentionally visible.
UBS inspected two manifest targets with zero findings; this is limited manifest
coverage, not a source-code or full dependency security audit. Gitleaks scanned
the four changed source/document files with no leaks.
Keep `deploy-iys` open until a newly built image is inspected and scanned by
exact digest. The existing Factory `fe9fffdf…` image and staged worker
`01437af7…` image do not acquire source fixes automatically. OS, Rust and Go
advisories require separate image evidence.

The baseline also retains advisories in `hono`, `ip-address`, `uuid`,
`smol-toml`, `postcss-selector-parser`, `fast-copy`, `body-parser`, `cli` and
`katex`. This patch deliberately does not perform an unrelated broad update.
