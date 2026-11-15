---
status: planned
depends: [daemon-core]
specs:
  - specs/daemon.md
  - specs/scopes.md
  - specs/identity.md
  - specs/security.md
---

# The WhatsApp client: adapter, states and linking

## Scope

The real implementation of the client interface on the library, the daemon's states, linking by
pairing code and by QR, logout, presence and read receipts, and the `auth` commands. Written and
unit-tested against the fake; the real adapter is exercised only in the pilot.

## Implements

- `daemon.md`: states, linking, unlinking, behaviour while connected.
- `scopes.md`: "Library settings the guarantee depends on", history never downloaded, chat types.
- `identity.md`: resolution of ids through the library's map; contacts.
- `socket-protocol.md`: `link` (streaming) and `logout`.
- `cli.md`: `auth link`, `auth logout`, and the link and state checks in `doctor`.
- `security.md`: rules 7, 8, 10 and 12.

## Approach

1. The adapter: open `session.db`, build the client with the required settings, translate library
   events into the daemon's incoming events (unwrap, classify message, edit, revoke, reaction;
   filter protocol traffic), and expose own ids, the id map and contacts.
2. The state machine, driven by connection events, with the stopped states that neither retry nor
   exit.
3. Linking: connect, wait until pairing is possible, request the code, enforce the phone number,
   stream progress.
4. Presence on connect and mark-read on keep.

## Validation

- [ ] The state and linking tests in `daemon.md` pass against the fake
- [ ] The event translation has tests for captions on each media type, replies, mentions by either id form, edits, revokes, reactions, and protocol traffic being filtered
- [ ] The adapter compiles against the pinned library and sets every setting `scopes.md` requires, asserted in a test
- [ ] `auth link` renders a code and a final result against a fake daemon; a mismatched number is refused
- [ ] No test connects to WhatsApp

## Risks

- What the library puts in a quoted copy, and how a mention looks in a hidden-id group, are not
  established. The translation must tolerate missing fields; the pilot confirms the real shapes.
- Replacing nothing in the library's store keeps this plan small. The guarantee is worded to match.

## Notes

## Follow-ups
