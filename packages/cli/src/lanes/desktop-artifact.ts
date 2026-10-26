import { realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { insideTree, materializeTree } from "./materialize.ts";
export interface DesktopArtifact { bundlePath: string; files: Record<string, string> }

/** Called by the runner only after case processes stop, before the gate removes its checkout. */
export function captureDesktopBundle(checkout: string, bundle: string, outputRoot: string): DesktopArtifact {
  if (!bundle.endsWith(".app") || isAbsolute(bundle) || bundle.split("/").some(p => !p || p === "." || p === "..") || /[\\\x00-\x1f]/.test(bundle)) throw new Error("invalid desktop build bundle");
  const source = join(realpathSync(checkout), bundle);
  if (!insideTree(realpathSync(checkout), realpathSync(source))) throw new Error("built bundle escapes checkout");
  const destination = join(realpathSync(outputRoot), basename(bundle));
  // The approved root makes materializeTree re-check containment itself, closing the race after the check above.
  return { bundlePath: destination, files: materializeTree(source, destination, { sourceRoot: realpathSync(checkout) }) };
}
