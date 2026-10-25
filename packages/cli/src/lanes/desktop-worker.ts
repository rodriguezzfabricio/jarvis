import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observeDesktopBuild } from "./desktop-build.ts";
import type { DesktopPlan } from "./desktop-types.ts";

try {
  const plan = JSON.parse(readFileSync(join(process.env.JARVIS_FIXTURES!, "desktop", "plan.json"), "utf8")) as DesktopPlan;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[0] !== "JARVIS_FIXTURES" && entry[1] !== undefined));
  console.log(JSON.stringify(await observeDesktopBuild(process.cwd(), plan, env)));
} catch { process.exitCode = 2; }
