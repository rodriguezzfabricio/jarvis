import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractArchive } from "../../packages/cli/src/eval/snapshot.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtx-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("snapshot archive extraction", () => {
  // git archive pads its output past tar's end-of-archive marker, and tar stops reading at the marker.
  // Fed through a pipe, a loaded machine sometimes failed the rest of the write with EPIPE (a mutation
  // control run, Oct 25). A megabyte of trailing padding makes that early stop certain.
  it("extracts an archive whose reader stops at the end-of-archive marker, and still refuses a broken one", () => {
    const src = join(root, "src");
    mkdirSync(src);
    writeFileSync(join(src, "a.txt"), "hello\n");
    const tar = execFileSync("tar", ["-c", "-f", "-", "-C", src, "a.txt"]);
    const dest = join(root, "dest");
    mkdirSync(dest);
    expect(() => extractArchive(Buffer.concat([tar, Buffer.alloc(1024 * 1024)]), dest)).not.toThrow();
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("hello\n");
    expect(readdirSync(dest)).toEqual(["a.txt"]);
    const broken = join(root, "broken");
    mkdirSync(broken);
    expect(() => extractArchive(Buffer.from("not an archive at all\n".repeat(64)), broken)).toThrow();
  });
});
