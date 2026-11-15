---
status: planned
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

- [ ] Each command in scope has tests for success output, every error code it can meet, and exit codes
- [ ] Unknown flags, missing values and a missing `--account` with several accounts exit 2 with the valid choices
- [ ] With no daemon running, every daemon-backed command names the start command
- [ ] End to end on one machine with the real daemon from `daemon-core`: `account add`, `daemon run`, `scope set`, `operators add`, `events`, all without WhatsApp
- [ ] Lint, type-check, build and tests pass in CI

## Risks

- Output shapes set here become the interface consumers script against. Keep list schemas small.

## Notes

## Follow-ups
