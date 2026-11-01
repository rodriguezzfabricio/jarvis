import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../packages/cli/src/broker/broker.ts";
import { layeredSecrets, projectBroker } from "../../packages/cli/src/broker/host.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

// Decisions 157 and 159: with a release setup, the hosted broker takes deploys through the deploy adapters and keeps
// the outbox for everything else; the house-stack account tokens setup stores reach it after the project's own file.
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
function setup() {
  const root = shortTmp("j-hrel-"); roots.push(root);
  const jarvisHome = join(root, "jarvis");
  const projectDir = join(jarvisHome, "projects", "p");
  const secrets = join(jarvisHome, "secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  return { jarvisHome, projectDir, secrets, ledger: Ledger.open(projectDir) };
}
const REF = { ref: `release:${"a".repeat(64)}:preview` };

describe("the hosted broker with a release setup", () => {
  it("sends deploy.preview to the deploy adapter and nothing to the outbox", async () => {
    const s = setup();
    const seen: unknown[] = [];
    const deploy: Adapter[] = ["deploy.preview", "deploy.promote"].map((op) => ({ op, execute: async (payload, secrets) => {
      seen.push({ op, payload, token: secrets.get("VERCEL_PREVIEW_TOKEN") });
      return { outcome: "succeeded" as const, detail: { url: "https://x.vercel.app" } };
    } }));
    writeFileSync(join(s.secrets, "house-stack.accounts.env"), "VERCEL_PREVIEW_TOKEN=fake-preview-0001\n", { mode: 0o600 });
    const broker = projectBroker({ jarvisHome: s.jarvisHome, projectDir: s.projectDir, project: "p", ledger: s.ledger, deploy });
    expect((await broker.handle({ op: "deploy.preview", payload: REF })).status).toBe("succeeded");
    expect(seen).toEqual([{ op: "deploy.preview", payload: REF, token: "fake-preview-0001" }]);
    expect(readdirSync(join(s.projectDir, "outbox"))).toEqual([]);
  });

  it("keeps every operation on the outbox without a release setup (stage 1 and evals)", async () => {
    const s = setup();
    const broker = projectBroker({ jarvisHome: s.jarvisHome, projectDir: s.projectDir, project: "p", ledger: s.ledger });
    expect((await broker.handle({ op: "deploy.preview", payload: REF })).status).toBe("succeeded");
    expect(readdirSync(join(s.projectDir, "outbox"))).toHaveLength(1);
  });

  it("reads the project's file first, then the house-stack accounts file; refuses either if others can read it", () => {
    const s = setup();
    writeFileSync(join(s.secrets, "p.env"), "VERCEL_PREVIEW_TOKEN=fake-project-0001\n", { mode: 0o600 });
    writeFileSync(join(s.secrets, "house-stack.accounts.env"), "VERCEL_PREVIEW_TOKEN=fake-account-0001\nVERCEL_PRODUCTION_TOKEN=fake-account-0002\n", { mode: 0o600 });
    const layered = layeredSecrets([join(s.secrets, "p.env"), join(s.secrets, "house-stack.accounts.env"), join(s.secrets, "missing.env")]);
    expect(layered.get("VERCEL_PREVIEW_TOKEN")).toBe("fake-project-0001");
    expect(layered.get("VERCEL_PRODUCTION_TOKEN")).toBe("fake-account-0002");
    expect(layered.get("VERCEL_TOKEN")).toBeUndefined();
    chmodSync(join(s.secrets, "house-stack.accounts.env"), 0o644);
    expect(() => projectBroker({ jarvisHome: s.jarvisHome, projectDir: s.projectDir, project: "p", ledger: s.ledger })).toThrow(/chmod 600/);
  });
});
