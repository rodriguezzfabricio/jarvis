// Vitest setupFiles (vitest.config.ts): runs before every test file, in the test's own process, and makes
// the process start the real git binary where macOS's /usr/bin/git shim would have been found
// (tests/setup/use-real-git.ts has the details; real-git-global.ts finds the binary once per run).
import { inject } from "vitest";
import { useRealGit } from "./use-real-git.ts";

useRealGit(inject("realGit"), inject("shimEnv"));
