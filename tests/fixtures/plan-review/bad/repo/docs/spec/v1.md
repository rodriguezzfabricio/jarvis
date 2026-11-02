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
- **AC1 (S1):** WHEN `node src/cli.mjs add <name>` runs with a nonblank name THE SYSTEM SHALL persist the item, print exactly `saved` followed by a newline, and exit 0.
- **AC2 (S1):** WHEN `node src/cli.mjs add` runs with a blank name THE SYSTEM SHALL print exactly `item name must not be blank` followed by a newline on stderr, exit 1, print nothing on stdout, and persist nothing.
- **AC3 (S2):** WHEN `node src/cli.mjs list` runs in a new process THE SYSTEM SHALL print every saved item, one per line, in the order saved, and exit 0; a missing or empty store prints nothing.
## Assumptions
- A1 [delegated]: items are stored as JSON lines in data/items.jsonl (D2).
- A2 [delegated]: an item name is trimmed of surrounding whitespace; it is blank when nothing remains, or when a line feed (U+000A) or a carriage return (U+000D) remains inside it; every other character is an ordinary part of the name (an item is one line of text).
- A3 [delegated]: one process uses the data file at a time.
- A4 [delegated]: a non-empty ITEMS_FILE overrides the store path, resolved against the working directory. If unset or empty, the default is data/items.jsonl relative to the application, independent of the working directory. Checks use data/check-items.jsonl; default-path cases copy src/ into a temporary application with a separate empty data/ folder. No check reads or deletes the original application's data/items.jsonl.
- A5 [delegated]: `add` joins all arguments following the command with one ASCII space before trimming (D4); `add buy milk` and `add "buy milk"` save the same name. No arguments means the empty name.
- A6 [delegated]: only a missing store (ENOENT) means an empty list. Any other read error or malformed JSON is reported on stderr with exit 1 and no stdout; no recovery is attempted.
- A7 [delegated]: `list` accepts no arguments. Extra list arguments, unknown commands, and a missing command print the existing usage line to stderr, exit 2, and print nothing on stdout.
## Open questions
None.
