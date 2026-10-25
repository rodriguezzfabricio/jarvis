PASS

1. **RESOLVED — Homebrew reads:** `packages/cli/src/review/confine.ts:278` discovers only real Cellar kegs from the trusted launcher and its dependencies, using fixed PATH; candidate content cannot widen grants. Denials for `var` and `etc` follow every file grant (`:371`); `OPENSSL_CONF=/dev/null` is set (`:393`).

2. **RESOLVED — CONNECT/SNI bypass:** `packages/cli/src/review/confine.ts:169` dials only after accepting a ClientHello whose single SNI equals the CONNECT host. Multiple names, nonzero name types, inconsistent lengths, duplicate extensions, ECH/ESNI, and invalid record framing are rejected.

**New blocking critical/high findings: none found**, within decision 110’s accepted residuals. Read-only validation passed 5,671 in-memory parser checks and confirmed the expected 14 kegs and PATH independence. File-creating tests and live Seatbelt probes were not rerun.