---
status: in-progress
depends: [release-packaging]
specs:
  - specs/sending.md
  - specs/conventions.md
  - specs/cli.md
---

# Fixes from the v0.1.0 source review

## Scope

An independent review of the v0.1.0 tag found no blockers, four places where the tool reports
something it does not know or skips a gate, and eight smaller items. This plan fixes all of
them for v0.1.1. Out of scope: anything the review recorded as an accepted exception (the
SessionStart-only hook, no `--confirm` on sends, systemd-user only).

## Implements

- `sending.md` "Mechanics": after the frame is written, only a refusal is a failure; an
  unreadable success answer is `OUTCOME_UNKNOWN`. "Send limits": rate counts survive a restart.
- `conventions.md` "The gate inventory": widening judged by effective scope. "Reads fail
  closed": service state, journal, a killed foreground daemon. "Streams": a follow that loses
  the daemon. `UPDATE_FAILED`. Environment variables echoed where they made a choice.
- `cli.md`: default limits on `chats`, `groups` and participants; the `DAEMON_NOT_RUNNING` hint.

## Approach

1. **Sends.** In the WhatsApp client's error mapping, classify by whether the send call was
   reached: everything after it that is not a proven server refusal maps to outcome-unknown,
   for messages and reactions. The core keeps the row pending. The CLI treats a malformed
   success answer to a send as `OUTCOME_UNKNOWN`.
2. **Gate.** `Loosens` computes every affected chat's effective scope before and after and
   flags any that widened; the CLI gates the same cases before calling, and undo hints carry
   `--confirm` where the undo is gated.
3. **Service.** The service query throws `SERVICE_FAILED` on a non-zero exit; `daemon stop`
   waits for inactive. `daemon logs` treats unexpected stderr or no output as `LOGS_FAILED`.
   `daemon run` exits 0 only for a signal it passed on.
4. **Smaller items.** Stream loss as `STREAM_CLOSED` or `DAEMON_UNREACHABLE` with the resume
   cursor; the not-running hint by install state; default limits; the two environment
   variables echoed in home and `doctor`; `UPDATE_FAILED`; rate counts from recorded sends;
   the partial hook-uninstall message names what was already removed; the `--json-out` error
   for a path whose directory exists says why it could not be opened.

## Validation

- [ ] A client error after the send call that is not a refusal answers `OUTCOME_UNKNOWN`, the
      row stays pending, and a retry with the same id sends nothing new (message and reaction).
- [ ] An error before the send call is a definite failure and a retry sends.
- [ ] A 200 send answer that is JSON but not the expected object is `OUTCOME_UNKNOWN`.
- [ ] `scope set tagged` from `dm-only`, a chat override `none` to `tagged`, and removing a
      `none` override under account scope `full` each answer `CONFIRM_REQUIRED` without
      `--confirm`, from the CLI and from a direct socket request.
- [ ] Removing an override that narrows, and every tightening, needs no `--confirm`.
- [ ] With a service manager that exits non-zero, `daemon status` and `daemon stop` answer
      `SERVICE_FAILED`.
- [ ] `daemon stop` on a unit that stays active answers `SERVICE_FAILED`, not `stopped`.
- [ ] `daemon logs` with "No journal files were found" on stderr, and with no output, answers
      `LOGS_FAILED`; a true empty log still answers `0 lines`.
- [ ] `daemon run` whose daemon is killed exits non-zero with `DAEMON_EXITED`.
- [ ] `events --follow` whose daemon goes away ends with `STREAM_CLOSED` or
      `DAEMON_UNREACHABLE` and the last `seq`.
- [ ] `DAEMON_NOT_RUNNING` for an account not installed as a service does not suggest
      `daemon start`.
- [ ] `chats`, `groups` and `chat view` participants cut at 100 with `N of M` and a hint.
- [ ] Home and `doctor` echo `WHATSAPP_AXI_CONFIG_DIR` and `WHATSAPP_AXI_DAEMON` when set.
- [ ] A failed `update` answers `UPDATE_FAILED`.
- [ ] The rate limit still refuses after a daemon restart inside the window.
- [ ] The whole gate set passes: lint, format, typecheck, build, docs check, scrub, licence
      gate, `go vet`, `go test`, the CLI tests and the packed-tarball install test.

## Risks

- Classifying "proven refusal" too narrowly leaves rows pending that did fail. That is the safe
  side: the operator checks `read <chat>` and retries under a new id.
