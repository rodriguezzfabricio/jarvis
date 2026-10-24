export { register } from "./command.ts";
export { checkSpec, parseSpec, SECTIONS } from "./parser.ts";
export type { Assumption, AssumptionKind, CheckResult, Criterion, ParsedSpec, Priority, Problem, Spec, Status, Story } from "./parser.ts";
export { checkRepository, createNextVersion, diffVersions, latestVersion, listVersions, SpecError } from "./versions.ts";
export type { CreateOptions, FileProblem, IdChanges, RepositoryCheck, SpecDiff, SpecVersion } from "./versions.ts";
