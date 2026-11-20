# Conventions

whatsapp-axi follows the house style its tool family shares (the `jarvus-axi` skill). This
spec records how each of those rules applies here, and the cases where this tool decides
something the house style leaves open. Where another spec in this repository says something
different about output, flags, errors or accounts, this file holds and the other is brought
into line.

## Error codes

Codes are `UPPER_SNAKE`, on the socket and in the CLI alike. There is one vocabulary: the
daemon's code is the CLI's code, and a `--json-out` file carries it unchanged. Agents and
scripts switch on the code, never on the message.

### From the daemon (socket protocol)

| Code | Status | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | malformed body, unknown field, bad value |
| `NOT_FOUND` | 404 | no such chat or message in what the account has kept |
| `AMBIGUOUS` | 409 | a message ref matches more than one chat; `candidates` lists them |
| `NOT_LINKED` | 409 | the request needs a session and there is none |
| `NOT_CONNECTED` | 409 | the request needs a live connection; `state` says what the daemon is in |
| `LINK_IN_PROGRESS` | 409 | a second link attempt while one is running |
| `FIRST_CONTACT` | 409 | a send to a chat with no kept activity, without `first_contact` |
| `CONFIRM_REQUIRED` | 409 | a change that loosens a safeguard, sent without `confirm: true` |
| `RATE_LIMITED` | 429 | a send limit was hit; `retry_after_seconds`, and the limits in force |
| `DUPLICATE_TEXT` | 429 | the same text to too many chats |
| `NOT_DOWNLOADABLE` | 422 | no media, view-once, or expired |
| `UPSTREAM_ERROR` | 502 | WhatsApp refused or failed the operation; a cleaned-up reason |
| `OUTCOME_UNKNOWN` | 504 | a send whose result could not be determined; it may have gone out |
| `INTERNAL_ERROR` | 500 | a bug. No paths, no content |

Inside streams: a link attempt's final line carries `WRONG_NUMBER`, `CLIENT_OUTDATED`,
`LINK_TIMEOUT` or `LINK_CANCELLED`; a follow stream's error line carries `MARK_FAILED`.

### From the CLI

| Code | Exit | Meaning |
| --- | --- | --- |
| `USAGE` | 2 | wrong arity, a missing value |
| `UNKNOWN_FLAG` | 2 | a flag the command does not declare |
| `VALIDATION_ERROR` | 2 | a bad value, a contradiction, an unknown subcommand; also relayed from the daemon |
| `CONFIRM_REQUIRED` | 2 | a gated change without its `--confirm`, refused by the CLI or the daemon |
| `ACCOUNT_REQUIRED` | 2 | several accounts and none named where one must be |
| `ACCOUNT_LOCKED` | 2 | the environment pins another account than the flag names |
| `ACCOUNT_LOCK_INVALID` | 1 | the environment pins an account that does not exist |
| `NO_ACCOUNT` | 1 | the named account does not exist, or there are none |
| `CONFIG_INVALID` | 1 | an account's files exist and cannot be read or parsed |
| `DAEMON_NOT_RUNNING` | 1 | nothing is listening on the account's socket |
| `DAEMON_UNREACHABLE` | 1 | the socket exists and the connection failed |
| `TIMEOUT` | 1 | a read's deadline expired; says how to extend it |
| `UNEXPECTED_RESPONSE` | 1 | the daemon answered with something the CLI cannot use |
| `PROTOCOL_MISMATCH` | 1 | CLI and daemon speak different protocol versions |
| `STREAM_CLOSED` | 1 | a stream ended before its final line |
| `EXPORT_UNWRITABLE` | 1 | a `--json-out` path cannot be opened |
| `LINK_FAILED`, `LINK_INTERRUPTED` | 1 | a link attempt failed, or was interrupted |
| `ACCOUNT_ADD_FAILED`, `ACCOUNT_REMOVE_FAILED` | 1 | the daemon binary could not create or delete the files |
| `DAEMON_RUNNING` | 1 | refused because that account's daemon is running |
| `DAEMON_EXITED` | 1 | a foreground daemon stopped |
| `DAEMON_BINARY_MISSING`, `DAEMON_BINARY_FAILED` | 1 | the daemon binary is not found, or would not run |
| `UNSUPPORTED_PLATFORM` | 1 | no service manager support here; names `daemon run` |
| `NOT_INSTALLED` | 1 | the account is not installed as a service |
| `SERVICE_FAILED`, `SERVICE_NOT_READY` | 1 | the service manager refused, or the daemon did not come up |
| `LINGER_OFF` | 1 | lingering is off; names the command that turns it on |
| `LOGS_FAILED` | 1 | the journal could not be read |
| `UPDATE_FAILED` | 1 | `update` could not install the new version |
| `SETUP_FAILED` | 1 | a hook file could not be written |
| `NO_PROJECT` | 1 | project scope asked for outside any project |
| `INTERNAL_ERROR` | 1 | anything not anticipated |

