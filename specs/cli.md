# The CLI

`whatsapp-axi` is what agents and people run. It follows the AXI conventions throughout.

## Conventions

- **Output** is TOON on standard output. A list prints at most four columns by default;
  `--fields` adds more.
- **A failed read is an error, never an empty result.** If the daemon cannot be reached, answers
  with an error, or returns something the CLI cannot parse, the command fails with exit 1. It
  never prints an empty list, a zero or a success in that case. A mutation reports success only
  after the daemon confirmed it.
- **Errors** are structured, on standard output, with a `help` line naming the command that fixes
  the problem. Daemon error codes ([socket-protocol.md](socket-protocol.md)) are passed through as
  `code`.
- **Exit codes:** 0 success, including a no-op; 1 an error; 2 a usage error.
- **Unknown flags and arguments are rejected** by name, with the command's valid flags listed.
- **No prompts.** Everything is done with flags. A missing required value is a usage error.
- **`--help`** on every command; `-v`, `-V` and `--version` print the bare version quickly without
  loading the rest of the program.
- **Empty results say so** in words: "0 events after seq 412", not blank output.
- **Long text is truncated** in detail views with the total length shown and `--full` to get all
  of it.
- Message text is data from other people. The CLI prints it as data and never interprets it.

## Choosing the account

Every command that acts on an account takes `--account <name>`.

- With exactly one account for the user, `--account` may be omitted.
- With more than one, it is required, and its absence is a usage error that lists the accounts.

## Home view

`whatsapp-axi` with no arguments prints the path of the executable, a one-line description, and
the user's accounts with each one's state and scope, then a few suggested next commands. With no
accounts it says so and suggests `account add`.

## Commands

### Accounts and linking

| Command | Does |
| --- | --- |
| `accounts` | lists accounts: name, state, scope. `--fields` adds the account's own phone number |
| `account add <name>` | creates the account's files with default settings (scope `tagged`). Already existing is a no-op |
| `account remove <name> --confirm <name>` | deletes the account's config and state. Refuses while its daemon runs. The name must be repeated |
| `auth link --phone <number>` | links by pairing code: prints the code and where to type it, waits, reports the result |
| `auth link --qr` | links by QR code |
| `auth logout --confirm` | unlinks the device and deletes the session |

### The daemon

| Command | Does |
| --- | --- |
| `daemon install <name>` | installs the binary and the service, enables and starts it. `--dry-run` prints what it would do. `--no-linger-check` skips the lingering refusal |
| `daemon uninstall <name> --confirm` | stops and removes the service. Leaves the account's files |
| `daemon start <name>`, `daemon stop <name>`, `daemon restart <name>` | control the service |
| `daemon status <name>` | service state and daemon state together |
| `daemon logs <name> [--lines N] [--follow]` | the daemon's log |
| `daemon upgrade` | replaces the installed binary and restarts the user's installed accounts |
| `daemon run <name>` | runs the daemon in the foreground, for development and debugging |
| `doctor [--account <name>]` | checks every account, or one |

### `doctor`

Reports, per account, with a fix command for anything wrong:

- files present, with correct ownership and modes
- service installed, enabled and running; lingering on
- the daemon answers on the socket; protocol and versions of CLI, installed binary and running
  daemon agree
- link state, and for `logged_out`, `outdated` and `suspended` what happened and what to do
- `last_phone_activity`, labelled approximate, with a warning as it nears two weeks, since WhatsApp
  logs out linked devices whose phone has been away about that long
- the wake file, when configured, is writable

### Reading

| Command | Does |
| --- | --- |
| `chats` | chats with kept content: id, name, type, effective scope. `--fields` adds last kept time and discard count |
| `chat view <chat>` | one chat, with participants marked `me`, `operator`, `contact` |
| `events [--after <seq>] [--limit N] [--chat <chat>] [--kind <kind>] [--follow] [--mark-read]` | events after a point. `--mark-read` sends read receipts for the incoming messages returned. The last line of output states the highest `seq` returned, for the next call |
| `read <chat> [--limit N] [--before <id>] [--mark-read]` | kept messages of a chat, oldest first |
| `message view <ref>` | one kept message in full, with its reply context and media descriptor |

`events` without `--after` returns the most recent events up to the limit, and says so.

### Acting

| Command | Does |
| --- | --- |
| `send <chat> <text>` | sends text. `-` reads the text from standard input. `--reply <ref>`, `--mention <user>` (repeatable), `--first-contact` |
| `send-file <chat> <path>` | sends a file. `--caption`, `--as <type>` (image, video, audio or document), `--reply <ref>`, `--first-contact` |
| `mark-read <ref>` | marks one message read. `mark-read --chat <chat>` marks everything kept in the chat |
| `typing <chat>` | shows the account as typing in a chat. `--stop` clears it; it also clears by itself |
| `react <ref> <emoji>` | reacts. `--remove` removes the account's reaction |
| `download <ref>` | fetches a kept message's media and prints the local path |
| `forget <chat> [--message <ref>] --confirm` | deletes kept content for a chat or one message |

### Settings

| Command | Does |
| --- | --- |
| `scope show` | account scope, `dm_from`, and every per-chat override |
| `scope set <scope>` (`full`, `tagged` or `dm-only`) | sets the account scope. Setting `full` needs `--confirm` |
| `scope set --chat <chat> <scope>` (`full`, `tagged`, `none` or `default`) | sets or clears a chat's override. Setting `full` needs `--confirm` |
| `scope dm-from <who>` (`operators` or `anyone`) | sets whose direct messages are kept |
| `operators list`, `operators add <user>`, `operators remove <user>` | manage operators |
| `settings show` | all settings |
| `settings set <key> <value>` | sets `wake_file`, `retain_days`, `presence`, `read_receipts` or a `send.*` limit |

Mutations are idempotent: setting a value it already has, adding an operator already present, or
reacting with the same emoji again succeeds as a no-op and says so.

## Agent integrations

- `hook install`, `hook uninstall` and `hook status` manage a session-start hook for supported agent harnesses.
  The hook prints a short home view, nothing from any message. Accounts belong to a user, not a
  directory, so the hook is scoped by configuration: a project lists the accounts it uses in a
  `.whatsapp-axi.json` file at its root, and the hook prints only those. In a directory with no
  such file the hook prints nothing.
- The repository ships an installable skill generated from the CLI's own command reference.

Both are built after the core commands and are not needed for the pilot.

## Tests

- Each command against a fake daemon speaking the socket protocol: the success output, each error
  code it can meet rendered as a structured error with a `help` line, and the exit code.
- Unknown flags, missing required values and a missing `--account` with several accounts are all
  exit 2 with the valid choices listed.
- With the daemon down, every daemon-backed command reports "not running" with the start command.
- The version flags answer without loading the command graph.
- No command prints key material, and `chat view`, `events`, `read` and `message view` print only
  what the daemon returned.
