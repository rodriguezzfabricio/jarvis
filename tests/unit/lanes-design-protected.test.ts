import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { readApprovedChecks } from "../../packages/cli/src/runner/checks-author.ts";
import { installDesignLintChecks } from "../../packages/cli/src/lanes/design-protected.ts";
const roots: string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function setup() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"design-lint-"))); roots.push(root);
  const ledger=Ledger.open(join(root,"project")),store=new ChecksStore(ledger.dir),repo=join(root,"repo"); mkdirSync(repo);
  const design=readFileSync(new URL("../fixtures/qa/DESIGN.md",import.meta.url),"utf8");
  writeFileSync(join(repo,"DESIGN.md"),design); writeFileSync(join(repo,"app.html"),"<main>Today</main>");
  const input={nodeBin:process.execPath,files:["app.html"],design,axeVersion:"4.14.0"};
  return {root,ledger,store,repo,design,input};
}
it("installs real protected definitions without approval, requires review to overwrite, and detects tampering",()=>{
  const f=setup(),definitions=installDesignLintChecks(f.store,f.input);
  expect(Object.keys(definitions).sort()).toEqual(["ai-tells","design-md-lint","token-lint"]);
  expect(f.store.verify(f.ledger).ok).toBe(false);
  f.store.approve(f.ledger,"reviewed definitions");
  expect(readApprovedChecks(f.store,f.ledger).map(c=>c.name).sort()).toEqual(Object.keys(definitions).sort());
  // The protected record the design service binds evidence to, outside the architect's check namespace; the loop runs exactly it.
  expect(JSON.parse(readFileSync(join(f.store.checksDir,"design-lint","checks.json"),"utf8"))).toEqual(definitions);
  for(const loaded of readApprovedChecks(f.store,f.ledger)) expect({cases:loaded.cases,verify:loaded.verify}).toEqual({cases:definitions[loaded.name as keyof typeof definitions].cases,verify:definitions[loaded.name as keyof typeof definitions].verify});
  expect(()=>installDesignLintChecks(f.store,f.input)).toThrow(/already|review/);
  writeFileSync(join(f.store.checksDir,"design-lint","verify.ts"),"console.log('pass')");
  expect(f.store.verify(f.ledger).ok).toBe(false);
});
it.each(["relative-node","empty-scope","escape","invalid-design","invalid-axe"])("refuses invalid protected inputs: %s",fault=>{
  const f=setup(), input={...f.input};
  if(fault==="relative-node")input.nodeBin="node";
  if(fault==="empty-scope")input.files=[];
  if(fault==="escape")input.files=["../outside.html"];
  if(fault==="invalid-design")input.design="invalid";
  if(fault==="invalid-axe")input.axeVersion="latest";
  expect(()=>installDesignLintChecks(f.store,input)).toThrow();
});
async function phases(f:ReturnType<typeof setup>,check:ReturnType<typeof installDesignLintChecks>["ai-tells"], alter?: (dir:string)=>void) {
  const out=join(f.root,"out"),scan=join(out,"lint");mkdirSync(scan,{recursive:true});
  const env={PATH:"/usr/bin:/bin",JARVIS_FIXTURES:join(f.store.checksDir,"fixtures"),JARVIS_CHECKS:f.store.checksDir,JARVIS_OUT:out,JARVIS_COMPLETION_FILE:join(f.root,"nonce")};
  const run=(command:string,cwd:string)=>runSession({bin:"/bin/sh",args:["-c",command],cwd,env,timeoutMs:10_000});
  const observed=await run(check.cases[0]!.command,f.repo);
  writeFileSync(join(scan,"stdout"),observed.stdout);writeFileSync(join(scan,"stderr"),observed.stderr);writeFileSync(join(scan,"code"),String(observed.code));
  alter?.(scan); writeFileSync(env.JARVIS_COMPLETION_FILE,"runner-nonce");
  const verified=await run(check.verify,f.root);
  return {observed,verified};
}
it.each(["ai-tells","token-lint","design-md-lint"] as const)("%s records findings in the case and rejects them in isolated verify",async name=>{
  const f=setup(),checks=installDesignLintChecks(f.store,f.input);
  const clean=await phases(f,checks[name]);
  expect(clean.verified.code,clean.verified.stderr).toBe(0); expect(clean.verified.stdout.trim()).toBe("JARVIS-CHECK-COMPLETE runner-nonce");
  if(name==="ai-tells")writeFileSync(join(f.repo,"app.html"),"<h1>Welcome to your dashboard</h1>");
  if(name==="token-lint")writeFileSync(join(f.repo,"app.html"),'<style>main { color: #123456; padding: 999px; }</style>');
  if(name==="design-md-lint")writeFileSync(join(f.repo,"DESIGN.md"),"broken");
  const bad=await phases(f,checks[name]);
  expect(bad.observed.code).toBe(0); expect(JSON.parse(bad.observed.stdout).findings.length).toBeGreaterThan(0);
  expect(bad.verified.code).toBe(1); expect(bad.verified.stdout).not.toContain("JARVIS-CHECK-COMPLETE");
});
it.each(["bad-json","nonzero","incomplete","wrong-check","symlink","missing"])("cannot pass incomplete or substituted observations: %s",async fault=>{
  const f=setup(),checks=installDesignLintChecks(f.store,f.input);
  if(fault==="symlink") {rmSync(join(f.repo,"app.html"));symlinkSync(join(f.repo,"DESIGN.md"),join(f.repo,"app.html"));}
  if(fault==="missing")rmSync(join(f.repo,"app.html"));
  const result=await phases(f,checks["ai-tells"],dir=>{
    if(fault==="bad-json")writeFileSync(join(dir,"stdout"),"{}");
    if(fault==="nonzero")writeFileSync(join(dir,"code"),"1");
    if(fault==="incomplete")writeFileSync(join(dir,"stdout"),JSON.stringify({check:"ai-tells",complete:false,findings:[]}));
    if(fault==="wrong-check")writeFileSync(join(dir,"stdout"),JSON.stringify({check:"token-lint",complete:true,findings:[]}));
  });
  expect(result.verified.code).toBe(1); expect(result.verified.stdout).not.toContain("JARVIS-CHECK-COMPLETE");
});
it("token lint uses approved tokens even if the candidate changes its DESIGN.md",async()=>{
  const f=setup(),checks=installDesignLintChecks(f.store,f.input);
  writeFileSync(join(f.repo,"DESIGN.md"),f.design.replaceAll("8px","999px"));
  writeFileSync(join(f.repo,"app.html"),"<style>main { padding: 999px; }</style>");
  const result=await phases(f,checks["token-lint"]);
  expect(result.verified.code).toBe(1);
});
