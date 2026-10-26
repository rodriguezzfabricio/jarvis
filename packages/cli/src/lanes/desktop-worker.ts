import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observeDesktopBuild } from "./desktop-build.ts";
import type { DesktopPlan } from "./desktop-types.ts";

const ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GOMODCACHE", "GOCACHE", "npm_config_cache", "CARGO_HOME", "RUSTUP_HOME", "DEVELOPER_DIR"];

try {
  const plan = JSON.parse(readFileSync(join(process.env.JARVIS_FIXTURES!, "desktop", "plan.json"), "utf8")) as DesktopPlan;
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) { const value = process.env[key]; if (value !== undefined) env[key] = value; }
  console.log(JSON.stringify(await observeDesktopBuild(process.cwd(), plan, env)));
} catch { process.exitCode = 2; }
