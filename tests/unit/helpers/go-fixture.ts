/**
 * A pinned-Go fixture in the eval gate's layout (decision 123): an extracted module cache that holds one
 * module and the toolchain module's zip, as jarvis-evals' go-fixture.sh leaves it. The toolchain's `go` is a
 * shell script that prints its version and the variables a session would see. No network, no real Go.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { goPlatform } from "../../../packages/cli/src/toolchain/go.ts";

export const FIXTURE_GO = "go1.26.10";

export function toolchainModule(version = FIXTURE_GO, platform = goPlatform()): string {
  return `golang.org/toolchain@v0.0.1-${version}.${platform}`;
}

/** Fills `modCache` (created) and returns it. */
export function makeGoFixture(modCache: string, version = FIXTURE_GO, platform = goPlatform()): string {
  const mod = toolchainModule(version, platform);
  mkdirSync(dirname(modCache), { recursive: true });
  const stage = mkdtempSync(join(dirname(modCache), ".stage-"));
  try {
    const goBin = join(stage, mod, "bin", "go");
    mkdirSync(dirname(goBin), { recursive: true });
    writeFileSync(goBin, `#!/bin/sh\necho "go version ${version} fake"\necho "GOTOOLCHAIN=$GOTOOLCHAIN GOMODCACHE=$GOMODCACHE GOPROXY=$GOPROXY"\n`);
    chmodSync(goBin, 0o755);
    writeFileSync(join(stage, mod, "VERSION"), `${version}\n`);
    const zipDir = join(modCache, "cache", "download", "golang.org", "toolchain", "@v");
    mkdirSync(zipDir, { recursive: true });
    execFileSync("/usr/bin/zip", ["-q", "-r", join(zipDir, `v0.0.1-${version}.${platform}.zip`), mod], { cwd: stage });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const lib = join(modCache, "example.com", "lib@v1.0.0");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "lib.go"), "package lib\n\nfunc Answer() int { return 42 }\n");
  return modCache;
}
