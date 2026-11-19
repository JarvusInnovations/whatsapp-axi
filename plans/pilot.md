---
status: in-progress
depends: [sending, service-linux]
specs:
  - specs/scopes.md
  - specs/daemon.md
  - specs/security.md
awaits:
  - "an operator with a spare WhatsApp account to link, for one pairing code"
---

# Pilot: one bot account on one Linux host

## Scope

Run the tool for real, from a source checkout, with one account in `tagged` scope, and settle the
questions only live traffic can answer. Produces `docs/pilot.md` and corrections to the specs.

## Implements

- `scopes.md`: "The live check".
- `daemon.md`: linking and connected behaviour, confirmed against WhatsApp.

## Approach

1. Write `docs/pilot.md`: build, `account add`, `daemon install`, `auth link`, a direct-message
   test, then one group.
2. Run it with the operator. In the group: a tagged message arrives; a reply to it arrives; a reply
   to the account's own message arrives; an untagged message carrying a unique marker does not.
3. Search every file of the account, `session.db` included, for the marker.
4. Record what the live traffic showed for each open question below and amend the specs.

## Validation

- [ ] The account links by pairing code and reaches `connected`
- [ ] A direct message from an operator is kept; one from a non-operator is discarded
- [ ] Each tagged rule behaves as specified in a real group, in a hidden-id group if one is available
- [ ] The marker from an untagged group message is found in no file of the account
- [ ] A reply sent by the account renders as a quote on a phone; a PDF sent arrives with its name
- [ ] The service survives a reboot
- [ ] Each open question has an answer written into the relevant spec

## Risks

- WhatsApp may flag a freshly linked automated account. Keep the pilot's volume small.

## Notes

Open questions for live traffic: what a quoted copy contains; how a mention appears in a hidden-id
group; whether a group-wide mention has a recognizable field; how often messages carry a
per-message secret; what the phone does when history is not downloaded.

**2026-11-15, first live run (fix round, PR 16).** The account linked by pairing code. Found:
the state stuck at `connecting` right after the link although the connection was up (the
pairing socket's late Disconnected); presence failed for want of the push name after the link
and after a restart and was never retried; a start with a session recorded a false
`unlinked (no session)` first; a plain `go build` reported `0.0.0-dev`, so `doctor` warned of a
version mismatch; a group with nothing kept could not be seen at all. PR 16 fixes these and
implements read receipts on read, typing, and the `groups` listing (specs PR 14 and 15).

**2026-11-15, review round (PR 23).** Built to the specs of PRs 20 and 22 after an independent
source review. A mark that was not sent is no longer reported as done: every mark answer has
`marked`, `already_marked`, `failed` and a `reason`, and the CLI exits 1. A send is finished by
the daemon even when the client goes away, and an unknown outcome is `outcome_unknown`. `daemon
install`, `start` and `restart` now wait for a daemon that answers, and `daemon logs` fails on an
unreadable journal. The home view and `accounts` degrade one row at a time. Every list states
`count: N of M`. The daemon refuses loosening settings without `confirm` (`confirm_required`).
`setup hooks` and the project-scoped `session-start` hook are in, with an installable skill. The
README is accurate. Also fixed: `forget` with media it cannot remove, retrying a failed
`typing --stop`, and the exit code of an interrupted `auth link`.

## Follow-ups
