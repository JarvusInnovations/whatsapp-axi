---
status: done
pr: 8
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
4. The scope filter as a pure function, then the keep path (write, event, wake line), the
   discard path (counter, and the in-memory recent-message buffer), and keeping the parent of a
   mentioning reply.
5. Identity: the user object, "is this me", operators, chat keys, rekey.
6. The socket server: directory and file modes, lock, peer check, HTTP over the socket, the
   requests above, streaming follow.
7. Retention and `forget`.

## Validation

- [x] Every test listed under "Tests" in `scopes.md`, `identity.md` and `events.md` exists and passes
- [x] The leaves-no-trace test reads every file under the account's directories and every socket response
- [x] The socket tests in `socket-protocol.md` pass for the requests in scope, including the peer check and the no-TCP check
- [x] `whatsapp-axid init` then `run` works on a clean machine with no WhatsApp connection, and `curl --unix-socket` gets a `status` in state `unlinked`
- [x] The daemon refuses to start on loosened file modes and on a held lock
- [x] `go vet`, `go test -race` and the CGO-disabled build pass in CI

## Risks

- The pure-Go SQLite driver's connection string for foreign keys differs between drivers. Fix it in
  one place and test that both databases open and migrate.
- The client interface is guessed before the real adapter exists. Keep it small; the adapter plan
  may adjust it.

## Notes

Readings taken where a spec left room (narrowest reading, recorded so the next builder sees it):

- **Client interface.** `internal/client.Client`: `Start(ctx, Handler)`, `Close`, `State`,
  `OwnIDs`, `LIDForPN`/`PNForLID` (read the library's map, never the network), `RequestMapping`
  (async), `Contact`, `GroupInfo` (`ErrNotConnected` when offline), `MarkRead`. Events are
  `*client.Message` (kinds message, edit, revoke, reaction, encrypted), `StateChange` and
  `PhoneActivity`. The adapter is expected to drop protocol traffic and history before anything
  reaches the daemon, put a caption in `Media.Caption`, and pass media key material as opaque
  `Media.Keys`. There is no history-download call at all, so rule 7 holds by construction.
  `run` uses `client/offline` until the adapter exists: `unlinked` with no session, `connecting`
  (reason "this build has no WhatsApp client yet") if a session somehow exists.
- **`kept_by` outside tagged groups.** The account's own message is `own` in every scope; other
  kept messages are `full` (full scope or override) or `dm` (direct chat under `dm_from`).
- **Rule 3 targets.** A reply is kept only when its target was kept by `mention`, `reply` or
  `own`. A target kept as `full` (for example before a scope change) does not start a thread.
- **Counters.** Discarded edits, revokes and reactions count as discards. A direct chat's id is the
  sender, so a direct chat with nothing kept has no counter of its own: those discards share the
  account counter `*direct` (as unsupported chat types share `*unsupported`). A direct chat that has
  kept content counts per chat.
- **Recent-message buffer.** Only discarded messages of groups under `tagged` enter it. A discarded
  edit of a buffered message updates the buffered copy; a revoke removes it. The whole buffer is
  cleared when `scope`, `chats` or `parent_buffer` change. A partial parent whose time is unknown
  takes the time of the reply that brought it in.
- **Wake lines.** None for any event whose actor is the account (own message, own edit, own
  reaction, own revoke), not only own `message` events.
- **Bare message refs on the socket.** `GET /v1/messages/{id}` (one path segment) and
  `POST /v1/forget {id}` take a bare id; an ambiguous one is `409 ambiguous` with `candidates`.
- **Message objects** carry `t` (message time), and in responses also `edited`, `deleted` and
  `reactions`; events carry `partial` per events.md.
- **`chat view` of a group** needs the participant list from WhatsApp: offline it is
  `409 not_connected` rather than a partial list. A direct chat's participants are computed locally.
- **Settings.** `PATCH` is a JSON merge patch (null restores a default). `GET` returns every key
  (null when unset) plus `effective_retain_days`; `PATCH` adds `changed`. Chat keys in `chats` may
  be given in any chat form and are stored canonically. `wake_file` must be absolute.
- **Events.** Without `after`, the most recent `limit` events (default 100, max 1000); `follow`
  without `after` starts at the current end. Unknown query parameters are `bad_request`, as are
  unknown paths and the requests of later plans (`link`, `logout`, `send`, `send-file`, `react`,
  `download`) until those plans add them.
- **State events.** A `state` event is written when the state differs from the last one recorded
  in `store.db`, so a restart in the same state writes none.
- **Revoke** also erases the content from the message's earlier `message`/`edit` event payloads.
  `forget`, `revoke` and retention checkpoint the WAL (`TRUNCATE`) after deleting, so secure-deleted
  content does not linger in `store.db-wal`.
- **Retention** removes messages older than the cutoff, their events and reactions and media
  files, and chats left with no messages; `state` events are not removed.
- **Socket path length.** A resolved socket path over the platform limit is refused with the
  path and its length.

## Follow-ups

- `whatsapp-client`: implement `client.Client` on whatsmeow, reusing `internal/session` (which
  already opens and migrates `session.db` through `internal/sqlite`), and replace
  `client/offline` in `runner.Run` via `Options.NewClient`.
