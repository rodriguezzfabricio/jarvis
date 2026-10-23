// SessionStart: inject the run header (task, spec version, constraints) the runner wrote for this session.
// Stdout from a SessionStart hook is added to the session's context. Never fails the session.
import { existsSync, readFileSync } from "node:fs";

const path = process.env.JARVIS_RUN_HEADER;
if (path && existsSync(path)) process.stdout.write(readFileSync(path, "utf8").slice(0, 8000));
process.exit(0);
