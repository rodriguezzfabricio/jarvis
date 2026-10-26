import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexDesignReviewer } from "../../packages/cli/src/review/design-codex.ts";
import { openCodexJail } from "../../packages/cli/src/review/confine.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
vi.mock("../../packages/cli/src/review/confine.ts", () => ({ openCodexJail: vi.fn() }));
const good = JSON.stringify({ verdict: "pass", scores: {quality: 4, originality: 4, craft: 4, functionality: 4}, findings: [] });
const done = (stdout: string): SessionOutcome => ({code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout, stderr: ""});
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "design-codex-")); });
afterEach(() => { rmSync(root, {recursive: true, force: true}); vi.resetAllMocks(); });
function setup() {
  const workspace = join(root, "checkout"), outputDir = join(root, "out"), binary = join(root, "fake-codex");
  mkdirSync(workspace); mkdirSync(outputDir); writeFileSync(binary, "fake");
  const images = [join(root, "screen.png")]; writeFileSync(images[0]!, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
  const close = vi.fn(async () => {});
  vi.mocked(openCodexJail).mockResolvedValue({ env: { HOME: "/empty" }, proxy: {refused: []}, wrap: (bin: string, args: readonly string[]) => ({bin: "/seatbelt", args: [bin, ...args]}), close } as never);
  const session = vi.fn(async (spec: SessionSpec) => {
    if (spec.args.includes("--version")) return done("codex-cli 0.164.0\n");
    writeFileSync(join(outputDir, "verdict.json"), good);
    return done('{"type":"turn.completed"}\n');
  });
  const input = { workspace, outputDir, images, prompt: "review data", timeoutMs: 1000 };
  return {input, binary, session, close, review: createCodexDesignReviewer({binary, home: root, session})};
}
describe("confined design Codex", () => {
  it("uses the existing jail for version and review, fixed default model, fresh context and image inputs", async () => {
    const f = setup();
    expect((await f.review(f.input)).rawVerdict).toBe(good);
    expect(openCodexJail).toHaveBeenCalledWith(expect.objectContaining({workspace: f.input.workspace, readFiles: f.input.images, writeDirs: [f.input.outputDir]}));
    expect(f.session.mock.calls.every(([s]) => s.bin === "/seatbelt")).toBe(true);
    const args = f.session.mock.calls[1]![0].args;
    for (const flag of ["gpt-6-astra", "--ephemeral", "--sandbox", "danger-full-access", "project_doc_max_bytes=0", "--output-schema", "-i", f.input.images[0]!]) expect(args).toContain(flag);
    expect(JSON.parse(readFileSync(join(f.input.outputDir, "schema.json"), "utf8")).properties).toHaveProperty("scores");
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("never spawns if confinement fails", async () => {
    const f = setup(); vi.mocked(openCodexJail).mockRejectedValue(new Error("canary readable"));
    expect((await f.review(f.input)).error).toContain("canary readable");
    expect(f.session).not.toHaveBeenCalled();
  });
  it.each(["wrong-version", "timeout", "overflow", "crash", "incomplete", "failed-event", "invalid-verdict", "symlink-verdict", "modified-checkout"]) ("fails closed: %s", async fault => {
    const f = setup();
    f.session.mockImplementation(async spec => {
      if (spec.args.includes("--version")) return done(fault === "wrong-version" ? "codex-cli 0.1.0" : "codex-cli 0.164.0");
      if (fault === "crash") throw new Error("fake crash");
      if (fault === "modified-checkout") writeFileSync(join(f.input.workspace, "changed"), "oops");
      if (fault === "symlink-verdict") { writeFileSync(join(root, "target"), good); symlinkSync(join(root, "target"), join(f.input.outputDir, "verdict.json")); }
      else writeFileSync(join(f.input.outputDir, "verdict.json"), fault === "invalid-verdict" ? "{}" : good);
      return { ...done(fault === "incomplete" ? "{}" : fault === "failed-event" ? '{"type":"turn.failed"}\n{"type":"turn.completed"}' : '{"type":"turn.completed"}'), timedOut: fault === "timeout", overflowed: fault === "overflow" };
    });
    expect((await f.review(f.input)).error).toBeTruthy();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("rejects missing images, symlink images and writable checkout overlap", async () => {
    const f = setup();
    expect((await f.review({...f.input, images: []})).error).toBeTruthy();
    const link = join(root, "link.png"); symlinkSync(f.input.images[0]!, link);
    expect((await f.review({...f.input, images: [link]})).error).toBeTruthy();
    expect((await f.review({...f.input, outputDir: f.input.workspace})).error).toBeTruthy();
    expect(f.session).not.toHaveBeenCalled();
  });
  it("refuses non-image attachments before starting the jail",async()=>{
    const f=setup();writeFileSync(f.input.images[0]!,"not an image");
    expect((await f.review(f.input)).error ?? "").toMatch(/image|screenshot/);
    expect(openCodexJail).not.toHaveBeenCalled();
  });
});
