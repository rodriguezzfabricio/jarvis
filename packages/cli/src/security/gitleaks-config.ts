import { fileURLToPath } from "node:url";
import type { ScannerPin } from "./scanners.ts";

/** The runner supplies the default, including for old pins; explicit configs still undergo validation. */
export function withGitleaksConfig(pin: ScannerPin): ScannerPin {
  if (pin.args.some((arg) => arg === "--config" || arg.startsWith("--config="))) return pin;
  return {
    ...pin, args: [...pin.args, "--config", "@rules"],
    rulesFile: fileURLToPath(new URL("gitleaks.toml", import.meta.url)),
  };
}
