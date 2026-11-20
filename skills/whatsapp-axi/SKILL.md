---
name: whatsapp-axi
description: Read and act on a WhatsApp account through whatsapp-axi, an agent-ergonomic CLI backed by a local per-account daemon. Use when asked to read WhatsApp messages or events, reply, send a message or file, react, mark messages read, show typing, check an account's state, or change what an account keeps (scope, operators, settings). Triggers on "WhatsApp", "whatsapp-axi", "read the group", "reply on WhatsApp", "send it on WhatsApp", "what came in on WhatsApp".
---

# whatsapp-axi

`whatsapp-axi` drives WhatsApp accounts that each run a local daemon as the same user. The CLI
never talks to WhatsApp itself: every command asks the account's daemon over a Unix socket. This
skill carries no live state; run the commands to see it.

Run it as `npx -y whatsapp-axi …` (or `whatsapp-axi …` when it is installed on PATH). Output is
TOON on standard output; `--json-out[=path]` also writes the complete result as JSON to a file.
Exit 0 is success (a no-op included), 1 a failure, 2 a usage error. Every error carries an
`UPPER_SNAKE` `code` and `help` lines that run as printed; switch on the code, never the message.

**This is an unofficial client.** WhatsApp does not offer this kind of access for personal
accounts and can ban numbers that use it. Keep volume low and never message people who did not
expect it.

## How to work with it

- **Start with the home view:** `npx -y whatsapp-axi` lists accounts with state and scope, the
  default account, and whether changes need `--account`.
- **Accounts.** Reads use the pin (`WHATSAPP_AXI_ACCOUNT`), `--account`, the default set by
  `account use`, or the only account. With two or more accounts, a command that changes anything
  needs `--account` (or the pin); an `ACCOUNT_REQUIRED` error lists the full command for each
  account. Every output starts with `account:`.
- **Read forward with events:** `events --after <seq>` returns what was kept after a point; the
  last line states the highest `seq` for the next call. `events --follow` streams. `read <chat>`
  shows a chat's kept messages, oldest first. Every list says `count: N of M`, and a `help` line
  says when `--limit` cut it. Times are shown in the local zone (`tz:`); `--tz` changes it.
- **What is kept is scoped.** By default an account keeps only what is addressed to it in groups
  (`tagged`) and direct messages from operators. A message it did not keep is gone, by design.
- **Marking read is explicit.** `--mark-read` on `events` or `read`, or `mark-read`, sends read
  receipts. A mark that was not sent prints `code: MARK_FAILED` after what was read, and exits 1.
- **Sends are limited and never retried by the daemon.** First contact with a new chat needs
  `--first-contact`. Pass `--id <id>` (16 to 48 characters of 0-9 and A-F) to make a retry safe:
  the same id again answers `action: already_sent` and sends nothing. An `OUTCOME_UNKNOWN` error
  means the message may have gone out: run `read <chat>` first, then the retry it prints.
- **Changes say what happened:** `action:` (`sent`, `set`, `added`, `unchanged`, …), the prior
  value and the command that undoes it.
- **Widening or loosening needs `--confirm`:** `scope set full`, `scope dm-from anyone`,
  `operators add`, `settings set send.first_contact allow`, raising a `send.*` limit or
  `retain_days`, and the destructive commands. Tightening never does.
- **Session-start hook:** `setup hooks` installs a hook for Claude Code, Codex and OpenCode. In a
  project, list the accounts it uses in `.whatsapp-axi.json` at the root
  (`{"accounts": ["example"]}`); the hook prints one row per listed account (state, scope, events
  kept in the last 24 hours) and nothing at all in a project without that file.
- **When something is wrong,** `doctor` checks every account and prints the fix for each failed
  check; `doctor --summary` is one line.

## Command reference

<!-- BEGIN GENERATED: command-reference -->

### Accounts

- `npx -y whatsapp-axi accounts [--fields <list>]` — List accounts with each daemon's state and scope, and which is the default
- `npx -y whatsapp-axi account add <name>` — Create an account's files with default settings (scope tagged). Already existing is a no-op
- `npx -y whatsapp-axi account use <name>` — Set the default account for reads. Changes still need --account once there are several accounts
- `npx -y whatsapp-axi account remove <name> [--confirm <name>]` — Delete an account's config and state. Refuses while its daemon runs. The name must be repeated with --confirm
- `npx -y whatsapp-axi account migrate [<name>]` — Move an account (or every one) from the old layout, directly under the config and state directories, into accounts/. Refuses while its daemon runs
- `npx -y whatsapp-axi auth link [--phone <number>] [--qr] [--json-out[=path]]` — Link the account to WhatsApp: by pairing code for --phone, or by QR code with --qr
- `npx -y whatsapp-axi auth logout [--confirm] [--json-out[=path]]` — Unlink this device from WhatsApp and delete the session (kept messages stay)

### Reading

- `npx -y whatsapp-axi chats [--limit <n>] [--fields <list>] [--json-out[=path]]` — Chats with kept content: id, name, type, effective scope
- `npx -y whatsapp-axi groups [--limit <n>] [--fields <list>] [--json-out[=path]]` — Every group the account is a member of, kept content or not: id, name, effective scope, member count
- `npx -y whatsapp-axi chat view <chat> [--limit <n>] [--fields <list>] [--json-out[=path]]` — One chat, with participants marked me, operator, contact
- `npx -y whatsapp-axi events [--after <seq>] [--limit <n>] [--chat <chat>] [--kind <kind>] [--follow] [--mark-read] [--fields <list>] [--json-out[=path]]` — Events after a seq; the last line states the highest seq returned, for the next call
- `npx -y whatsapp-axi read <chat> [--limit <n>] [--before <id>] [--mark-read] [--fields <list>] [--json-out[=path]]` — Kept messages of a chat, oldest first
- `npx -y whatsapp-axi message view <ref> [--full] [--json-out[=path]]` — One kept message in full, with its reply context and media descriptor

