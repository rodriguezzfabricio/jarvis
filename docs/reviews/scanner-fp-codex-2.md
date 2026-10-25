FAIL

(Codex gpt-6.1-sol, read-only, narrow re-check of 513ce13, Oct 25. Restored from the integrator's transcript; the original file was lost to a reboot.)

1. NOT RESOLVED — original metadata cases are caught, but a forged PNG IDAT containing UTF-16 PEM still returns `[]`.
2. RESOLVED — supplied Brotli input reports `npm token`.
3. NOT RESOLVED — uneven and 8-character wrapping are caught; 7- and 9-character wrapping of the same valid key return `[]`.
4. RESOLVED — supplied lowercase secret reports `credential literal "jwtSecret"`.
5. RESOLVED — supplied localhost inputs report `credential URL` and `credential URL query`.
6. RESOLVED — supplied `registryLogin` reports `base64 user:password`.

New blocking findings (K = the 64-character Ed25519 base64 key):
- HIGH — `snapshot-media.ts:61`: PNG exemption trusts chunk names. PNG signature, CRC-correct IDAT containing a UTF-16LE PEM of K, then IEND, no IHDR: scanning returns `[]`. Fix: refuse malformed media before granting exemptions and apply literal-key detection across UTF-16 views.
- HIGH — `snapshot.ts:186`: `BASE64_RUN` requires four characters, dropping short terminal lines before wrapping is joined. `K.match(/.{1,7}/g).join("\n")+"\n"` returns `[]`; width 9 also passes. Fix: retain 1–3-character fragments, then validate the decoded structure.
- HIGH — `snapshot-media.ts:161`: forged font directories hide credentials. `Buffer.concat([Buffer.from("0001000000040000ff000000","hex"),Buffer.from(K)])` returns `[]`. Fix: validate entries before exempting structure, and scan directory/header bytes.
- HIGH — `snapshot.ts:308`: DER candidates are materialized before expansion limits apply. 14,000 newline-separated base64 encodings of `[0x30,0x82,0xff,0xf8,i>>8,i&255]` exhausted a 128 MB heap. Fix: an aggregate candidate-allocation budget, processed incrementally.
