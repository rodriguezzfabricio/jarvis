# Response to stage 0 review 10 (Codex)

Oct 24, 2026. Under decision 74, critical and high findings are fixed and re-reviewed; medium and low findings are fixed when cheap and otherwise go to `docs/backlog.md`.

| # | Severity | Finding | Response |
|---|---|---|---|
| 1 | high | Docker registry authentication credentials pass the snapshot scan | **Fixed, by format rather than by field:** any base64 run (12–512 characters) that decodes to `user:password` is a credential, in every file and every text view: Docker's `auths.*.auth`, npm's `_auth`, `Authorization: Basic …` in code. The user part must look like a user name, so base64-encoded JSON (FreeHire's Telegram `data-view` attributes decode to `{"c":…}`) is not mistaken for one. Docker's `identitytoken` and `registrytoken` are credential fields. Credential helpers (`credsStore`, `credHelpers`) and empty `auths` entries stay. **Tests:** refusals for a Docker `config.json` with `auth`, one with `identitytoken`, and a Basic header in a `.ts` file; the inert snapshot keeps a helper-only Docker config, an npm integrity hash, an opaque id and a base64 JSON attribute. **Mutations:** "base64 user:password not detected", "base64 user part unrestricted", "Docker token fields not credentials". |
| 2 | high | YAML merges still discard environment-entry credential context | **Fixed:** a map's pairs are read with merges (`<<: *base`, or a list of them) expanded in place, recursively and within the per-file alias budget, keeping every duplicate. A merged `name` or `value` now belongs to the entry. **Tests:** refusals for a merged name, a merged value and a merge list. **Mutation:** "YAML merges not expanded". |

FreeHire's real snapshots for tasks 1 and 2 still pass. 86 of 86 mutations caught.
