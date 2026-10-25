(Codex gpt-6-astra, read-only, narrow re-check of 020657d, Oct 25.)

PASS

1. **RESOLVED — PNG exemption:** Original no-IHDR PNG is classified malformed and returns `private key` / `binary private key`.
2. **RESOLVED — short trailing base64 lines:** K wrapped at widths 7 and 9 returns `binary private key`.
3. **RESOLVED — forged font directory:** Original 76-byte font is classified malformed and returns `binary private key`.
4. **RESOLVED — DER candidate exhaustion:** Original 14,000-line input exits normally under a 128 MB heap and returns `wrapped base64 candidate limit; needs review`.

No new critical/high blockers found outside the accepted gaps, including resource-limit false acceptance or false-passing tests. All 102 regression cases passed through their original callbacks using an in-memory assertion harness on Node 24. Additional malformed-PNG recovery probes detected compressed npm tokens in UTF-8 and both UTF-16 byte orders.

No files modified.
