# Credits

Jarvis's skills borrow from other open-source work (decision 31). Each borrowed piece is listed here with its source and license, and each skill that adapts one says so in its opening lines.

## superpowers

- **Source:** https://github.com/obra/superpowers, by Jesse Vincent.
- **License:** MIT (notice below).
- **Used in:**
  - `build`: adapted from `test-driven-development` (the red-green-refactor cycle, "no production code without a failing test first", its rationalizations list), `verification-before-completion` (no completion claims without fresh verification) and the implementer prompt and status contract from `subagent-driven-development` and `executing-plans`.
  - `debug`: adapted from `systematic-debugging` (root cause before fixes, the four phases, one hypothesis at a time, the stop after 3 failed fixes) together with the test-first and verification rules above.
- **What changed:** the skills were rewritten for Jarvis's task sessions. A session runs unattended under `dontAsk`, so "ask your human partner" became a status in the result notes. The session never commits (the runner does), runs one plain shell command per call (decision 68), never touches protected checks (decision 15), and its notes are claims that the runner's checks confirm or refute (decision 49). Escalation goes through the runner's routing table (decision 24) instead of a conversation. superpowers' brainstorming is not used; Jarvis's own intake replaces it (decision 30).

```
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
