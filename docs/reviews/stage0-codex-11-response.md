# Response to stage 0 review 11 (Codex)

Oct 24, 2026. Under decision 74, critical and high findings are fixed and re-reviewed; medium and low findings are fixed when cheap and otherwise go to `docs/backlog.md`.

| # | Severity | Finding | Response |
|---|---|---|---|
| 1 | high | Docker authentication still bypasses the snapshot scan | **Fixed by structure:** under an `auths` map (Docker's `config.json`, Podman's `auth.json`, in JSON or YAML, through merges and aliases), every registry entry's `auth` literal is a credential, whatever its length or characters. Only empty, null and reference values pass. Credential helpers stay. The generic base64 `user:password` rule from review 10 remains as a second layer for other places (`Authorization: Basic …`). **Tests:** refusals for a short (`dTo4azJa`), a 400-character and a non-ASCII credential, and a YAML `auths` file; the inert Docker config keeps an empty `auth`. **Mutations:** "Docker auths not inspected (JSON)", "Docker auths not inspected (YAML)". |
| 2 | medium | Concurrent appends can make verified readers falsely report tampering | **Fixed (cheap):** `verifyLedger` reads the head before and after the ledger and retries (up to 5 times) until they match, so an append that lands between the reads can't pair an older ledger with a newer head. Every caller (doctor, `Broker.decide`, appends) goes through it. **Tests:** an append injected between the two reads still verifies, with the new entry; a forged head on a stable read is still reported. **Mutation:** "ledger reads not checked for stability". Backlog #18. |

FreeHire's real snapshots for tasks 1 and 2 still pass. 89 of 89 mutations caught.
