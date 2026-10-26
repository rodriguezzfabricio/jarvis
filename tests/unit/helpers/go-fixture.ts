/**
 * A pinned-Go fixture in the eval gate's layout (decision 123): an extracted module cache that holds one
 * module and the toolchain module's zip, as jarvis-evals' go-fixture.sh leaves it. The toolchain's `go` is a
 * shell script that prints its version and the variables a session would see. No network, no real Go. The zip
 * is written byte by byte with no timestamps, so its SHA-256 is fixed and tests can pin it (pinFixtureToolchain).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { goPlatform, toolchainHost } from "../../../packages/cli/src/toolchain/go.ts";
import { makeZip } from "./zip-writer.ts";

export const FIXTURE_GO = "go1.26.10";

export function toolchainModule(version = FIXTURE_GO, platform = goPlatform()): string {
  return `golang.org/toolchain@v0.0.1-${version}.${platform}`;
}

/** The fixture's toolchain zip, in Go's own layout (data descriptors, Unix modes, no folder entries). */
export function fixtureZip(version = FIXTURE_GO, platform = goPlatform()): Buffer {
  const mod = toolchainModule(version, platform);
  return makeZip([
    { name: `${mod}/bin/go`, data: `#!/bin/sh\necho "go version ${version} fake"\necho "GOTOOLCHAIN=$GOTOOLCHAIN GOMODCACHE=$GOMODCACHE GOPROXY=$GOPROXY"\n`, mode: 0o100755, dataDescriptor: true },
    { name: `${mod}/VERSION`, data: `${version}\n`, dataDescriptor: true },
  ]);
}

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Pins `zip` as the toolchain for go1.26.10 on this machine, for this test (the real pins name real zips only). */
export function pinToolchainZip(zip: Buffer, version = FIXTURE_GO, platform = goPlatform()): void {
  const hash = sha256(zip);
  vi.spyOn(toolchainHost, "pinnedZipSha256").mockImplementation((key: string) => (key === `${version}.${platform}` ? hash : undefined));
}

/** Pins the fixture's own toolchain zip. */
export function pinFixtureToolchain(): void {
  pinToolchainZip(fixtureZip());
}

/** Fills `modCache` (created) and returns it. */
export function makeGoFixture(modCache: string, version = FIXTURE_GO, platform = goPlatform()): string {
  const zipDir = join(modCache, "cache", "download", "golang.org", "toolchain", "@v");
  mkdirSync(zipDir, { recursive: true });
  writeFileSync(join(zipDir, `v0.0.1-${version}.${platform}.zip`), fixtureZip(version, platform));
  const lib = join(modCache, "example.com", "lib@v1.0.0");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "lib.go"), "package lib\n\nfunc Answer() int { return 42 }\n");
  return modCache;
}
