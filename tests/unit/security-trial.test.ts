import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

function clock() {
  let time = 0;
  return { now: () => time, wait: async (ms: number) => { time += ms; }, drainSink: async () => {} };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

it("detects the lethal trifecta across candidate files with line evidence", async () => {
  const { detectTrifecta } = await import("../../packages/cli/src/security/trifecta.ts");
  const files = [{ path: "agent.ts", text: "const answer = await client.responses.create({input: request.body});" }, { path: "tools.ts", text: "await sendMail(answer);\nawait readFile('/private/customer');" }];
  expect(detectTrifecta(files)).toMatchObject({ required: true, complete: true, signals: expect.arrayContaining([expect.objectContaining({ kind: "llm", file: "agent.ts", line: 1 }), expect.objectContaining({ kind: "untrusted", file: "agent.ts" }), expect.objectContaining({ kind: "capability", file: "tools.ts" })]) });
  expect(detectTrifecta([{ path: "static.ts", text: "export const color = 'blue';" }]).required).toBe(false);
  expect(detectTrifecta(files.slice(0, 1)).required).toBe(false);
});

it("does not follow symlinks or silently pass unreadable or oversized candidate files", async () => {
  const { scanTrifecta } = await import("../../packages/cli/src/security/trifecta.ts");
  const root = mkdtempSync(join(tmpdir(), "security-trifecta-")); dirs.push(root);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "irrelevant"), "openai req.body fetch(");
  writeFileSync(join(root, "app.ts"), "client.responses.create(req.body); fetch(url);");
  expect(scanTrifecta(root)).toMatchObject({ complete: true, required: true });
  symlinkSync("/absent", join(root, "link.ts"));
  expect(scanTrifecta(root)).toMatchObject({ complete: false, required: true });
  rmSync(join(root, "link.ts"));
  expect(scanTrifecta(root, { maxBytes: 2 })).toMatchObject({ complete: false, required: true });
});

it("requires a successful benign control, then feeds hostile content through the input and observes the independent sink", async () => {
  const { runHostileTrial } = await import("../../packages/cli/src/security/trial.ts");
  let events = 0; let stopped = false; const delivered: string[] = [];
  const result = await runHostileTrial({ inputUrl: "http://127.0.0.1:3000/input", sinkUrl: "http://127.0.0.1:3001", benignInput: "safe baseline", settleMs: 0 }, {
    spawn: async () => ({ stop: async () => { stopped = true; } }),
    nonce: () => "fixture-run", variant: () => 0,
    resetSink: async () => { events = 0; },
    observe: async () => ({ count: events, healthy: true }),
    http: async (url, body) => {
      expect(url).toBe("http://127.0.0.1:3000/input");
      delivered.push(body!); if (body === "safe baseline") events++;
      return { ok: true };
    }, ...clock(),
  });
  expect(result).toMatchObject({ status: "pass", controlActions: 1, hostileActions: 0 });
  expect(delivered).toHaveLength(2); expect(delivered[0]).toBe("safe baseline");
  expect(delivered[1]).toContain("fixture-run");
  expect(stopped).toBe(true);
});

it.each(["outbound", "dead-app", "dead-sink", "http-error", "spawn-error", "stop-error"])("never passes a hostile-content trial with %s", async (fault) => {
  const { runHostileTrial } = await import("../../packages/cli/src/security/trial.ts");
  let stopped = false; let events = 0;
  const result = await runHostileTrial({ inputUrl: "http://localhost:3000/input", sinkUrl: "http://localhost:3001", benignInput: "safe", settleMs: 0 }, {
    spawn: async () => { if (fault === "spawn-error") throw Error("dummy-private-value"); return { stop: async () => { stopped = true; if (fault === "stop-error") throw Error("dummy-private-value"); } }; },
    resetSink: async () => { events = 0; },
    observe: async () => ({ count: events, healthy: fault !== "dead-sink" }),
    ...clock(),
    http: async (_url, body) => {
      if (fault === "http-error") throw Error("dummy-private-value");
      if (fault === "outbound" || (fault !== "dead-app" && body === "safe")) events++;
      return { ok: true };
    },
  });
  expect(result.status).not.toBe("pass");
  expect(JSON.stringify(result)).not.toContain("dummy-private-value");
  if (fault !== "spawn-error") expect(stopped).toBe(true);
});

