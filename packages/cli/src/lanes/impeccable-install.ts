import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GateCheck } from "../checks/gate.ts";
import type { ChecksStore } from "../checks/store.ts";
import { DesignBrowserPlanSchema, type DesignBrowserPlan } from "../review/design-browser.ts";
import { designBrowserDefinition } from "../review/design-check.ts";
import type { ImpeccableDriverConfig } from "./impeccable-driver.ts";
import { impeccableArguments, impeccableDefinitions } from "./impeccable.ts";

export interface DesignChecksPlan { nodeBin:string; scanner:ImpeccableDriverConfig; plan:DesignBrowserPlan; axeVersion:string }
const MODULES = [
  "lanes/impeccable.ts", "lanes/impeccable-browser.ts", "lanes/impeccable-driver.ts", "lanes/impeccable-verify.ts",
  "lanes/browser.ts", "lanes/browser-frames.ts", "lanes/toolchain.ts", "lanes/chromium-install.ts", "lanes/materialize.ts", "lanes/verify.ts",
  "proc/session.ts", "review/design-browser.ts", "review/design-evidence.ts", "review/design-verdict.ts", "review/design-check.ts", "review/evidence.ts",
];

const sha256=(data:Buffer)=>createHash("sha256").update(data).digest("hex");
function copyZodRuntime(source: string, target: string): void {
  mkdirSync(target, {recursive:true,mode:0o700});
  for (const file of ["index.js", "package.json"]) copyFileSync(join(source,file),join(target,file));
  // The installed ESM entry imports these directories; source, declarations and CJS are not runtime inputs.
  for (const dir of ["core", "classic", "locales"]) {
    const from=join(source,"v4",dir), to=join(target,"v4",dir); mkdirSync(to,{recursive:true,mode:0o700});
    for (const file of readdirSync(from)) if(file.endsWith(".js")) copyFileSync(join(from,file),join(to,file));
  }
}

/** Materialize the already-installed runtime dependencies, then let the integrator review and approve the store. */
export function installDesignChecks(store:ChecksStore,input:DesignChecksPlan):Record<"impeccable-source"|"impeccable-url"|"design-browser",GateCheck> {
  const plan=DesignBrowserPlanSchema.parse(input.plan);
  if (!input.scanner.browser) throw new Error("design checks require the approved browser toolchain");
  // Decision 124: a gate case can't read the home folder, so the engine runs from a copy in the protected
  // fixtures, checked against the pin before anything is written.
  const pin=input.scanner.pin;
  if (!isAbsolute(pin.bin) || !/^\d+\.\d+\.\d+$/.test(pin.version) || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error("design checks need an absolute, exact and hashed Impeccable pin");
  const engine=readFileSync(pin.bin);
  if (sha256(engine)!==pin.sha256) throw new Error("Impeccable engine sha256 differs from its pin");
  impeccableArguments("/checkout",{kind:"source",files:input.scanner.files});
  const browser=designBrowserDefinition({nodeBin:input.nodeBin,...input.scanner.browser,axeVersion:input.axeVersion});
  const definitions={...impeccableDefinitions({nodeBin:input.nodeBin,driver:"design-runtime/lanes/impeccable-driver.ts",verifier:"design-runtime/lanes/impeccable-verify.ts",config:"impeccable.json"}),"design-browser":browser};
  const locations=[join(store.checksDir,"fixtures","design-runtime"),join(store.checksDir,"design-runtime")];
  if(locations.some(existsSync)||existsSync(join(store.checksDir,"design-plan.json"))) throw new Error("design checks already installed; changes require review");
  const source=fileURLToPath(new URL("../",import.meta.url));
  const zod=dirname(realpathSync(createRequire(import.meta.url).resolve("zod/package.json")));
  for(const root of locations) {
    for(const module of MODULES) {
      const dest=join(root,module);mkdirSync(dirname(dest),{recursive:true,mode:0o700});copyFileSync(join(source,module),dest);
    }
    mkdirSync(join(root,"node_modules"),{mode:0o700});
    copyZodRuntime(zod,join(root,"node_modules","zod"));
    writeFileSync(join(root,"package.json"),JSON.stringify({type:"module"}),{flag:"wx",mode:0o600});
  }
  const fixtures=realpathSync(join(store.checksDir,"fixtures")), copy=join(fixtures,"design-runtime","impeccable",pin.version,"impeccable");
  mkdirSync(dirname(copy),{recursive:true,mode:0o700}); writeFileSync(copy,engine,{flag:"wx",mode:0o700});
  if (sha256(readFileSync(copy))!==pin.sha256) throw new Error("Impeccable engine copy differs from its pin");
  writeFileSync(join(fixtures,"impeccable.json"),JSON.stringify({...input.scanner,pin:{bin:copy,version:pin.version,sha256:pin.sha256}}),{flag:"wx",mode:0o600});
  for(const root of [store.checksDir,join(store.checksDir,"fixtures")]) writeFileSync(join(root,"design-plan.json"),JSON.stringify(plan),{flag:"wx",mode:0o600});
  writeFileSync(join(store.checksDir,"design-checks.json"),JSON.stringify(definitions),{flag:"wx",mode:0o600});
  return definitions;
}
