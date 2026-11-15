# The daemon

`whatsapp-axid` runs one account. This spec covers how it starts, the states it can be in, how an
account is linked, how it behaves while connected, and how it is kept running and upgraded.

## Subcommands of the binary

The CLI is the interface people use; these are what it runs underneath.

| Subcommand | Does |
| --- | --- |
| `whatsapp-axid run --account <name>` | runs the account's daemon in the foreground until signalled |
| `whatsapp-axid init --account <name>` | creates the account's directories and a default `settings.json`, then exits. Fails if the account exists |
| `whatsapp-axid remove --account <name>` | deletes the account's config and state. Refuses while that account's daemon holds the lock |
| `whatsapp-axid version` | prints the daemon version and the library version it was built with |

## Starting

On `run`, in order:

1. Refuse to start if any of the account's files or directories is readable or writable by group
   or others, naming the path and the fix.
2. Take the lock on `daemon.lock`. If another process holds it, exit with "already running".
3. Remove a stale socket, then listen on the socket (see [socket-protocol.md](socket-protocol.md)).
4. Open `store.db` and `session.db`, applying migrations.
5. Enter the state the session implies: `unlinked` if there is no session, otherwise `connecting`.

The daemon stays in the foreground, logs to standard error, and exits cleanly on SIGTERM or SIGINT
after closing the connection and removing the socket.

## States

| State | Meaning | Leaves by |
| --- | --- | --- |
| `unlinked` | no session. The socket works; nothing is connected | linking |
| `linking` | a link attempt is in progress | success, failure or timeout |
| `connecting` | has a session, is connecting or reconnecting | connected, or one of the stopped states |
| `connected` | online | connection loss |
| `logged_out` | WhatsApp ended the session (removed on the phone, the phone unused too long, or the account was banned). The library has deleted the session | linking again |
| `outdated` | WhatsApp rejected the client as too old | upgrading the daemon |
| `suspended` | WhatsApp applied a temporary ban, with an expiry | the expiry, then a restart |

- Every change of state is a `state` event with a `reason`.
- In `logged_out`, `outdated` and `suspended` the daemon **stays running** and does not retry. It
  keeps answering the socket so that `doctor` can say what happened and what to do. It does not
  exit, because a service manager would restart it into the same wall.
- A lost connection in `connected` goes to `connecting`, and the library's reconnect with backoff
  takes it from there.
- `status` reports the state, since when, the reason, the account's own ids, the daemon and library
  versions, and `last_phone_activity`: the time of the most recent traffic from the account's own
  phone. The library has no real "phone last seen", so this value is an approximation and is
  labelled as one wherever it is shown.

## Linking

Linking makes the daemon a linked device of an existing WhatsApp account. The account's daemon
must be running in `unlinked` or `logged_out`.

### By pairing code (the default)

1. The operator runs `auth link` with the account's phone number.
2. The daemon connects, waits until WhatsApp is ready to pair, and asks for a code for that number.
3. The CLI prints the eight-character code. The operator opens WhatsApp on the phone, goes to
   Linked devices, chooses to link with a phone number, and types the code.
4. The daemon reports success or failure. The whole attempt is bounded by WhatsApp's login window
   of a little under three minutes.

- **The number must match.** The daemon refuses to complete a pairing with any account other than
  the phone number given to `auth link`.
- The daemon presents itself to WhatsApp under a conventional browser-and-OS name; WhatsApp
  rejects other shapes.

### By QR code

`auth link --qr` streams QR payloads instead; the CLI renders each as a terminal QR code and also
prints the raw string. Each code is short-lived and replaced by the next until the window closes.

### Unlinking

`auth logout` tells WhatsApp to remove this linked device, then deletes the session. It does not
delete `store.db`.

## Behaviour while connected

| Behaviour | Rule |
| --- | --- |
| Presence | The daemon announces the account as available once after each connect, so that its name displays properly to others. Setting `presence: false` turns this off |
| Delivery receipts | Sent automatically by the library for every message received, kept or not. With presence on they are ordinary delivery receipts |
| Read receipts | Sent when the consumer says it has read a message, never before (see "Receipts and typing" below). A discarded message is never marked read |
| Typing indicators | Never sent on the daemon's own initiative; a consumer can ask for one |
| History | Never downloaded ([scopes.md](scopes.md)) |
| Identity changes of peers | Accepted automatically, as the library does by default |

## Receipts and typing

What other people see on their phones should match what the account's user has actually done. A
person, or a bot, has not read a message just because a daemon stored it.

| Signal | Sent when |
| --- | --- |
| Delivered (two grey ticks) | the daemon received the message. Automatic, for every message |
| Read (blue ticks) | the consumer marks the message read |
| Typing | the consumer says it is composing a reply |

