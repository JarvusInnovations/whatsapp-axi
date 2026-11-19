# The socket protocol

The CLI talks to an account's daemon over a Unix domain socket. There is no TCP listener, on any
interface, in any mode.

## Where the socket is

`<runtime>/<account>.sock`, where `<runtime>` is the first of these that applies:

1. `$XDG_RUNTIME_DIR/whatsapp-axi`, when `XDG_RUNTIME_DIR` is set
2. `/run/user/<uid>/whatsapp-axi`, when `/run/user/<uid>` exists, is owned by the user and is 0700
3. `<state>/run` (see [architecture.md](architecture.md)); this is what macOS uses

The CLI and the daemon use the same rule, so they find each other without configuration. Account
names are at most 24 characters, which keeps the path inside the operating systems' socket path
limits; the daemon fails with a clear error if the resolved path is still too long.

## Access control

Three checks, all required:

1. The socket's directory is 0700 and owned by the user. The daemon creates it that way and
   refuses to use one that is not.
2. The socket file is 0600. It is created inside the 0700 directory, so there is no moment when
   another user could connect.
3. On every connection the daemon reads the peer's user id from the kernel and closes the
   connection unless it equals the daemon's own.

Being able to connect is the whole of authentication: one Unix user, one trust boundary.

## Single instance and stale sockets

The daemon holds an exclusive lock on `daemon.lock` for its lifetime. Holding the lock is what
entitles it to remove an existing socket file and bind a new one. The kernel releases the lock if
the daemon dies, so a crash never needs manual cleanup.

## Framing

HTTP/1.1 over the socket, with JSON bodies.

- Every path starts with `/v1/`.
- Request and response bodies are JSON objects, UTF-8.
- Streaming responses are newline-delimited JSON: one object per line, sent as it happens.
- One request per connection is enough; the daemon also accepts keep-alive.

This was chosen because both sides have it built in, a streaming response is natural, and a person
can debug it with `curl --unix-socket`.

## Version check

`GET /v1/status` includes `protocol` (a whole number, currently 1), `daemon_version` and
`library_version`. The CLI sends its own version in a `User-Agent` header. When the CLI meets a
protocol number it does not support, it stops with an error that names both versions and the
upgrade command.

## Requests

| Method and path | Does |
| --- | --- |
| `GET /v1/status` | state, since, reason, own ids, versions, `last_phone_activity`, counts |
| `POST /v1/link` | starts linking; body `{phone}` or `{qr: true}`. **Streams** `{code}` or `{qr}` lines, then one final `{result}` line |
| `POST /v1/logout` | unlinks the device and deletes the session |
| `GET /v1/settings` | the current settings |
| `PATCH /v1/settings` | changes settings; the body is a partial settings object, validated as a whole before anything is written |
| `GET /v1/chats` | chats with kept content, with name, type, effective scope, last kept time and discard count |
| `GET /v1/groups` | every group the account is a member of, asked of WhatsApp at request time: id, name, effective scope, member count, discard count. `NOT_CONNECTED` when offline |
| `GET /v1/chats/{chat}` | one chat: the above plus its participants as user objects, each with `operator` and `contact` |
| `GET /v1/events?after=&since=&limit=&chat=&kind=&follow=&mark_read=` | events after a `seq`; `since` (RFC 3339) keeps those kept at or after an instant, and `total` counts them. With `follow=1`, **streams**. With `mark_read=1`, marks the returned incoming messages read |
| `GET /v1/messages?chat=&before=&limit=&mark_read=` | kept messages of a chat, newest last. `mark_read=1` as above |
| `POST /v1/mark-read` | marks read; body `{chat, id}` for one message or `{chat, through}` for every kept incoming message up to and including that id |
| `POST /v1/typing` | body `{chat, on}`; turns the typing indicator on or off for a chat |
| `GET /v1/messages/{chat}/{id}` | one kept message |
| `POST /v1/send` | sends text; body `{chat, text, id?, reply_to?, mentions?, first_contact?}`. An `id` already sent to that chat answers the recorded result with `already_sent: true` and sends nothing ([sending.md](sending.md)) |
| `POST /v1/send-file` | sends a file; body `{chat, path, id?, caption?, as?, reply_to?, first_contact?}`, with `id` as for a send |
| `POST /v1/react` | reacts; body `{chat, id, emoji}`. An empty emoji removes the reaction |
| `POST /v1/download` | fetches a kept message's media; body `{chat, id}`. Responds with the local path |
| `POST /v1/forget` | deletes kept content; body `{chat}` or `{chat, id}` |

