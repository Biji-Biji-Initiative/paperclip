# Factory subscription authentication holds

Protected Factory workers use one admitted Codex or Claude subscription capability.
An expired, rejected, mismatched or unverified capability requires operator review.
It never authorizes an automatic runner restart, session resume, replacement account
or API billing fallback.

Native command results and terminal events carry a closed provider code,
closed reason, `retryable: false` and `operatorRequired: true`. The application
recognizes structured results from the authenticated runner; it does not classify
model prose as authentication authority. A recognized code with malformed
metadata still holds with the fixed `invalid_hold_metadata` reason.

The application records a fixed, private-detail-free terminal projection before
its first event-ledger append. Source identity and sequence remain intact; the
original source event is not modified. This does not sanitize an upstream native
journal: the native producer must separately emit closed payloads before commit.
An unexpected protected runner exit also holds, without replaying its stderr.

The server records a board-owned recovery action on the same company, run,
coordinator owner and attempt. It suppresses retries while retaining the physical
process identity, lease owner, expiry, deadline and result state. A missing owner
match or database failure cannot authorize a successor. Terminal failure delivery
is not evidence that the provider and tools have stopped. Verify their retirement
before explicitly admitting another run.

Source qualification on 2026-10-16: eight classifier/transport cases, twelve
runtime cases and six server cases passed; runner and server typechecks passed.
Transport tests used a prior qualified native binary, so they do not qualify the
new native producer or final image. The secret scan and whitespace check passed.
Bounded UBS attempts timed out without results. Actual subscription, image,
confinement and pilot qualification remain separate deployment work.
