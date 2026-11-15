---
status: planned
depends: []
specs:
  - specs/architecture.md
  - specs/scopes.md
  - specs/identity.md
  - specs/events.md
  - specs/socket-protocol.md
  - specs/security.md
---

# Daemon core: store, scope filter, events, socket

## Scope

The daemon's inside, with no WhatsApp connection: the client interface and its fake, the settings
file, `store.db`, the scope filter, identity resolution, events and the wake file, retention, and
the socket server with the read-only and settings requests. Not in scope: the real client adapter,
linking, sending, service units, packaging.

## Implements

- `architecture.md`: files and modes, one writer, the two databases, the pure-Go driver.
- `scopes.md`: all of it, including the leaves-no-trace test.
- `identity.md`: user, chat and message ids, operators, rekeying.
- `events.md`: all of it.
- `socket-protocol.md`: location, access control, lock, framing, version check, errors, and the
  requests `status`, `settings` (get and patch), `chats`, `chats/{chat}`, `events`, `messages`,
  `forget`.
- `security.md`: rules 1 to 7, 11 and 12 as far as they apply without a connection.
- `daemon.md`: the `run`, `init`, `remove` and `version` subcommands, the start sequence, settings
  validation and atomic writes, logging rules.

## Approach

1. Define the client interface the daemon needs (incoming events, own ids, id mapping lookups,
   contact lookups, and the calls later plans add), and a fake that tests drive.
2. Settings: load, validate strictly, write atomically.
3. `store.db`: schema and migrations for chats, messages, reactions, events, counters, aliases;
   secure deletion on.
4. The scope filter as a pure function, then the keep path (write, event, wake line) and the
   discard path (counter only).
5. Identity: the user object, "is this me", operators, chat keys, rekey.
6. The socket server: directory and file modes, lock, peer check, HTTP over the socket, the
   requests above, streaming follow.
7. Retention and `forget`.

## Validation

- [ ] Every test listed under "Tests" in `scopes.md`, `identity.md` and `events.md` exists and passes
- [ ] The leaves-no-trace test reads every file under the account's directories and every socket response
- [ ] The socket tests in `socket-protocol.md` pass for the requests in scope, including the peer check and the no-TCP check
- [ ] `whatsapp-axid init` then `run` works on a clean machine with no WhatsApp connection, and `curl --unix-socket` gets a `status` in state `unlinked`
- [ ] The daemon refuses to start on loosened file modes and on a held lock
- [ ] `go vet`, `go test -race` and the CGO-disabled build pass in CI

## Risks

- The pure-Go SQLite driver's connection string for foreign keys differs between drivers. Fix it in
  one place and test that both databases open and migrate.
- The client interface is guessed before the real adapter exists. Keep it small; the adapter plan
  may adjust it.

## Notes

## Follow-ups