`{chat}` in a path or body accepts every form listed in [identity.md](identity.md), URL-encoded in
paths. File paths in request bodies are read and written by the daemon, which runs as the same
user as the CLI.

## Errors

A failed request has a 4xx or 5xx status and this body:

```json
{ "error": { "code": "NOT_CONNECTED", "message": "The account is not connected to WhatsApp.", "state": "logged_out" } }
```

The codes are those of [conventions.md](conventions.md) ("From the daemon"), which holds the
whole set:

| `code` | Status | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | malformed body, unknown field, bad value. `message` names it |
| `NOT_FOUND` | 404 | no such chat or message in what the account has kept |
| `AMBIGUOUS` | 409 | a message ref matches more than one chat; `candidates` lists them |
| `NOT_LINKED` | 409 | the request needs a session and there is none |
| `NOT_CONNECTED` | 409 | the request needs a live connection; `state` says what the daemon is in |
| `LINK_IN_PROGRESS` | 409 | a second link attempt while one is running |
| `FIRST_CONTACT` | 409 | a send to a chat with no kept activity, without `first_contact` ([sending.md](sending.md)) |
| `CONFIRM_REQUIRED` | 409 | a settings change that loosens a safeguard, sent without `confirm: true` ([conventions.md](conventions.md), "The gate inventory") |
| `RATE_LIMITED` | 429 | a send limit was hit; `retry_after_seconds` says when |
| `DUPLICATE_TEXT` | 429 | the same text to too many chats ([sending.md](sending.md)) |
| `NOT_DOWNLOADABLE` | 422 | the message has no media, is view-once, or its media has expired |
| `UPSTREAM_ERROR` | 502 | WhatsApp refused or failed the operation; `message` carries a cleaned-up reason |
| `OUTCOME_UNKNOWN` | 504 | a send whose result the daemon could not determine; the message may have gone out; `id` names it ([sending.md](sending.md)) |
| `INTERNAL_ERROR` | 500 | a bug. The body carries no file paths and no content |

Inside streams: a link attempt's final line carries `WRONG_NUMBER`, `CLIENT_OUTDATED`,
`LINK_TIMEOUT` or `LINK_CANCELLED` (or `UPSTREAM_ERROR`); a follow stream's error line carries
`MARK_FAILED` with the mark counts.

- Codes are stable. A new failure gets a new code; an existing code does not change meaning.
- An unknown field in a request body is `VALIDATION_ERROR`. Nothing is silently ignored.
- Error bodies never contain message content or key material.

## When the daemon is not running

The CLI finds no socket, or nothing accepting on it. It does not start a daemon, and it does not
read the databases itself. It reports that the account's daemon is not running and prints the
command that starts it. This holds for every command that needs the daemon, read-only ones
included.

## Tests

- A connection from a different user id is closed before any request is read. (Tested by
  injecting the peer-credential lookup.)
- The socket directory and file have the required modes; a directory with looser modes is refused.
- A second daemon for the same account exits with "already running"; a daemon started after a
  crash replaces the stale socket.
- Every request in the table: one success case, and each error code it can return.
- Unknown request fields are rejected.
- A follow stream and a link stream each deliver lines as they happen and end cleanly when the
  client disconnects.
- No TCP listener exists: a test lists the process's listening sockets and finds only the Unix one.

## Principles

**Inherited** ([principles.md](principles.md)):

- *One Unix user, one trust boundary*: the socket's modes and the peer check are the whole of
  authentication.
- *One vocabulary*: the codes and field names here are the CLI's, unchanged in `--json-out`.
- *Unknown is said as unknown*: `OUTCOME_UNKNOWN`, never a plain failure, for a send that may
  have gone out.
- *Modest by default, loosened on purpose*: the daemon itself refuses a loosening change without
  `confirm: true`.

**Local:** none.
