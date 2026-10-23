# Response to stage 0 review 4 (Codex)

Oct 23, 2026. Reviewed revision `050768c`. Each finding was reproduced first; each fix has snapshot-level or session-level regression tests and a mutation.

| # | Severity | Finding | Response |
|---|---|---|---|
| 1 | high | Short and encrypted PEM private keys pass | **Fixed:** any `BEGIN … PRIVATE KEY` envelope is refused, whatever its body or headers. Dummy envelopes need explicit review. **Snapshot tests:** generated Ed25519 and X25519 PKCS#8 PEM, and encrypted RSA PEM (`.key`). FreeHire's dummy key in `config_test.go` (body `test`) is now allowlisted by review in jarvis-evals. |
| 2 | high | Password-only credential URLs escape | **Fixed:** an empty username is recognized in both redaction and detection. **Tests:** `redis://:…@` in `.env` (redacted) and in JSON (refused). The review 3 password cases are now snapshot-level too (JSON, YAML). |
| 3 | medium | Descendants outlive the leader | **Fixed:** after the leader exits, the runner sends TERM to the whole group, KILLs it after the grace period, and waits until the group is empty before returning or failing. **Tests:** a cooperative leader with a SIGTERM-resistant descendant, both on normal completion and on capture failure; the descendant must be gone. |
| 4 | medium | Matcher-named runtime errors count as assertions | **Fixed:** an assertion is only an `AssertionError`, or Vitest's `.rejects`/`.resolves` message *with* its `_Assertion.__VITEST_*__` frame. Any non-assertion failure, unfinished test, or exit status other than 1 makes the run an error. **Tests:** a matcher-named TypeError, a mixed assertion and ReferenceError, a pending test, an exit status mismatch, and the frame requirement. |
