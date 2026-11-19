# Architecture

whatsapp-axi gives agents and people a command-line interface to WhatsApp accounts. It has two
programs that ship together and one rule that shapes everything else: **an account's daemon decides
what is kept, and nothing that is not kept is ever written or shown.**

## The two programs

| Program | Language | Job |
| --- | --- | --- |
| `whatsapp-axid` (the daemon) | Go, on [whatsmeow](https://github.com/tulir/whatsmeow) | Holds one account's linked-device session, talks to WhatsApp, applies the account's scope, owns every file |
| `whatsapp-axi` (the CLI) | TypeScript, on axi-sdk-js | What agents and people run. Talks only to a local daemon. Prints TOON |

- The CLI never talks to WhatsApp and never opens the daemon's files.
- The daemon binary is the **only writer** of an account's files. The CLI changes settings by
  asking the running daemon, and creates an account by running a one-shot subcommand of the daemon
  binary (see [daemon.md](daemon.md)).
- There is no MCP server, no model call, no message screening and no TCP listener in this project.
  A consumer that wants those builds them on top (see "What is left to consumers").

## One daemon per account

Each account has its own daemon process. Accounts share nothing at runtime:

- **Own session.** The linked-device keys of one account are in that account's files only.
- **Own settings.** Scope, operators and send limits are per account.
- **Own failure.** One account crashing, being logged out or being banned does not affect another.
- **Own Unix user, if wanted.** An account belongs to the Unix user whose home holds its files.
  Two bots on one host run their accounts under their own users, and neither can read the other's.

An **account name** is a local label matching `^[a-z][a-z0-9-]{0,23}$`. It is not a phone number
and never leaves the machine.

## Files

All paths are per Unix user. `<config>` is `$XDG_CONFIG_HOME/whatsapp-axi` (default
`~/.config/whatsapp-axi`), `<state>` is `$XDG_STATE_HOME/whatsapp-axi` (default
`~/.local/state/whatsapp-axi`), `<data>` is `$XDG_DATA_HOME/whatsapp-axi` (default
`~/.local/share/whatsapp-axi`). The same paths are used on macOS.

| Path | Holds | Mode |
| --- | --- | --- |
| `<config>/accounts/<account>/settings.json` | scope, per-chat overrides, operators, limits, wake file path | 0600 |
| `<state>/accounts/<account>/session.db` | the library's session store: keys and encryption state. **This file is the account** | 0600 |
| `<state>/accounts/<account>/store.db` | the daemon's own store: kept messages, the account's own sent messages, chats, counters, the event sequence | 0600 |
| `<state>/accounts/<account>/media/` | media files fetched on request | 0700 dir, 0600 files |
| `<state>/accounts/<account>/daemon.lock` | single-instance lock | 0600 |
| `<config>/config.json` | the default account ([conventions.md](conventions.md)) | 0600 |
| `<runtime>/<account>.sock` | the daemon's socket (see [socket-protocol.md](socket-protocol.md)) | 0600 in a 0700 dir |
| `<data>/bin/whatsapp-axid` | the installed daemon binary that service units run | 0755 |

Every directory above is 0700.

- `session.db` and `store.db` are separate on purpose: content can be wiped without unlinking the
  account, and the session can be removed without touching anything else.
- There is no separate event log file. Events are rows in `store.db`, read through the socket
  (see [events.md](events.md)).
- Both databases are SQLite, opened with a pure-Go driver (no CGO), with foreign keys on, WAL
  journaling and a busy timeout. Foreign keys are required: the library refuses to set up its
  tables without them.

## What is kept

The daemon keeps a message, edit or reaction only when the account's **scope** says so
([scopes.md](scopes.md)). Kept things become rows in `store.db` and events on the socket. Anything
else is dropped in memory.

`store.db` holds only kept content for every scope. For an account with scope `full` that is every
message; for a bot account in `tagged` scope it is a small set. There is no second database that
appears only for some scopes.

## What is left to consumers

whatsapp-axi is a transport with a scope filter. It deliberately does not:

- decide whether a bot should answer, or what it may say
- classify a destination as safe or unsafe, or screen outgoing text
- wake or schedule an agent, beyond appending a line to a wake file when an event is kept

It does expose what a consumer needs to do those things: stable chat and message ids on every
event, whether a sender is an operator, and for any chat the list of who can read it with each
participant marked as operator, contact or neither (`chat view`, [cli.md](cli.md)).

## Unofficial client

The daemon uses WhatsApp's linked-device protocol, the mechanism WhatsApp Web uses. It is not
Meta's Business Platform API. WhatsApp may restrict or ban an account it considers automated. The
send limits in [sending.md](sending.md) exist to keep an account's behaviour modest; they are not
a guarantee.

## Licence

- The source in this repository is MIT.
- A compiled daemon contains a GPL-3.0 library (through whatsmeow), so **daemon binaries are
  distributed under GPL-3.0 terms**, with a notices file and a pointer to the exact source. The
  CLI is a separate program and stays MIT. See [distribution.md](distribution.md).

## Spec map

| Spec | Covers |
| --- | --- |
| [scopes.md](scopes.md) | what the daemon keeps, the tagged-group rules, the discard guarantee |
| [identity.md](identity.md) | account, user, chat and message ids; operators and contacts |
| [events.md](events.md) | the event record, the sequence, the wake file, retention |
| [daemon.md](daemon.md) | daemon states, linking, connection behaviour, supervision, upgrades |
| [socket-protocol.md](socket-protocol.md) | the socket, access control, requests, errors |
| [sending.md](sending.md) | send, reply, react, files, download, and the send limits |
| [cli.md](cli.md) | every CLI command |
| [security.md](security.md) | the rules that must hold, and how each is tested |
| [distribution.md](distribution.md) | how the two programs are built, licensed and shipped |

## Principles

**Inherited** ([principles.md](principles.md)):

- *The daemon decides what is kept*: the daemon is the only writer of an account's files.
- *One Unix user, one trust boundary*: no TCP listener; accounts are per user.
- *A transport, not an agent*: what is left to consumers.
- *Follow the house style, and write down each departure*: the files table is the house layout.

**Local:** none.