- The usage-class codes (`USAGE`, `UNKNOWN_FLAG`, `VALIDATION_ERROR`, `CONFIRM_REQUIRED`,
  `ACCOUNT_REQUIRED`, `ACCOUNT_LOCKED`) exit 2. Everything else exits 1.
- One exported `formatError` does the mapping. A throw that is not one of the tool's own errors
  becomes `INTERNAL_ERROR`, "unexpected failure: …", with a `doctor` hint and no stack trace.
  An operating-system error code never becomes the tool's code.
- Both tables are the whole set. A new code is a change to this file.

## Reads fail closed

- A list answer without a numeric `total`, a mark answer without `failed` and
  `already_marked`, and any field the CLI is about to branch on that is missing or of the wrong
  type, is `UNEXPECTED_RESPONSE`. Nothing defaults to zero, false or "all shown".
- **An account whose files cannot be read is still an account.** It appears in every listing as
  `unknown (CONFIG_INVALID: …)`, counts toward "more than one account", and can never be
  skipped so that another account becomes "the only one".
- **An unreadable service directory is an error**, never "not installed".
- **An unreadable hook target is `error`**, never "not installed".
- **A service state that cannot be read is an error.** When the service manager's query fails
  (no user bus, a non-zero exit), `daemon status`, `stop`, `start` and `restart` answer
  `SERVICE_FAILED`. They never print `unknown` with exit 0, and never "already stopped".
  `daemon stop` reports `stopped` only once the unit is seen inactive, waiting the way a start
  waits for ready, and answers `SERVICE_FAILED` if it stays active.
- **A journal that cannot be read is `LOGS_FAILED`.** `-- No entries --` with nothing else on
  stderr is an empty log. Any other stderr line, such as "No journal files were found", or no
  output at all, is `LOGS_FAILED`, never `0 lines`.
- **A foreground daemon that was killed did not stop cleanly.** `daemon run` exits 0 only for
  an interrupt or terminate signal the CLI itself passed on. Any other signal is
  `DAEMON_EXITED`, naming the signal.
- A state file that exists and does not parse is never overwritten.
- Reads have a 30-second deadline, changed with `WHATSAPP_AXI_TIMEOUT_MS`, which the `TIMEOUT`
  error names. Home, the hook and `doctor` probes have two seconds each and run in parallel.

## Accounts

The tool is multi-account. An account is a local label with its own daemon, session and store;
"logging in" is `auth link` and there is no credential to hold.

**Resolution**, highest first: the pin `WHATSAPP_AXI_ACCOUNT`; `--account`; the default set by
`account use <name>` (kept in `<config>/config.json`); the only account, when there is exactly
one. Otherwise `ACCOUNT_REQUIRED`, whose help is one full runnable line per account, carrying
the caller's own arguments.

- **Reads may use the default. Mutations may not.** With two or more accounts, a command that
  changes anything needs the account named by `--account` or by the pin. Each command declares
  whether it is a mutation, and the rule is applied in one place.
- `--account` is a global flag: accepted on every command and named in unknown-flag messages.
  The `daemon` commands and `account remove` also take the name as their positional; giving
  both, differing, is `VALIDATION_ERROR`.
- **The pin is not a default.** A flag naming a different account is `ACCOUNT_LOCKED`; a pin
  naming an account that does not exist is `ACCOUNT_LOCK_INVALID` on every command, with no
  fallback.
- **Every output names the account** it acted on: an `account:` line, and `account_source:`
  (`default` or `env`) when the command line did not show the choice.
- **Hints carry `--account` only when more than one account exists.**
- Commands that act on every account (`doctor` with no account, `daemon upgrade`, the home
  view) say so and list each account's result; they are not subject to the pin, and say when a
  pin is set.
- `auth logout` and `account remove` always take an explicit account once there are several.

**Storage** is the house layout ([architecture.md](architecture.md)): `<config>/config.json`
for the default, and one directory per account at `<config>/accounts/<name>/` and
`<state>/accounts/<name>/`. Settings are under the config root; the session, the store and
media are under the state root, since they are databases and files the daemon owns. The config
root is `WHATSAPP_AXI_CONFIG_DIR` when set. The `accounts/` level means an account's name can
never collide with one of the tool's own files.