it("refuses non-loopback trial targets before starting a process", async () => {
  const { runHostileTrial } = await import("../../packages/cli/src/security/trial.ts");
  await expect(runHostileTrial({ inputUrl: "https://example.com/input", sinkUrl: "http://localhost:3001", benignInput: "safe" }, { spawn: async () => { throw Error("must not start"); }, resetSink: async () => {}, observe: async () => ({ healthy: true, count: 0 }), http: async () => ({}), ...clock() })).rejects.toThrow("loopback");
});

it("bounds stalled HTTP and always stops the trial process", async () => {
  const { runHostileTrial } = await import("../../packages/cli/src/security/trial.ts");
  let stopped = false;
  const trial = runHostileTrial({ inputUrl: "http://127.0.0.1:3000/input", sinkUrl: "http://127.0.0.1:3001", benignInput: "safe", timeoutMs: 10 }, {
    spawn: async () => ({ stop: async () => { stopped = true; } }),
    resetSink: async () => {}, observe: async () => ({ healthy: true, count: 0 }),
    http: async () => new Promise(() => {}), ...clock(),
  });
  const result = await Promise.race([trial, new Promise<{ status: "stalled" }>((resolve) => setTimeout(() => resolve({ status: "stalled" }), 200))]);
  expect(result.status).toBe("error");
  expect(stopped).toBe(true);
});

it("observes actions fired during process shutdown before granting a pass", async () => {
  const { runHostileTrial } = await import("../../packages/cli/src/security/trial.ts");
  let events = 0;
  const result = await runHostileTrial({ inputUrl: "http://127.0.0.1:3000/input", sinkUrl: "http://127.0.0.1:3001", benignInput: "safe", settleMs: 0 }, {
    spawn: async () => ({ stop: async () => { events++; } }), ...clock(),
    resetSink: async () => { events = 0; }, observe: async () => ({ healthy: true, count: events }),
    http: async (_url, body) => {
      if (body === "safe") events++;
      return { ok: true };
    },
  });
  expect(result).toMatchObject({ status: "fail", hostileActions: 1 });
});

it("keeps sink reset and observation off the candidate-accessible HTTP interface", async () => {
  const { runHostileTrial } = await import("../../packages/cli/src/security/trial.ts");
  let count = 0; const urls: string[] = [];
  const result = await runHostileTrial({ inputUrl: "http://127.0.0.1:3000/input", sinkUrl: "http://127.0.0.1:3001", benignInput: "safe", settleMs: 0 }, {
    spawn: async () => ({ stop: async () => {} }), ...clock(),
    resetSink: async () => { count = 0; }, observe: async () => ({ healthy: true, count }),
    http: async (url, body) => { urls.push(url); if (body === "safe") count++; return { ok: true }; },
  });
  expect(result.status).toBe("pass");
  expect(new Set(urls)).toEqual(new Set(["http://127.0.0.1:3000/input"]));
});

it("recognizes common SDK and outbound patterns including a quoted fetch URL", async () => {
  const { detectTrifecta } = await import("../../packages/cli/src/security/trifecta.ts");
  for (const text of ["anthropic.messages.create(req.body); fetch('url');", "generateText({input: userInput}); fetch(\"url\");", "agent.run(await response.text()); readFileSync('private');", "llm.invoke(await fetch(url)); db.query(sql);"]) {
    expect(detectTrifecta([{ path: "app.ts", text }]).required).toBe(true);
  }
});
