# The CLI

`whatsapp-axi` is what agents and people run. It follows the AXI conventions throughout.

## Conventions

[conventions.md](conventions.md) holds the house style as it applies here (error codes, accounts,
output vocabulary, mutations, machine output, home, hook and `doctor`); where this file and that
one disagree, that one holds.

- **Output** is TOON on standard output. A list prints at most four columns by default;
  `--fields` adds more. `null` is never printed.
- **A failed read is an error, never an empty result.** If the daemon cannot be reached, answers
  with an error, or returns something the CLI cannot parse, the command fails with exit 1. It
  never prints an empty list, a zero or a success in that case. A mutation reports success only
  after the daemon confirmed it.
- **`--json-out[=path]`**, for scripts. Standard output is always the TOON view; there is no
  JSON mode on standard output. A command that calls the daemon accepts `--json-out`, which
  also writes the daemon's complete response body, unchanged and uncapped, to a file:
  - With `=path` the file is written there. The path is given only with `=`; `--json-out`
    followed by any argument that is not a flag is a usage error that says to write
    `--json-out=<that>`. A path that already holds a file is replaced, and the output says
    `overwrote:` in place of `wrote:`.
  - Bare, the file is created exclusively in `<os-temp-dir>/whatsapp-axi-<uid>/`, named by time
    and command; that directory is checked before use (owned by the user, mode 0700, not a
    symlink).
  - Either way the file is created owner-only (`0600`), never through a symlink, and it is opened
    before the daemon is called, so a path that cannot be written fails the command
    (`EXPORT_UNWRITABLE`) before anything is sent.
  - A streaming command (`events --follow`, `auth link`) appends one JSON object per line as
    each arrives.
  - When the daemon answers with an error, the file receives `{"error": {…}}` exactly as the
    daemon sent it, standard output carries the usual structured error, and the exit code is
    unchanged. A script reads the outcome from the file and the exit code, never from TOON.
  - When a file is written, standard output adds a `wrote: <path> (<what it holds>)` line, a
    `columns` line naming the top-level fields of its records, and a `help` entry with a
    ready-to-run `jq` example against that path. Nothing else about the TOON view changes.
  - If the command succeeded and the file could not then be written, the output is the normal
    result plus `export_error:`, and the exit code is 1.
  - Field names in the file are the socket protocol's, and change only with its version. Times
    in the file are the daemon's UTC instants.
  - Commands that do not call the daemon take no `--json-out`, except `doctor`, `daemon status`
    and `daemon upgrade`, which write the same rows they print. On any other command the flag
    is refused with a pointer to the commands that take it.
- **Errors** are structured, on standard output, with an `UPPER_SNAKE` `code` and `help` lines
  that run as printed. The codes are the closed set in [conventions.md](conventions.md); daemon
  codes ([socket-protocol.md](socket-protocol.md)) are passed through unchanged.
- **Exit codes:** 0 success, including a no-op; 2 the usage-class codes (`USAGE`,
  `UNKNOWN_FLAG`, `VALIDATION_ERROR`, `CONFIRM_REQUIRED`, `ACCOUNT_REQUIRED`, `ACCOUNT_LOCKED`);
  1 everything else.
- **Unknown flags and arguments are rejected** by name, with the command's valid flags listed.
  `--json`, `-n` and `--json-out` on a command without it get a pointed hint.
- **Global flags:** `--account <name>`, `--tz <iana>` and `--help` are accepted on every command.
- **Times** are shown in the local zone (or `--tz`) with their offset, and the output names the
  zone once (`tz:`).
- **No prompts.** Everything is done with flags. A missing required value is a usage error.
- **`--help`** on every command; `-v`, `-V` and `--version` print the bare version quickly without
  loading the rest of the program.
- **Empty results say so** in words, echoing their filters: "0 events after seq 412", not blank
  output.
- **Long text is truncated** in detail views with the total length shown and `--full` to get all
  of it.
- Message text is data from other people. The CLI prints it as data and never interprets it.

## Choosing the account

As in [conventions.md](conventions.md) ("Accounts"): the pin `WHATSAPP_AXI_ACCOUNT`, then
`--account` (or the account positional of the `daemon` commands), then the default set by
`account use`, then the only account.

- With exactly one account for the user, `--account` may be omitted.
- With more than one, reads may use the default; a command that changes anything needs
  `--account` or the pin, and its absence is `ACCOUNT_REQUIRED` with one runnable line per
  account.
- Every output names the account it acted on (`account:`, and `account_source:` when the default
  or the pin chose it).

## Home view

`whatsapp-axi` with no arguments prints the path of the executable, a one-line description, the
default account and any pin, whether writes need `--account`, and the user's accounts with each
one's state and scope, then a few suggested next commands ending with the discovery line. With
no accounts it says so and suggests `account add`; accounts still in the old layout are named
with `account migrate`.

