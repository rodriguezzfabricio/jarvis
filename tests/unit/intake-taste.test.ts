import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { saveTaste, tasteSchema } from "../../packages/cli/src/intake/taste.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const profile = { admired: ["App one", "App two", "App three"], aiMade: "Generic app", tone: "serious", dislikedColors: [], dislikedFonts: ["Comic Sans"], platforms: ["macOS", "iOS"] };
function setup() { const home = mkdtempSync(join(tmpdir(), "jarvis-taste-")); dirs.push(home); const file = join(home, "input.json"); writeFileSync(file, JSON.stringify(profile)); return { home, file, target: join(home, ".jarvis/memory/user/taste.json") }; }
it("validates a small strict profile grounded in decision 39", () => {
  expect(tasteSchema.parse(profile)).toEqual(profile);
  for (const value of [{ ...profile, admired: [] }, { ...profile, admired: Array(6).fill("app") }, { ...profile, tone: "both" }, { ...profile, extra: true }, { ...profile, platforms: [] }]) expect(tasteSchema.safeParse(value).success).toBe(false);
});
it("saves privately and atomically under an injected runner home and replaces an existing profile", () => {
  const s = setup(); expect(saveTaste(s.file, { home: s.home })).toBe(s.target);
  expect(JSON.parse(readFileSync(s.target, "utf8"))).toEqual(profile); expect(lstatSync(s.target).mode & 0o777).toBe(0o600);
  writeFileSync(s.file, JSON.stringify({ ...profile, tone: "playful" })); saveTaste(s.file, { home: s.home });
  expect(JSON.parse(readFileSync(s.target, "utf8")).tone).toBe("playful"); expect(readdirSync(join(s.home, ".jarvis/memory/user"))).toEqual(["taste.json"]);
});
it.each([".jarvis", ".jarvis/memory", ".jarvis/memory/user", ".jarvis/memory/user/taste.json"])("refuses a symlink at %s, including dangling links", (part) => {
  const s = setup(); const path = join(s.home, part); mkdirSync(join(path, ".."), { recursive: true });
  const outside = join(s.home, "outside"); if (!part.endsWith(".json")) mkdirSync(outside); else writeFileSync(outside, "unchanged");
  symlinkSync(outside, path); expect(() => saveTaste(s.file, { home: s.home })).toThrow(/symlink/i);
  rmSync(path); symlinkSync(join(s.home, "missing"), path); expect(() => saveTaste(s.file, { home: s.home })).toThrow(/symlink/i);
  if (part.endsWith(".json")) expect(readFileSync(outside, "utf8")).toBe("unchanged");
});
it("validates before creating runner state and cleans up a failed atomic replacement", () => {
  const s = setup(); writeFileSync(s.file, '{}'); expect(() => saveTaste(s.file, { home: s.home })).toThrow(/taste/i); expect(existsSync(join(s.home, ".jarvis"))).toBe(false);
  writeFileSync(s.file, JSON.stringify(profile)); saveTaste(s.file, { home: s.home });
  const rename = vi.fn(() => { throw new Error("rename fault"); });
  expect(() => saveTaste(s.file, { home: s.home, rename })).toThrow("rename fault");
  expect(JSON.parse(readFileSync(s.target, "utf8"))).toEqual(profile); expect(readdirSync(join(s.home, ".jarvis/memory/user"))).toEqual(["taste.json"]);
});
