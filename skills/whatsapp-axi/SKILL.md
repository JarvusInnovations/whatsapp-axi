---
name: whatsapp-axi
description: Read and act on a WhatsApp account through whatsapp-axi, an agent-ergonomic CLI backed by a local per-account daemon. Use when asked to read WhatsApp messages or events, reply, send a message or file, react, mark messages read, show typing, check an account's state, or change what an account keeps (scope, operators, settings). Triggers on "WhatsApp", "whatsapp-axi", "read the group", "reply on WhatsApp", "send it on WhatsApp", "what came in on WhatsApp".
---

# whatsapp-axi

`whatsapp-axi` drives WhatsApp accounts that each run a local daemon as the same user. The CLI
never talks to WhatsApp itself: every command asks the account's daemon over a Unix socket. This
skill carries no live state; run the commands to see it.

Run it as `npx -y whatsapp-axi …` (or `whatsapp-axi …` when it is installed on PATH). Output is
TOON on standard output; `--json-out[=path]` also writes the daemon's full response as JSON to a
file. Exit 0 is success, 1 a failure, 2 a usage error; every error carries a `code` and `help`
lines with the command that fixes it.

**This is an unofficial client.** WhatsApp does not offer this kind of access for personal
accounts and can ban numbers that use it. Keep volume low and never message people who did not
expect it.

## How to work with it

- **Start with the home view:** `npx -y whatsapp-axi` lists accounts with state and scope. Pass
  `--account <name>` on every command when there is more than one account.
- **Read forward with events:** `events --after <seq>` returns what was kept after a point; the
  last line states the highest `seq` for the next call. `events --follow` streams. `read <chat>`
  shows a chat's kept messages, oldest first. Every list says `count: N of M`, and a `help` line
  says when `--limit` cut it.
- **What is kept is scoped.** By default an account keeps only what is addressed to it in groups
  (`tagged`) and direct messages from operators. A message it did not keep is gone, by design.
- **Marking read is explicit.** `--mark-read` on `events` or `read`, or `mark-read`, sends read
  receipts. A mark that was not sent (for example `read_receipts` is `off`) exits 1 and says why.
- **Sends are limited and never retried.** First contact with a new chat needs `--first-contact`.
  An `outcome_unknown` error means the message may have gone out: run `read <chat>` before
  sending again.
- **Widening or loosening needs `--confirm`:** `scope set full`, `scope dm-from anyone`,
  `settings set send.first_contact allow`, raising a `send.*` limit, and the destructive
  commands. Tightening never does.
- **Session-start hook:** `setup hooks` installs a hook for Claude Code, Codex and OpenCode. In a
  project, list the accounts it uses in `.whatsapp-axi.json` at the root
  (`{"accounts": ["example"]}`); the hook prints one row per listed account (state, scope, events
  kept since the last session) and nothing at all in a project without that file.

## Command reference

<!-- BEGIN GENERATED: command-reference -->