**Marking read.** With `read_receipts: on-read` (the default), a kept incoming message is marked
read on WhatsApp only when a consumer marks it, in one of two ways:

- by asking for it while reading: `events` and `messages` requests take a `mark_read` option, and
  every incoming message returned by that request is marked
- explicitly, for one message or for everything in a chat up to a message

The daemon records that a message has been marked, so marking is idempotent and each message
produces at most one read receipt. Reading without `mark_read` (a person debugging, a health
check) marks nothing. The other values are `on-keep`, which marks a message the moment it is kept,
and `off`, which never sends a read receipt and makes marking a no-op.

**Typing.** A consumer can turn the typing indicator on for a chat while it works on a reply. The
daemon turns it off when the account sends a message to that chat, when asked, or after two
minutes, whichever comes first, so an indicator can never be left stuck on.

## Settings

`settings.json` holds, per account:

| Key | Default | Meaning |
| --- | --- | --- |
| `scope` | `tagged` | account scope ([scopes.md](scopes.md)) |
| `dm_from` | `operators` | whose direct messages are kept |
| `chats` | `{}` | per-chat scope overrides, by chat id |
| `operators` | `[]` | phone numbers or hidden ids ([identity.md](identity.md)) |
| `parent_buffer` | `true` | hold recent discarded group messages in memory so a mentioned parent is kept whole ([scopes.md](scopes.md)) |
| `wake_file` | unset | path to append wake lines to ([events.md](events.md)) |
| `retain_days` | 90, or 0 for `full` | retention of kept content |
| `presence` | `true` | announce availability on connect |
| `read_receipts` | `on-read` | `on-read`, `on-keep` or `off` |
| `send` | see [sending.md](sending.md) | send limits |

- The daemon validates the file on start and refuses to run with an unknown key or a bad value,
  naming it.
- While running, the daemon is the only writer. Changes arrive over the socket, are validated,
  written atomically (write a temporary file, then rename) and take effect at once.
- A person may edit the file while the daemon is stopped.

## Keeping it running

### Linux

One systemd **user** service per account, from a template unit `whatsapp-axi@.service`, started as
`whatsapp-axi@<account>.service`.

- The unit runs the installed binary at `<data>/bin/whatsapp-axid` with `run --account %i`. It
  never points into a package manager's directory, which can move when Node or the package is
  upgraded.
- `Restart=on-failure` with a short delay. The stopped states do not exit, so they do not restart.
- **Lingering is required.** Without it, a user service stops when the user's last login session
  ends, and the runtime directory holding the socket disappears. `daemon install` checks lingering
  and, when it is off, refuses and prints the one command that turns it on. `--no-linger-check`
  overrides the refusal for desktops where the user is always logged in.
- Logs go to the user journal.

### macOS

One LaunchAgent per account, generated by the CLI, labelled per account, with `KeepAlive` on
failure and logs written to a file under the account's state directory. It runs after the user
logs in to the desktop. A Mac that nobody logs in to graphically is out of scope.

The first releases implement Linux. The macOS agent is specified here so that the layout is fixed,
and is built later.

### Installing and upgrading the binary

- `daemon install` copies the daemon binary that came with the CLI to `<data>/bin/whatsapp-axid`,
  writes the unit, and enables and starts the service.
- `daemon upgrade` copies the current binary over the installed one and restarts every installed
  account's service for that user.
- The CLI and the daemon each report a version. `doctor` compares the CLI, the installed binary and
  the running daemon, and says which step fixes a mismatch.
- `outdated` is fixed only by a release built on a newer library. `doctor` says so, and names the
  upgrade commands.

## Logging

- Standard error, one line per record, with a level.
- Message text, captions, file names and quoted copies are never logged at any level.
- At the default level, ids of discarded messages and their senders are not logged either.
- Keys and session material are never logged.

## Tests

The WhatsApp client sits behind an interface. Tests drive the daemon with a fake that emits events
and records calls; no test connects to WhatsApp.

- Start refuses on loose file permissions and on a held lock; a stale socket is replaced.
- Each state transition, including that the stopped states neither retry nor exit.
- Linking: the code is streamed, success ends in `connected`, a pairing with a different number is
  refused, the window timing out returns to `unlinked`.
- Under `on-read`, keeping a message sends no read receipt; a request with `mark_read`, and an
  explicit mark, each send exactly one, and a second mark sends none. Under `on-keep` the receipt
  is sent on keep. Under `off` none is ever sent.
- Typing is cleared by a send to that chat, by a stop request, and by the two-minute limit.
- Settings: unknown keys rejected; a change over the socket is durable and atomic.
- `daemon install --dry-run` prints the unit and the binary path without changing anything.
