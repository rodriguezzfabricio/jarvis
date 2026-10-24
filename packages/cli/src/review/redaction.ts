import { createHash } from "node:crypto";
import { findCredentials, findEncodedCredentials, findSecretFields } from "../eval/snapshot.ts";

function fingerprint(text: string): string {
  return `[redacted:sha256:${createHash("sha256").update(text).digest("hex")}]`;
}
function sensitive(text: string): boolean {
  if (findCredentials(text).length || findEncodedCredentials(text).length || findSecretFields("review", text).length) return true;
  try {
    JSON.parse(text);
    return findSecretFields("review.json", text).length > 0;
  } catch { return false; }
}

/** Best-effort output hygiene; read-only Codex can still read credentials outside the checkout. */
export function redactReviewText(text: string): string {
  let redacted = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, fingerprint);
  redacted = redacted.replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/g, (token, offset: number) => {
    // A fingerprint produced above must not be fingerprinted again.
    if (redacted.slice(Math.max(0, offset - 17), offset).endsWith("[redacted:sha256:")) return token;
    return fingerprint(token);
  });
  return sensitive(redacted) ? fingerprint(text) : redacted;
}