**Moving an existing account.** A daemon or CLI that finds an account directory directly under
a root, where it stood before this layout, moves nothing by itself: `doctor` reports it as
`fail` with the one command that moves it, `account migrate`, which stops nothing, refuses
while that account's daemon runs, moves both directories, and prints what it moved.

**Environment variables**, the whole set: `WHATSAPP_AXI_ACCOUNT` (the pin),
`WHATSAPP_AXI_CONFIG_DIR`, `WHATSAPP_AXI_TIMEOUT_MS`, `WHATSAPP_AXI_DAEMON` (the daemon binary
to use), `WHATSAPP_AXI_DISABLE_HOOKS` (tests only: hook installation becomes a no-op), and the
XDG base directories. Each choice one of them makes is echoed in the output it affected. None
enables a capability.

## Output vocabulary

- **Four default columns** at most; `--fields` for more.
- **`count: N of M`** on every list, including `accounts` and `operators list`, with a `help`
  line when a limit cut it.
- **An empty result echoes its filters**: "0 events after seq 412 in <chat> of kind message".
- **`null` is never printed.** An absent value's key is omitted; an unreadable one is
  `unknown (<CODE>: …)`.
- **Times are shown in the local zone** with their offset, and the output names the zone once
  (`tz:`). `--tz <iana>` is a global flag. `--json-out` files keep the daemon's UTC instants.
- **Hints** read ``Run `whatsapp-axi …` to <purpose>`` and run as printed. A hint never names a
  command that would fail: nothing points at an npm install until the package is published.
  The last hint of the home view is the discovery line.
- **A repeat of something already true** says `(no-op)` and exits 0.
- **Failed marks use the error shape**: `error`, `code` (`MARK_FAILED`), `help`, after the data
  that was read.
- **Flags agents guess** get a pointed hint: `--json` names `--json-out`; `-n` names `--limit`;
  `--json-out` on a command that has none names one that does.

### Message and chat ids

Ids are WhatsApp's own and are printed whole. The house style's short fixed-length ids do not
apply: an id has to go back to WhatsApp exactly as it came, and a truncated one is a different
message.

### Streams

`events --follow` prints one TOON block per event as it arrives; `auth link` prints the code or
QR, then one result block. Neither has a deadline of its own: a follow runs until interrupted,
and a link ends with WhatsApp's window.

A follow that loses the daemon ends with `STREAM_CLOSED` (or `DAEMON_UNREACHABLE` when the
connection itself failed), never an internal error, and prints the last `seq` it delivered
with the command that resumes from it.

## Mutations

**Result shape.** Every mutation prints `action:` from this closed set: `sent`,
`already_sent`, `reacted`, `unreacted`, `marked`, `set`, `added`, `removed`, `created`,
`deleted`, `installed`, `uninstalled`, `started`, `stopped`, `restarted`, `upgraded`, `linked`,
`unlinked`, `unchanged`. `unchanged` carries a `reason:`. A setting or scope change also prints
the prior value (`note: was …`) and the exact command that restores it. Values are those the
daemon reports after the change, not the ones sent.

**Send ids.** WhatsApp message ids are chosen by the sender, so a send is replayable:

- `send` and `send-file` take `--id <id>`; without it the daemon chooses one, as before.
- A send whose `--id` is already recorded for that chat answers `action: already_sent` with the
  recorded result and exit 0, and sends nothing.
- `OUTCOME_UNKNOWN` names the id, and its first hint is the full command to retry with that
  `--id`, after the hint to check `read <chat>`.
- A success output notes that running the command again without `--id` sends a second message.

**An export failure never undoes a success.** If the action succeeded and the `--json-out` file
could not then be written, the output is the normal result plus `export_error:`, and the exit
code is 1.

**Several targets.** `daemon upgrade` waits for each account's daemon to answer, and prints
one row per account with what happened, including when a later one fails.

### The gate inventory

| Command | Gate | Why |
| --- | --- | --- |
| `send`, `send-file`, `react`, `typing`, `mark-read`, `download` | none | routine, run unattended; the daemon's first-contact refusal and rate limits are the guard |
| `settings set` of `wake_file`, `retain_days` (lowering), `presence`, `read_receipts` | none | changes the account's own behaviour, widens nothing |
| `settings set retain_days` raised, or to unlimited | `--confirm` | keeps other people's messages longer |
| `settings set send.first_contact allow`; a send limit raised | `--confirm` | loosens a safeguard |
| `scope set` that widens any chat's effective scope; `scope dm-from anyone` | `--confirm` | widens what the account reads |
| `operators add` | `--confirm` | under `dm_from: operators` it widens whose direct messages are kept |
| `operators remove`, any tightening | none | |
| `forget`, `auth logout`, `daemon uninstall` | `--confirm` | destroys kept content, the session, or the service |
| `account remove <name>` | `--confirm <name>` | destroys an account and its data |
| `account add`, `account use`, `daemon install`, `start`, `stop`, `restart`, `upgrade`, `setup hooks`, `setup hooks uninstall` | none | local, reversible, the operator's own machine |

