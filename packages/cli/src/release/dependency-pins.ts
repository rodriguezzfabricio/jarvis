/** A package manager the release's dependency step may start: a script file Node runs, inside its runtime root. */
export interface DependencyPin { bin: string; root: string; version: string }
/** The pinned tools (config/pins.ts pinnedDependencyTools, decision 173): always absolute paths, never PATH lookups. */
export interface DependencyPins { node: string; nodeVersion: string; npm: DependencyPin; pnpm: DependencyPin }
