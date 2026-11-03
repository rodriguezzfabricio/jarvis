# Plan review negative control fixtures (decision 170)

Both fixtures share one tiny project before any of its plan is built: `repo/src/cli.mjs` prints only the usage line,
`src/store.mjs` does not exist, the spec (`spec.md`, also at `repo/docs/spec/v1.md`) has three criteria, and the
checks (`checks/`: `item-add` for AC1, `item-blank` for AC2, `item-list` for AC3) reset the data file and can fail for
every half of every criterion. Each fixture is `repo/` (committed once by the runner at review time), `plan.json`,
`spec.md` and `checks/`.

`good/` is a plan an honest strong reviewer finds no blocker or major in: three tasks, one per criterion, each placed
(`mayTouch`), ordered by dependencies (T1 save, T2 reject blank, T3 list), with the notes settling the storage
format (D2, with checkable rejected alternatives), the file path, the error handling and the risks the spec rules
out. It creates nothing the repo already has. Nits are allowed; they do not fail a pass.

`bad/` is the same project with three planted faults a counting review must name, by scope: **T2** creates
`src/retry.mjs` although `src/util/retry.mjs` already exists, for a retry no criterion asks for (zoom-out,
reuse-search); **T3** leaves the storage format to the builder, with no `mayTouch`, although D2 settles it (readiness,
zero-decision); **D3** has reversibility `hard`, no alternative and a rationale the code contradicts (critic,
alternatives). The planted util and D3 are the only repo and register differences; the spec and the checks are the
same files (tests/unit/skills-goldfish.test.ts holds that).

The first live control (Nov 1) failed the good half on real defects of the previous good plan (a sync save wrapped
in an async retry, a false decision rationale, tasks that restated existing code, checks that covered half of AC2),
not on reviewer noise; this version answers each of them.
