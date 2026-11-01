| ID | Date | Decision | Made by | Status | Source | Class | Reversibility | Why | Alternatives | Depends on | Supersedes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | 2026-10-30 | Keep the CLI as the only interface | jarvis | active | docs/spec/v1.md | Mechanical | easy | The spec names no other client | [] | [] | - |
| D2 | 2026-10-30 | Items are stored as JSON lines in data/items.jsonl | jarvis | active | src/store.mjs | Mechanical | moderate | One append per save; no database to run | ["SQLite: rejected because it adds a native dependency for a single-user list"] | ["S1"] | - |
| D3 | 2026-10-31 | Retries use exponential backoff with 3 attempts | jarvis | active | src/util/retry.mjs | Mechanical | hard | Callers already depend on the timing | ["JSON files: rejected because concurrent writes corrupt them without a lock"] | [] | - |
