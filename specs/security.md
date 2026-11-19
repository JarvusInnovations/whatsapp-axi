# Security rules

The rules that must hold, each with where it is specified and how it is tested. A change that
breaks one of these is a bug regardless of what else it achieves.

## Threat model

- **In scope:** other Unix users on the same host; other programs run by the same user that have
  no business with WhatsApp; anything on the network; a consumer agent that is fed hostile message
  text; an operator who assumes "tagged" means more than it does.
- **Out of scope:** a process running as the account's own Unix user that sets out to read its
  files, and root. The session file is the account, and the operating system's user boundary is
  what protects it.

## The rules

| # | Rule | Specified in | Tested by |
| --- | --- | --- | --- |
| 1 | No TCP listener exists in any mode | [socket-protocol.md](socket-protocol.md) | listing the process's listening sockets |
| 2 | Only the account's Unix user can connect: 0700 directory, 0600 socket, peer user id checked on every connection | [socket-protocol.md](socket-protocol.md) | mode checks; injected peer id |
| 3 | Every file and directory of an account is owner-only, and the daemon refuses to start otherwise | [architecture.md](architecture.md), [daemon.md](daemon.md) | start with loosened modes |
| 4 | Content of a discarded message is never written, logged or returned | [scopes.md](scopes.md) | the leaves-no-trace test; the live check in the pilot |
| 5 | Message text, captions, file names and quoted copies are never logged | [daemon.md](daemon.md) | a marker test over the log at the most verbose level |
| 6 | Keys never leave the daemon: not in responses, events, errors, logs or CLI output | [events.md](events.md), [sending.md](sending.md) | schema checks on every response type; a marker test |
| 7 | History is never downloaded | [scopes.md](scopes.md) | the fake client records no history download |
| 8 | A link completes only with the phone number the operator named | [daemon.md](daemon.md) | pairing with a different number is refused |
| 9 | Sends respect the limits, for every caller | [sending.md](sending.md) | limit tests at the socket, not the CLI |
| 10 | The daemon neither retries nor exits when WhatsApp has stopped the account | [daemon.md](daemon.md) | state tests |
| 11 | Unknown request fields, settings keys and CLI flags are rejected, never ignored | [socket-protocol.md](socket-protocol.md), [cli.md](cli.md) | per-surface tests |
| 12 | Core dumps are off for the daemon | [scopes.md](scopes.md) | resource limit check at start |

## Message text is untrusted

Kept messages are written by other people and will be read by agents. whatsapp-axi treats them as
data everywhere: it never executes, expands or follows anything in them, never builds a file path
from a file name a sender chose, and never lets message content select an account, a chat or a
command. Defending an agent against what a message *says* is the consumer's job, and the `operator`
mark on each sender is there to help with it.

## Wiping

- `forget` deletes kept content for a chat or a message.
- `auth logout` deletes the session.
- `account remove` deletes everything for the account.

SQLite can leave deleted bytes in a file until it is compacted. `forget` and retention therefore
run with secure deletion on for `store.db`, so removed content is overwritten.

## Public repository

This repository is public. Nothing in it, including tests, fixtures, docs, commit messages and
pull requests, contains a real phone number, a real WhatsApp id, a real person's or
organization's name, or a real host name. Examples use invented ids in reserved ranges.

## Principles

**Inherited** ([principles.md](principles.md)):

- *One Unix user, one trust boundary*.
- *The daemon decides what is kept*.
- *Say exactly what is promised*.

**Local:** none.
