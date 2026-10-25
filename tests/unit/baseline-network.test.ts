import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EVAL_ALLOWED_DOMAINS, loadTask, runBaseline, type GoldenTask } from "../../packages/cli/src/eval/baseline.ts";
import { buildTaskSettings, writeTaskSettings } from "../../packages/cli/src/harness/claude/settings.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtn-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const task: GoldenTask = {
  id: "network", title: "Network policy", prompt: "p", model: "claude-opus-5-5",
  maxTurns: 1, timeoutMinutes: 1, allowedDomains: [],
};
const context = {
  worktree: join(root, "work"), jarvisHome: join(root, "home"), cacheDir: join(root, "cache"),
};
const publicDomains = ["registry.npmjs.org", "proxy.golang.org", "sum.golang.org", "fonts.googleapis.com", "fonts.gstatic.com"];
const localDomains = [
  "localhost", "LOCALHOST", "localhost.", "app.localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
  "127.0.0.1", "127.0.0.2", "127.255.255.255", "127.1", "2130706433", "0x7f000001", "0177.0.0.1",
  "0.0.0.0", "0", "[::1]", "::1", "[::ffff:127.0.0.1]", "[::]",
  "localhost:43123", "127.0.0.1:43123", "[::1]:43123",
];
const wildcards = ["*", "*.example.com", "*.localhost", "127.*", "registry.*.org", "example.com*:443"];

function writeTask(allowedDomains: unknown): string {
  const evals = join(root, "evals");
  const dir = join(evals, "tasks", task.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify({ ...task, allowedDomains }));
  writeFileSync(join(dir, "prompt.md"), task.prompt);
  return evals;
}

describe("round 18 task network policy", () => {
  it("keeps only the five public dependency and font hosts in evals", () => {
    expect(EVAL_ALLOWED_DOMAINS).toEqual(publicDomains);
    expect(loadTask(writeTask(publicDomains), task.id).allowedDomains).toEqual(publicDomains);
    expect(loadTask(writeTask([]), task.id).allowedDomains).toEqual([]);
  });

  it.each([...localDomains, ...wildcards])("refuses task.json allowlisting %s", (domain) => {
    expect(() => loadTask(writeTask([domain]), task.id)).toThrow(/allowedDomains|allowed domain/);
  });

  it.each([null, "registry.npmjs.org", [null], [12], {}])("refuses malformed task.json domains: %j", (domains) => {
    expect(() => loadTask(writeTask(domains), task.id)).toThrow(/allowedDomains|allowed domain/);
  });

  it.each(["localhost", "127.0.0.1", "localhost:43123", "*.example.com"])("refuses programmatic %s before preflight or filesystem work", async (domain) => {
    const preflight = vi.fn(async () => { throw new Error("preflight must not run"); });
    const jarvisHome = join(root, "not-created");
    await expect(runBaseline({ ...task, allowedDomains: [domain] }, { preflight, jarvisHome })).rejects.toThrow(/allowedDomains/);
    expect(preflight).not.toHaveBeenCalled();
    expect(existsSync(jarvisHome)).toBe(false);
  });

  // A port alone proves no ownership: no current runner starts and owns a local task service.
  it.each([...localDomains, ...wildcards])("refuses %s both when building and writing settings", (domain) => {
    const input = { ...context, allowedDomains: [domain] };
    expect(() => buildTaskSettings(input)).toThrow(/allowed domain/);
    const path = join(root, "settings.json");
    writeFileSync(path, "unchanged\n");
    expect(() => writeTaskSettings(path, input)).toThrow(/allowed domain/);
    expect(readFileSync(path, "utf8")).toBe("unchanged\n");
    // Supplying a settings object must not bypass validation of its trusted context either.
    const supplied = buildTaskSettings({ ...context, allowedDomains: [] });
    supplied.sandbox.network.allowedDomains = [domain];
    expect(() => writeTaskSettings(path, input, supplied)).toThrow(/allowed domain/);
    expect(readFileSync(path, "utf8")).toBe("unchanged\n");
  });

  it.each(["", "https://example.com", "example.com/path", "user@example.com", "example..com", "-bad.example", "example.com:0", "example.com:65536"])("refuses invalid settings domain %s", (domain) => {
    expect(() => buildTaskSettings({ ...context, allowedDomains: [domain] })).toThrow(/allowed domain/);
  });

  it("writes exact public hosts and permits valid public host:port settings", () => {
    const allowedDomains = [...publicDomains, "example.com:443"];
    const path = join(root, "public-settings.json");
    writeTaskSettings(path, { ...context, allowedDomains });
    expect(JSON.parse(readFileSync(path, "utf8")).sandbox.network.allowedDomains).toEqual(allowedDomains);
  });
});
