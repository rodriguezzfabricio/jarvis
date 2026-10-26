// Compatibility setup only: useRealGit is inert, including in snapshot worker threads (decision 137).
import { inject } from "vitest";
import { useRealGit } from "./use-real-git.ts";

useRealGit(inject("realGit"), inject("shimEnv"));
