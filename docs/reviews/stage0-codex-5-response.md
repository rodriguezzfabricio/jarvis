# Response to stage 0 review 5 (Codex)

Oct 23, 2026. Under decision 74, critical and high findings are fixed and re-reviewed; medium and low findings are fixed when cheap and otherwise go to `docs/backlog.md`.

| # | Severity | Finding | Response |
|---|---|---|---|
| 1 | high | Apostrophes in URL userinfo evade the scan | **Fixed:** userinfo may contain `'`; only the host ends at quotes. **Tests:** apostrophe in the password, in the username, and in a password-only `rediss://` URL, in JSON, YAML and `.env`, all at snapshot level. |
| 2 | high | `srt` turns a killed check into exit 0 | **Fixed:** checks run through the sandbox runtime *library*. The runner spawns the wrapped command itself, and a gate passes only on the sandboxed command's own exit 0; any signal or timeout fails. **Tests:** checks that `kill -TERM $$` or `kill -INT $$` before failing must fail. |
| 3 | high | A local clone doesn't verify object hashes | **Fixed:** the clone uses `--no-local` (pack transport, where `index-pack` recomputes every hash) with `transfer.fsckObjects`, then `git fsck --full --strict` before checkout. **Test:** a loose blob's contents swapped under its old name, from failing to passing, never yields a pass. |
| 4 | high | A short write can be acknowledged | **Fixed:** `writeAll` loops until every byte is written and refuses a write that makes no progress; this covers entry, head and lock writes. **Tests:** seven-byte short writes produce a valid entry; a stuck write throws and acknowledges nothing. |
| 5 | high | Takeover-lock reclamation can admit two writers | **Fixed:** the lock is created fully initialized in one step (a temp file holding pid and nonce, hard-linked into place). A dead holder's lock is removed only by whoever wins the exclusive per-instance marker `reclaim.<nonce>`. The owner is dead and other reclaimers are shut out, so a replacement lock can never be removed. **Tests:** an in-progress reclaim is respected; a fault test races six processes over a stale lock six times and gets an exact, valid chain each time. |
| 6 | medium | An empty lock causes an infinite loop | **Fixed:** locks are never empty (atomic link), and the deadline is checked on every path. **Test:** a malformed lock times out promptly. |
| 7 | medium | A second recovery crash strands the ledger | **Fixed:** a lagging head is repaired durably before any new append. **Test:** two crashes at the head-update boundary, then the next append succeeds. |
| 8 | medium | A check file named `__proto__` isn't protected | **Fixed:** null-prototype maps and own-property checks. **Test:** included. |
| 9 | medium | Inherited output pipes delay cleanup until the timeout | **Backlog** (#10). |
| 10 | medium | Standalone unhandled errors are invisible to the classifier | **Backlog** (#11). |
| 11 | medium | An interrupted mutation check leaves a safeguard disabled | **Fixed:** mutations run in a disposable clone of `HEAD` with symlinked `node_modules`, so the working tree is never touched. |
