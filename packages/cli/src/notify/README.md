# Runner notifications

This module is for the trusted runner, outside task sessions. Topic names are bearer
capabilities. Keep the notifier configuration and ledger outside agent-readable folders.
Callers pass short human summaries with no code, secrets, full payloads or report text.
The byte limit is not a redactor. Full details belong in `REPORT.md` on the Mac.

`NtfyNotifier` implements `Notifier.send(message, actions)` and `poll()`. Configure
`baseUrl`, distinct `topic` and `replyTopic`, and optionally `since` and `timeoutMs`.
Public hosts require HTTPS; plain HTTP is accepted only for loopback hosts.
HTTP publishing uses ntfy's JSON API, with up to three fixed-body `http` actions.
Text is strictly below 4096 UTF-8 bytes; truncation preserves character boundaries
and appends a pointer to `REPORT.md`. Usage waits of two hours or less are suppressed.
No setup, email transport, attachments or CLI commands are registered in this lane.

## Sending questions and approvals

1. Open the runner-owned `Ledger`, then construct `ReplyInbox(ledger)`.
2. Register a stable request ID with `inbox.register(id, "question" | "approval")`.
   For approvals, use the broker's existing `approvalId`, never a new independent ID.
   Registration persists a cryptographically random nonce before any button is sent.
   Request IDs cannot be registered twice. Retain the returned registration to retry
   delivery of the same notification; do not issue a new approval ID after a timeout.
3. Build buttons with `actionsFor(kind, request.requestId, request.nonce)` and send a
   short message. Questions offer Use defaults; approvals offer Approve and Reject.
   Do not forward `Broker.onApprovalRequest.summary` without reviewing its privacy:
   a broker summary can contain recipient names or other sensitive payload details.

## Receiving and recording

Process each message returned by `poll()` with `inbox.accept(message)`. Its result
is a typed counted answer or an ignored reason. Unknown requests/nonces, reused
nonces, wrong answer kinds, and later answers are ignored and logged without
copying their bodies. Replayed transport IDs return `ignored/duplicate` without
appending another entry. Bare approval words cannot approve anything.
Other free text becomes a steer note, never an operation or a shell command.

For each counted answer, call `recordAnswer(ledger, result, broker)` and send its
**returned message**, with no actions, only after recording succeeds. Do not send the
intent's provisional `result.confirmation` directly. Defaults become a `decision`
with `acceptedDefaults: true, confirmed: true`; steer notes become `steer` entries
whose `data.note` contains the note (decision 84).
Approval answers go exclusively through the existing `Broker.decide` method. This
records the broker's exact payload hash/op binding and does not execute an action.
A tap conflicting with a prior broker answer gets a terminal `notify` recorded marker
with `outcome: "superseded", by: "approve" | "reject"`; the returned message says
"Not counted" and names the earlier answer. A missing broker request gets
`outcome: "no-request"` and a matching "Not counted" message. These intents leave
`pending()`. Classification uses verified, exactly bound broker records; unrelated
broker failures still throw and remain pending. Repeated recording returns the same
message without calling the broker again.

All notifier bookkeeping uses `notify` entries: nonce registrations, accepted reply
intents, ignored logs, and recorded markers. Entries are tagged `source: "notify"`
and a `phase`. Defaults decisions and steer notes are separate business entries;
only the `notify` recorded marker removes an intent from `inbox.pending()`.
Replay pending intents on startup before polling. Recording is idempotent, including
a crash after the broker writes its approval, or after a defaults/steer entry is
written but before the marker is durable. Confirmation delivery has no durable
receipt in this stage; retry sending the returned message if publishing fails.

Persist `notifier.lastId` in runner state **after the entire returned batch has been
processed**, including ignored messages. Retain/retry the batch on processing errors.
Omitting `since` starts at the notifier construction time in Unix seconds; pass a
saved cursor explicitly when resuming a run. Retained-history replay is opt-in.
`lastId` is unchanged if JSON or a `message` event is malformed. Unknown event
types are skipped; only `message` events are validated strictly. The adapter has a
ten-second HTTP timeout by default and refuses redirects; it never includes topic URLs or HTTP
response bodies in its status errors.

## Intake deadline

`waitForIntake(readAnswers, { clock?, timeoutMs?, pollMs? })` returns `answers` or
`defaults (unconfirmed)` after fifteen minutes by default, polling every five seconds.
The callback supplies only counted answers for the relevant intake; handle steer notes separately. A stalled
reader cannot extend the deadline. Use it for intake/spec confirmation, never for
approval hard stops. Timeout does not write accepted defaults or any approval.

The clock supplies `now()` and `sleep(ms, signal?)`; injected sleeps should honor
abort so an early answer cancels the deadline timer. Poll errors are treated as no
answer, but `LedgerTamperError` always propagates and stops intake. Timed-out in-flight reads may finish later; they must not
perform intake or spec transitions themselves.

## Worker validation constraint

The worker sandbox denies binding to `127.0.0.1` (`listen EPERM`). HTTP contract tests
use an in-memory request/response transport, and a separate real loopback smoke test
skips only on that explicit error. The integrator must run the smoke test in a context
that allows loopback. No public ntfy server, real credentials or real Claude are used.
Phone button and typed-reply validation (backlog #1) still needs the actual phone;
this module cannot establish Safari/Shortcut compatibility from fake HTTP tests.

`mutations.json` contains uniquely anchored mutation definitions for the integrator.
