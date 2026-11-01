import { homedir } from "node:os";
import { join } from "node:path";

export interface DependencyPin { bin: string; root: string; version: string }
export interface DependencyPins { node: string; nodeVersion: string; npm: DependencyPin; pnpm: DependencyPin }

/** Runner-owned installations, never Corepack's launcher. Move this table to config/pins.ts at integration. */
export function pinnedDependencyTools(home = homedir()): DependencyPins {
  const nodeRoot = "/opt/homebrew/Cellar/node@24/24.21.0";
  const npmRoot = join(nodeRoot, "lib/node_modules/npm");
  const pnpmRoot = join(home, ".cache/node/corepack/v1/pnpm/11.7.0");
  return { node: join(nodeRoot, "bin/node"), nodeVersion: "24.21.0",
    npm: { bin: join(npmRoot, "bin/npm-cli.js"), root: npmRoot, version: "11.19.0" },
    pnpm: { bin: join(pnpmRoot, "bin/pnpm.mjs"), root: pnpmRoot, version: "11.7.0" } };
}
