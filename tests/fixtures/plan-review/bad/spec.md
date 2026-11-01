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
- Any network access.
## User stories
- **S1 (P1):** As a user, I want to save an item by name so that I can find it later.
- **S2 (P1):** As a user, I want to list my saved items so that I can see what I have.
## Acceptance criteria
- **AC1 (S1):** WHEN `node src/cli.mjs add <name>` runs with a nonblank name THE SYSTEM SHALL persist the item and print `saved`.
- **AC2 (S1):** WHEN `node src/cli.mjs add` runs with a blank name THE SYSTEM SHALL exit nonzero and persist nothing.
- **AC3 (S2):** WHEN `node src/cli.mjs list` runs after a process restart THE SYSTEM SHALL print every saved item, one per line.
## Assumptions
- A1 [delegated]: items are stored in a local file under data/ (D2).
## Open questions
None.
