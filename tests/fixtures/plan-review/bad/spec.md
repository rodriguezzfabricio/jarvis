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
- Durability past the operating system: `saved` means the bytes were handed to the OS (appendFileSync returned); a power loss in the next instant may lose that item, and no fsync or journal is added.
## User stories
- **S1 (P1):** As a user, I want to save an item by name so that I can find it later.
- **S2 (P1):** As a user, I want to list my saved items so that I can see what I have.
## Acceptance criteria
- **AC1 (S1):** WHEN `node src/cli.mjs add <name>` runs with a nonblank name THE SYSTEM SHALL persist the item and print `saved`.
- **AC2 (S1):** WHEN `node src/cli.mjs add` runs with a blank name THE SYSTEM SHALL exit nonzero and persist nothing.
- **AC3 (S2):** WHEN `node src/cli.mjs list` runs in a new process THE SYSTEM SHALL print every saved item, one per line, in the order saved.
## Assumptions
- A1 [delegated]: items are stored as JSON lines in data/items.jsonl (D2).
- A2 [delegated]: an item name is trimmed of surrounding whitespace; it is blank when nothing remains, or when a line feed (U+000A) or a carriage return (U+000D) remains inside it; every other character is an ordinary part of the name (an item is one line of text).
- A3 [delegated]: one process uses the data file at a time.
- A4 [delegated]: data/items.jsonl in the checkout is working data that the protected checks reset before each case; nothing anyone wants to keep is stored there.
## Open questions
None.
