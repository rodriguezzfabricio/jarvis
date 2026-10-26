import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_BUILD_ENV, observeDesktopBuild } from "./desktop-build.ts";
import type { DesktopPlan } from "./desktop-types.ts";

try {
  const plan = JSON.parse(readFileSync(join(process.env.JARVIS_FIXTURES!, "desktop", "plan.json"), "utf8")) as DesktopPlan;
  const env: Record<string, string> = {};
  for (const key of DESKTOP_BUILD_ENV) { const value = process.env[key]; if (value !== undefined) env[key] = value; }
  console.log(JSON.stringify(await observeDesktopBuild(process.cwd(), plan, env)));
} catch { process.exitCode = 2; }