- `npx -y whatsapp-axi account add <name>` — Create an account's files with default settings (scope tagged). Already existing is a no-op
- `npx -y whatsapp-axi account remove <name> [--confirm <name>]` — Delete an account's config and state. Refuses while its daemon runs. The name must be repeated with --confirm
- `npx -y whatsapp-axi accounts [--fields <list>]` — List accounts with each daemon's state and scope
- `npx -y whatsapp-axi auth link [--phone <number>] [--qr]` — Link the account to WhatsApp: by pairing code for --phone, or by QR code with --qr
- `npx -y whatsapp-axi auth logout [--confirm]` — Unlink this device from WhatsApp and delete the session (kept messages stay)
- `npx -y whatsapp-axi chat view <chat> [--fields <list>]` — One chat, with participants marked me, operator, contact
- `npx -y whatsapp-axi chats [--limit <n>] [--fields <list>]` — Chats with kept content: id, name, type, effective scope
- `npx -y whatsapp-axi daemon install <name> [--dry-run] [--no-linger-check]` — Install the daemon binary and the account's systemd user service, enable and start it
- `npx -y whatsapp-axi daemon logs <name> [--lines <n>] [--follow]` — The daemon's log from the user journal
- `npx -y whatsapp-axi daemon restart <name>` — Restart the account's service
- `npx -y whatsapp-axi daemon run <name> [--log-level <level>]` — Run an account's daemon in the foreground, for development and debugging
- `npx -y whatsapp-axi daemon start <name>` — Start the account's service
- `npx -y whatsapp-axi daemon status <name>` — The service's state and the daemon's state together
- `npx -y whatsapp-axi daemon stop <name>` — Stop the account's service
- `npx -y whatsapp-axi daemon uninstall <name> [--confirm]` — Stop and remove the account's service; the account's files are left in place
- `npx -y whatsapp-axi daemon upgrade` — Replace the installed daemon binary with this CLI's and restart the user's installed accounts
- `npx -y whatsapp-axi doctor` — Check every account, or one, and name the fix for anything wrong
- `npx -y whatsapp-axi download <ref>` — Fetch a kept message's media and print the local path
- `npx -y whatsapp-axi events [--after <seq>] [--limit <n>] [--chat <chat>] [--kind <kind>] [--follow] [--mark-read] [--fields <list>]` — Events after a seq; the last line states the highest seq returned, for the next call
- `npx -y whatsapp-axi forget <chat> [--message <ref>] [--confirm]` — Delete kept content for a chat, or for one message with --message
- `npx -y whatsapp-axi groups [--limit <n>] [--fields <list>]` — Every group the account is a member of, kept content or not: id, name, effective scope, member count
- `npx -y whatsapp-axi mark-read [<ref>] [--chat <chat>]` — Mark one kept message read, or with --chat everything kept in a chat (sends read receipts)
- `npx -y whatsapp-axi message view <ref> [--full]` — One kept message in full, with its reply context and media descriptor
- `npx -y whatsapp-axi operators add <user>` — Add an operator, by phone number in E.164 form or by hidden id
- `npx -y whatsapp-axi operators list` — The account's operators
- `npx -y whatsapp-axi operators remove <user>` — Remove an operator
- `npx -y whatsapp-axi react <ref> [<emoji>] [--remove]` — React to a kept message, or remove the account's reaction with --remove
- `npx -y whatsapp-axi read <chat> [--limit <n>] [--before <id>] [--mark-read] [--fields <list>]` — Kept messages of a chat, oldest first
- `npx -y whatsapp-axi scope dm-from <who> [--confirm]` — Set whose direct messages are kept: operators or anyone. Setting anyone needs --confirm
- `npx -y whatsapp-axi scope set <scope> [--chat <chat>] [--confirm]` — Set the account scope (full, tagged, dm-only), or with --chat a chat's override (full, tagged, none, default). Setting full needs --confirm
- `npx -y whatsapp-axi scope show` — Account scope, dm_from, and every per-chat override
- `npx -y whatsapp-axi send <chat> <text> [--reply <ref>] [--mention <user>] [--first-contact]` — Send a text to a chat; `-` as the text reads it from standard input
- `npx -y whatsapp-axi send-file <chat> <path> [--caption <text>] [--as <type>] [--reply <ref>] [--first-contact]` — Send a file; the type is picked from its MIME type unless --as forces one
- `npx -y whatsapp-axi session-start [--dir <path>]` — What the hook runs: one row per account named in the project's .whatsapp-axi.json (state, scope, events kept since the last run); nothing without the file; always exits 0
- `npx -y whatsapp-axi settings set <key> <value> [--confirm]` — Set one of: wake_file, retain_days, presence, read_receipts, send.first_contact, send.per_hour, send.per_minute, send.same_text_chats, send.max_file_mb
- `npx -y whatsapp-axi settings show` — All settings
- `npx -y whatsapp-axi setup hooks [--scope <scope>] [--dir <path>]` — Install or repair the session-start hook for Claude Code, Codex and OpenCode (--scope user|project, default user). The only command that writes a hook
- `npx -y whatsapp-axi setup hooks status [--scope <scope>] [--dir <path>]` — What is installed, for each agent, at a scope; and the accounts this project names
- `npx -y whatsapp-axi setup hooks uninstall [--scope <scope>] [--dir <path>]` — Remove the session-start hook at a scope; other hooks are left alone
- `npx -y whatsapp-axi typing <chat> [--stop]` — Show the account as typing in a chat; clears on --stop, on a send to the chat, or after two minutes

<!-- END GENERATED: command-reference -->
