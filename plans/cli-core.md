---
status: in-progress
depends: [daemon-core]
specs:
  - specs/cli.md
  - specs/socket-protocol.md
---

# CLI core: client, reading and settings commands

## Scope

The CLI's socket client and every command that needs only what `daemon-core` provides: the home
view, `accounts`, `account add|remove`, `daemon run`, `chats`, `chat view`, `events`, `read`,
`message view`, `forget`, `scope`, `operators`, `settings`, and the parts of `doctor` that do not
need a service or a link. Not in scope: `auth`, sending, `daemon install` and friends, the hook
and the skill.

## Implements

- `cli.md`: conventions, choosing the account, the home view, and the commands listed above.
- `socket-protocol.md`: the client side, including the version check and "daemon not running".

## Approach

1. A small client over Node's built-in HTTP with a socket path, with streaming for follow.
2. The account resolution rule and the binary lookup order.
3. One module per command group, each validating its own flags.
4. A fake daemon for tests that serves canned responses and errors over a real Unix socket.

## Validation

- [x] Each command in scope has tests for success output, every error code it can meet, and exit codes
- [x] Unknown flags, missing values and a missing `--account` with several accounts exit 2 with the valid choices
- [x] With no daemon running, every daemon-backed command names the start command
- [x] End to end on one machine with the real daemon from `daemon-core`: `account add`, `daemon run`, `scope set`, `operators add`, `events`, all without WhatsApp
- [ ] Lint, type-check, build and tests pass in CI

## Risks

- Output shapes set here become the interface consumers script against. Keep list schemas small.

## Notes

Built to `specs/cli.md` as amended by PR #5 (four default columns, reads fail closed, mutations
confirmed). Readings taken where the spec left room:

- **Default columns.** `accounts {name,state,scope}` (`--fields phone`), `chats
  {id,name,type,scope}` (`--fields last_kept,discarded,messages,override`), `events
  {seq,kind,chat,detail}` (`--fields t,id,from,kept_by,mentions_me`), `read {id,t,from,text}`
  (`--fields kept_by,mentions_me,reply_to,media,operator`), `chat view` participants
  `{id,name,marks}` with marks `me`/`operator`/`contact` (`--fields lid,pn`), `doctor
  {account,check,result,detail}`.
- **A stopped daemon in `accounts` and the home view** is a state (`stopped`, scope `null`), not
  a failed read: the socket's absence answers the question. Any other failure (an error, an
  unreadable answer, a timeout) fails the command.
- **"The command that starts it"** is `whatsapp-axi daemon run <name>` for now; the service plan
  can point at `daemon start` once it exists.
- **`account remove`** of an account that does not exist is a no-op (exit 0), like the other
  mutations. A refusal because the daemon runs is `code: daemon_running`.
- **`events --follow`** prints one single-row TOON `events[1]{...}` block per event as it arrives,
  and `last_seq` when stopped with Ctrl-C. A stream the daemon closes is `stream_closed`.
- **`events`** ends with `last_seq` as its last line in every case, including an empty result.
- **`settings set`** takes `none` to unset `wake_file` and `default` to reset `retain_days`.
  `scope`, `dm_from`, `chats` and `operators` are refused there with a pointer to their commands.
- **Flags come after the command**; a leading flag is a usage error (`code: usage`, exit 2).
- **CLI-side error codes**, besides the daemon's: `usage` (exit 2), `daemon_not_running`,
  `daemon_unreachable`, `daemon_timeout`, `bad_response`, `protocol_mismatch`, `stream_closed`,
  `no_account`, `daemon_running`, `daemon_binary_missing`, `daemon_binary_failed`,
  `daemon_exited`, `account_add_failed`, `account_remove_failed`.
- **`doctor`** exits 1 when any check fails (warnings do not). It compares the CLI with the running
  daemon; the installed binary, the service, lingering and the link checks belong to later plans.
  `last_phone_activity` is labelled approximate and warns past 12 days.
- **The CLI never opens the daemon's files**: it lists `<config>` for account names and stats
  paths for `doctor`; everything else goes over the socket.

## Follow-ups

- `daemon install|start|stop|...` (service-linux) should change the not-running help to
  `daemon start`, and `doctor` should gain the service, lingering and installed-binary checks.
- `auth link|logout` and the link checks in `doctor` (whatsapp-client).
