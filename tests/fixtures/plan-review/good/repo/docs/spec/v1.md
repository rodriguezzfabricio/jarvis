---
spec: 1
date: 2026-11-01
status: confirmed
supersedes: none
---
## Goals
- Save named items from the command line and list them later.
## Non-goals
- Editing or deleting items.
- Any network access, database or other service: items live in a file under data/.
- Recovering a damaged data file, and two processes writing at once.
## User stories
- **S1 (P1):** As a user, I want to save an item by name so that I can find it later.
- **S2 (P1):** As a user, I want to list my saved items so that I can see what I have.
## Acceptance criteria
- **AC1 (S1):** WHEN `node src/cli.mjs add <name>` runs with a nonblank name THE SYSTEM SHALL persist the item and print `saved`.
- **AC2 (S1):** WHEN `node src/cli.mjs add` runs with a blank name THE SYSTEM SHALL exit nonzero and persist nothing.
- **AC3 (S2):** WHEN `node src/cli.mjs list` runs in a new process THE SYSTEM SHALL print every saved item, one per line, in the order saved.
## Assumptions
- A1 [delegated]: items are stored as JSON lines in data/items.jsonl (D2).
- A2 [delegated]: an item name is one line of text; a name that is empty after trimming whitespace, or that contains a line break, is blank.
- A3 [delegated]: one process uses the data file at a time.
## Open questions
None.