**Widening is judged by effect, not by the value asked for.** The scopes order as
`none` < `dm-only` < `tagged` < `full`. A scope change is gated when any chat's effective scope
(its own override, or the account's scope where it has none) is wider after the change than
before. That covers the account's scope raised at any step (`dm-only` to `tagged` as much as
to `full`), a chat's override raised, and an override removed where the account's scope is
wider than the override was. A hint that undoes a tightening carries `--confirm` when the undo
is gated.

The daemon enforces every `--confirm` that concerns its settings, so no caller can skip one.
There is no prompt and no `--force`.

## Machine output

As in [cli.md](cli.md), plus:

- The automatic directory is per user (`<os-temp-dir>/whatsapp-axi-<uid>/`), and an existing
  one is checked before use: owned by the user, mode 0700, not a symlink.
- An explicit path that already exists is replaced, and the output says `overwrote:` in place
  of `wrote:`.
- A `columns:` line names the top-level fields of the file's records.
- `--json-out <path>` in the space form is always a usage error naming the `=` form.

## Home, hook and doctor

**Home never fails.** It never exits non-zero and never throws, whatever the state of the
files or daemons. A failed read of one account is that account's row:
`unavailable (<CODE>: …)`, with a `doctor` hint. It names the default account, any pin, and
whether writes currently need `--account`.

**The hook** prints, per listed account, name, state, scope and the number of events kept in
the last 24 hours. It reads only and writes nothing. (A count "since last session" would need
a write on every session start.) A hook invocation is the one place unknown arguments are
ignored, since it must never fail a session.

**`setup hooks status`** reports each agent as `installed`, `stale`, `absent` or `error`, with
a `problems` list for anything unreadable. `setup hooks` writes each file atomically, says
`partly installed (see errors)` when some writes failed, and reminds the user to restart the
agent session.

**`doctor`** prints `checks[N]{account,check,status,detail}`.

- `status` is `ok`, `fail` or `skipped`. There is no warning tier: a thing worth acting on is
  `fail` with its fix; a thing worth knowing is `ok` with the detail.
- A check that depends on a failed one is `skipped`, naming what it needs. Nothing is omitted.
- Rows: files; service (a foreground daemon is `ok`, "not a service"); lingering; binary and
  versions (a mismatch is `fail`); daemon answering; link; state; phone activity (`ok` with the
  age, `fail` from twelve days, since WhatsApp unlinks at about fourteen); wake file; hooks
  (`skipped` when absent, `fail` when broken).
- Any `fail` exits 1. `doctor --summary` prints one line.
- `doctor` works when nothing else does: no failure of one probe or one account stops the rest.

**`update`.** The CLI's self-update is replaced by one that updates the package and then says
that each installed daemon still runs the old binary until `daemon upgrade`, and offers it.

## The daemon binary

`whatsapp-axid` is run by the CLI and the service manager, not by agents. Its own subcommands
print plain errors to standard error and exit non-zero. The CLI turns each into one of the
codes above; nothing an agent sees comes from the binary directly.

## Repository

- `specs/principles.md` holds the tool's trade-offs, each with its reason; every spec ends with
  a `## Principles` section naming the ones it rests on.
- One command reference feeds the top-level help, the home hints and the generated skill.
- One module imports the TOON encoder, and `main(argv, io)` takes its clock, working directory,
  environment and output from `io`.
- CI runs a smoke test on the built CLI with no account and no daemon, asserting a `code:` and
  no stack trace; a scrub check for real phone numbers and ids; and re-runs on a pull request's
  `edited` event.
- The publish workflow's gate is the CI workflow itself, run at the release tag. CI builds and
  tests with a version stamped into `package.json`, the release version at a release and a CI
  version otherwise, never the placeholder, so no test can pass only while the two agree.
- Toolchain: the house standard for the family (`bun` for install, scripts and tests, with the
  committed lockfile), while the published package stays an ordinary npm package for Node 22
  or later.

## Principles

**Inherited** ([principles.md](principles.md)):

- *Follow the house style, and write down each departure*: this file is where the departures are
  written down.
- *One vocabulary*: one set of codes for the daemon and the CLI.
- *Unknown is said as unknown*: reads fail closed.
- *Modest by default, loosened on purpose*: the gate inventory.

**Local:** none.