## Commands

### Accounts and linking

| Command | Does |
| --- | --- |
| `accounts` | lists accounts: name, state, scope, with `count: N of M` and the default. `--fields` adds the account's own phone number |
| `account add <name>` | creates the account's files with default settings (scope `tagged`). Already existing is a no-op. The names `accounts` and `config.json` are refused |
| `account use <name>` | sets the default account for reads (kept in `<config>/config.json`) |
| `account remove <name> --confirm <name>` | deletes the account's config and state. Refuses while its daemon runs. The name must be repeated |
| `account migrate [<name>]` | moves an account (or every one) from the old layout, directly under the config and state roots, into `accounts/`. Refuses while that account's daemon runs; a no-op when already in place |
| `auth link --phone <number>` | links by pairing code: prints the code and where to type it, waits, reports the result |
| `auth link --qr` | links by QR code |
| `auth logout --confirm` | unlinks the device and deletes the session |

### The daemon

| Command | Does |
| --- | --- |
| `daemon install [<name>]` | installs the binary and the service, enables and starts it. `--dry-run` prints what it would do. `--no-linger-check` skips the lingering refusal |
| `daemon uninstall [<name>] --confirm` | stops and removes the service. Leaves the account's files |
| `daemon start [<name>]`, `daemon stop [<name>]`, `daemon restart [<name>]` | control the service |
| `daemon status [<name>]` | service state and daemon state together |
| `daemon logs [<name>] [--lines N] [--follow]` | the daemon's log |
| `daemon upgrade` | replaces the installed binary, restarts every installed account and waits for each to answer, one row per account |
| `daemon run [<name>]` | runs the daemon in the foreground, for development and debugging |
| `doctor [--account <name>] [--summary]` | checks every account, or one; `--summary` prints one line |
| `update [--check]` | updates the CLI package, then names `daemon upgrade` for the installed daemons, which still run the old binary |

The `daemon` commands take the account as their positional or by `--account`; giving both,
differing, is `VALIDATION_ERROR`.

### `doctor`

Prints `checks[N]{account,check,status,detail}` with `status` `ok`, `fail` or `skipped`, as in
[conventions.md](conventions.md), and a `help` line `` Run `<fix>` to fix <check> of <account> ``
for each failed check that has a command. Per account:

- files present, with correct ownership and modes; an account still in the old layout is `fail`
  with `account migrate`
- service installed and running (a foreground daemon that answers is `ok`, "not a service");
  lingering on
- the installed binary and the running daemon against the CLI's version (a mismatch is `fail`)
- the daemon answers on the socket
- link state, and for `logged_out`, `outdated` and `suspended` what happened and what to do
- `last_phone_activity`, labelled approximate, `fail` from twelve days, since WhatsApp logs out
  linked devices whose phone has been away about fourteen
- the wake file, when configured, is writable
- and once, the user-scope hooks (`skipped` when absent)

### Reading

| Command | Does |
| --- | --- |
| `chats [--limit N]` | chats with kept content: id, name, type, effective scope. `--fields` adds last kept time and discard count |
| `groups` | every group the account is a member of, kept content or not: id, name, effective scope, member count. Needs a live connection |
| `chat view <chat>` | one chat, with participants marked `me`, `operator`, `contact` |
| `events [--after <seq>] [--limit N] [--chat <chat>] [--kind <kind>] [--follow] [--mark-read]` | events after a point. `--mark-read` sends read receipts for the incoming messages returned. The last line of output states the highest `seq` returned, for the next call |
| `read <chat> [--limit N] [--before <id>] [--mark-read]` | kept messages of a chat, oldest first |

Every list states its size against the whole: `count: N of M`, and when N is less than M a
`help` line with the flag that shows more. `chats`, `groups`, `read` and `events` all take
`--limit` and all say when the limit cut the list. A list is never silently partial.

| Command | Does |
| --- | --- |
| `message view <ref>` | one kept message in full, with its reply context and media descriptor |

`events` without `--after` returns the most recent events up to the limit, and says so.

### Acting

| Command | Does |
| --- | --- |
| `send <chat> <text>` | sends text. `-` reads the text from standard input. `--reply <ref>`, `--mention <user>` (repeatable), `--first-contact`, `--id <id>` |
| `send-file <chat> <path>` | sends a file. `--caption`, `--as <type>` (image, video, audio or document), `--reply <ref>`, `--first-contact`, `--id <id>` |
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
| `scope dm-from <who>` (`operators` or `anyone`) | sets whose direct messages are kept. Setting `anyone` needs `--confirm` |
| `operators list`, `operators add <user> --confirm`, `operators remove <user>` | manage operators. Adding needs `--confirm` |
| `settings show` | all settings |
| `settings set <key> <value>` | sets `wake_file`, `retain_days`, `presence`, `read_receipts` or a `send.*` limit. Loosening needs `--confirm`: `send.first_contact allow`, raising `send.per_hour`, `send.per_minute`, `send.same_text_chats` or `send.max_file_mb` above its current value, or raising `retain_days` (or making it unlimited) |

