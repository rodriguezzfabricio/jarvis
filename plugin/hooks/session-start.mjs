// SessionStart: inject the run header (task, spec version, constraints) the runner wrote for this session.
// Stdout from a SessionStart hook is added to the session's context. Never fails the session.
// With no run header configured (an interactive desktop session), print a fixed receipt instead, which the
// desktop check finds in the hook record Claude Code writes (decision 80).
import { existsSync, readFileSync } from "node:fs";

const path = process.env.JARVIS_RUN_HEADER;
if (path === undefined) process.stdout.write("Jarvis plugin: SessionStart ran (no run header).\n");
else if (path && existsSync(path)) process.stdout.write(readFileSync(path, "utf8").slice(0, 8000));
process.exit(0);
