/**
 * A pinned-Rust fixture in the eval gate's layout (decision 164), as jarvis-evals' rust-fixture.sh leaves it:
 * toolchain/ (rustc, cargo and the Tauri CLI), cargo-home/config.toml (crates only from vendor/), vendor/ and
 * fixture.json. The binaries are shell scripts; no network, no real Rust. Also a stand-in for the Command Line
 * Tools folder, whose real copy is root-owned (tests accept it through the rustHost seam).
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { rustFixtureDigest, rustHost } from "../../../packages/cli/src/toolchain/rust.ts";

export const FIXTURE_RUST = "1.99.1";
export const FIXTURE_TARGET = "aarch64-apple-darwin";

/** Fills `root` (created) with a fixture and returns it. */
export function makeRustFixture(root: string, info: Record<string, unknown> = { rust: FIXTURE_RUST, target: FIXTURE_TARGET, tauriCli: "2.12.3" }): string {
  const bin = join(root, "toolchain", "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["cargo", "rustc", "cargo-tauri"]) writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} ${FIXTURE_RUST} fake"\necho "CARGO_HOME=$CARGO_HOME SDKROOT=$SDKROOT"\n`, { mode: 0o755 });
  mkdirSync(join(root, "toolchain", "lib", "rustlib"), { recursive: true });
  writeFileSync(join(root, "toolchain", "lib", "rustlib", "components"), "rustc\ncargo\nrust-std-aarch64-apple-darwin\n");
  mkdirSync(join(root, "cargo-home"), { recursive: true });
  writeFileSync(join(root, "cargo-home", "config.toml"), '[source.crates-io]\nreplace-with = "jarvis-vendored"\n\n[source.jarvis-vendored]\ndirectory = "vendor"\n\n[net]\noffline = true\n');
  const crate = join(root, "vendor", "serde-1.0.228");
  mkdirSync(join(crate, "src"), { recursive: true });
  writeFileSync(join(crate, "Cargo.toml"), '[package]\nname = "serde"\nversion = "1.0.228"\n');
  writeFileSync(join(crate, "src", "lib.rs"), "pub trait Serialize {}\n");
  writeFileSync(join(crate, ".cargo-checksum.json"), '{"files":{},"package":"' + "0".repeat(64) + '"}');
  writeFileSync(join(root, "fixture.json"), `${JSON.stringify(info)}\n`);
  return root;
}

/** Pins the fixture's current contents for `rust`/`target`, for this test (the real pins name real fixtures only). */
export function pinRustFixture(fixture: string, rust = FIXTURE_RUST, target = FIXTURE_TARGET): string {
  const digest = rustFixtureDigest(fixture);
  vi.spyOn(rustHost, "pinnedFixtureSha256").mockImplementation((key: string) => (key === `${rust}.${target}` ? digest : undefined));
  return digest;
}

/** A Command Line Tools stand-in: usr/bin/clang and SDKs/MacOSX.sdk, a link to a versioned SDK, as on the Mac. */
export function makeCommandLineTools(root: string): string {
  mkdirSync(join(root, "usr", "bin"), { recursive: true });
  writeFileSync(join(root, "usr", "bin", "clang"), "#!/bin/sh\necho clang\n", { mode: 0o755 });
  mkdirSync(join(root, "SDKs", "MacOSX26.5.sdk"), { recursive: true });
  symlinkSync("MacOSX26.5.sdk", join(root, "SDKs", "MacOSX.sdk"));
  return root;
}

/** Points the preparation at `clt` and accepts it as system-owned (a test can't make a root-owned folder). */
export function useCommandLineTools(clt: string): void {
  vi.spyOn(rustHost, "commandLineTools").mockReturnValue(clt);
  vi.spyOn(rustHost, "systemOwned").mockReturnValue(true);
  vi.spyOn(rustHost, "target").mockReturnValue(FIXTURE_TARGET);
}