**What needs `--confirm`, and what does not** is the gate inventory in
[conventions.md](conventions.md). A change that widens what the account reads or keeps, or
loosens a safeguard, needs `--confirm`: scope `full`, `dm-from anyone`, `operators add`, the send
settings and `retain_days` above, and the destructive commands. The daemon enforces it too
(`CONFIRM_REQUIRED`), so no caller can skip it. Tightening never needs it. `send`, `send-file`,
`react`, `typing` and `mark-read` do not take `--confirm`: they are what the tool is for, a bot
runs them unattended, and the daemon's first-contact refusal and rate limits are their guard.

Every mutation prints `action:` from the closed set in [conventions.md](conventions.md), and a
setting or scope change also prints the prior value and the command that restores it. A send
prints its id; `--id` makes a retry safe (`action: already_sent`).

Mutations are idempotent: setting a value it already has, adding an operator already present, or
reacting with the same emoji again succeeds as a no-op and says so.

## Agent integrations

- **`setup hooks`** installs or repairs a session-start hook for Claude Code, Codex and
  OpenCode. It is the only code path that writes a hook, it is idempotent, and it repairs a
  hook whose executable path has moved. `setup hooks status` reports what is installed and
  `setup hooks uninstall` removes it. This is the shape the family's reference tools use.
  - `--scope user|project` chooses where the hook lives (default `user`). For `project`, the
    target is `--dir <path>` when given, else the git root of the working directory, else an
    error; never the bare working directory.
  - Each file is written atomically. Any error from writing a hook is a failure (exit 1,
    `SETUP_FAILED`, `partly installed (see errors)` when some writes succeeded), and status is
    read again after an install and printed, so "installed" is what was verified. A successful
    install reminds the user to restart the agent session.
  - `setup hooks status` reports each agent as `installed`, `stale`, `absent` or `error`, with a
    `problems` list for anything unreadable.
  - `WHATSAPP_AXI_DISABLE_HOOKS` (tests only) makes every hook write a no-op that says so.
- **The hook is scoped to the project.** Accounts belong to a user, not a directory, so a
  project names the accounts it uses in `.whatsapp-axi.json` at its root
  (`{"accounts": ["example"]}`). The hook prints those accounts and nothing else, and in a
  directory with no such file, at any scope, it prints nothing at all.
- **What it prints** is one row per listed account: name, state, scope, and the count of events
  kept in the last 24 hours. It reads only and writes nothing. Never message text, a sender, a
  chat name or a phone number.
- **It can never hang or fail a session.** Each account is asked with a two-second limit, and
  an account that does not answer in time, or errors, is its own row, `unavailable (<CODE>: …)`.
  The hook always exits 0, and is the one place unknown arguments are ignored.
- **The home view and `accounts` degrade the same way:** one row per account, a short limit
  each, and a daemon that hangs or errors is a row `unavailable (<CODE>: …)`, an account whose
  files cannot be read `unknown (CONFIG_INVALID: …)`, never a failed command. Their hint for an
  account that is not running names `daemon start` when it is installed as a service and
  `daemon install` when it is not; any unavailable row adds the `doctor` hint.
- **An installable skill** ships in the repository, generated from the CLI's own command
  reference and checked in CI for staleness. It carries no live state.

## Tests

- Each command against a fake daemon speaking the socket protocol: the success output, each error
  code it can meet rendered as a structured error with a `help` line, and the exit code.
- Unknown flags, missing required values, bad values and a missing `--account` for a change with
  several accounts are all exit 2 with the valid choices listed.
- With the daemon down, every daemon-backed command reports "not running" with the start command.
- The version flags answer without loading the command graph.
- No command prints key material, and `chat view`, `events`, `read` and `message view` print only
  what the daemon returned.

## Principles

**Inherited** ([principles.md](principles.md)):

- *Follow the house style, and write down each departure*: flags, errors, output, accounts,
  home, hooks and `doctor` follow [conventions.md](conventions.md).
- *One vocabulary*: codes and field names are the daemon's; scripts read `--json-out` files.
- *Unknown is said as unknown*: a failed read is an error, an unreadable account a row that
  says so, a send that may have gone out `OUTCOME_UNKNOWN`.
- *Modest by default, loosened on purpose*: widening and loosening take `--confirm`.
- *What others see is true*: read receipts and typing only on request.

**Local:** none.