### Acting

- `npx -y whatsapp-axi send <chat> <text> [--reply <ref>] [--mention <user>] [--first-contact] [--id <id>] [--json-out[=path]]` — Send a text to a chat; `-` as the text reads it from standard input. --id makes a retry safe
- `npx -y whatsapp-axi send-file <chat> <path> [--caption <text>] [--as <type>] [--reply <ref>] [--first-contact] [--id <id>] [--json-out[=path]]` — Send a file; the type is picked from its MIME type unless --as forces one. --id makes a retry safe
- `npx -y whatsapp-axi react <ref> [<emoji>] [--remove] [--json-out[=path]]` — React to a kept message, or remove the account's reaction with --remove
- `npx -y whatsapp-axi mark-read [<ref>] [--chat <chat>] [--json-out[=path]]` — Mark one kept message read, or with --chat everything kept in a chat (sends read receipts)
- `npx -y whatsapp-axi typing <chat> [--stop] [--json-out[=path]]` — Show the account as typing in a chat; clears on --stop, on a send to the chat, or after two minutes
- `npx -y whatsapp-axi download <ref> [--json-out[=path]]` — Fetch a kept message's media and print the local path
- `npx -y whatsapp-axi forget <chat> [--message <ref>] [--confirm] [--json-out[=path]]` — Delete kept content for a chat, or for one message with --message

### Settings

- `npx -y whatsapp-axi scope show [--json-out[=path]]` — Account scope, dm_from, and every per-chat override
- `npx -y whatsapp-axi scope set <scope> [--chat <chat>] [--confirm] [--json-out[=path]]` — Set the account scope (full, tagged, dm-only), or with --chat a chat's override (full, tagged, none, default). A change that widens any chat's effective scope needs --confirm
- `npx -y whatsapp-axi scope dm-from <who> [--confirm] [--json-out[=path]]` — Set whose direct messages are kept: operators or anyone. Setting anyone needs --confirm
- `npx -y whatsapp-axi operators list [--json-out[=path]]` — The account's operators
- `npx -y whatsapp-axi operators add <user> [--confirm] [--json-out[=path]]` — Add an operator, by phone number in E.164 form or by hidden id. Needs --confirm: under dm_from operators it widens whose direct messages are kept
- `npx -y whatsapp-axi operators remove <user> [--json-out[=path]]` — Remove an operator
- `npx -y whatsapp-axi settings show [--json-out[=path]]` — All settings
- `npx -y whatsapp-axi settings set <key> <value> [--confirm] [--json-out[=path]]` — Set one of: wake_file, retain_days, presence, read_receipts, send.first_contact, send.per_hour, send.per_minute, send.same_text_chats, send.max_file_mb

### Daemon

- `npx -y whatsapp-axi daemon install [<name>] [--dry-run] [--no-linger-check]` — Install the daemon binary and the account's systemd user service, enable and start it
- `npx -y whatsapp-axi daemon uninstall [<name>] [--confirm]` — Stop and remove the account's service; the account's files are left in place
- `npx -y whatsapp-axi daemon start [<name>]` — Start the account's service
- `npx -y whatsapp-axi daemon stop [<name>]` — Stop the account's service
- `npx -y whatsapp-axi daemon restart [<name>]` — Restart the account's service
- `npx -y whatsapp-axi daemon status [<name>] [--json-out[=path]]` — The service's state and the daemon's state together
- `npx -y whatsapp-axi daemon logs [<name>] [--lines <n>] [--follow]` — The daemon's log from the user journal
- `npx -y whatsapp-axi daemon upgrade [--json-out[=path]]` — Replace the installed daemon binary with this CLI's and restart every installed account, waiting for each to answer
- `npx -y whatsapp-axi daemon run [<name>] [--log-level <level>]` — Run an account's daemon in the foreground, for development and debugging
- `npx -y whatsapp-axi doctor [--summary] [--json-out[=path]]` — Check every account, or one, and name the fix for anything wrong; --summary prints one line
- `npx -y whatsapp-axi update [--check]` — Update the CLI package; the installed daemons keep running the old binary until `daemon upgrade`

### Agents

- `npx -y whatsapp-axi setup hooks [--scope <scope>] [--dir <path>]` — Install or repair the session-start hook for Claude Code, Codex and OpenCode (--scope user|project, default user). The only command that writes a hook
- `npx -y whatsapp-axi setup hooks status [--scope <scope>] [--dir <path>]` — Each agent's hook at a scope (installed, stale, absent or error), and the accounts this project names
- `npx -y whatsapp-axi setup hooks uninstall [--scope <scope>] [--dir <path>]` — Remove the session-start hook at a scope; other hooks are left alone
- `npx -y whatsapp-axi session-start [--dir <path>]` — What the hook runs: one row per account named in the project's .whatsapp-axi.json (state, scope, events kept in the last 24 hours); nothing without the file; writes nothing; always exits 0

<!-- END GENERATED: command-reference -->
