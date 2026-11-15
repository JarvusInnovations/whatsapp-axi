---
status: in-progress
depends: [pilot]
specs:
  - specs/conventions.md
  - specs/principles.md
  - specs/cli.md
  - specs/socket-protocol.md
  - specs/sending.md
  - specs/daemon.md
  - specs/architecture.md
---

# House style: codes, accounts, fail-closed reads, mutations, doctor and hooks

## Scope

Bring the CLI and the daemon into line with `specs/conventions.md` and `specs/principles.md`
(PR 24, and the accounts/ layout of PR 25), from the gap analysis taken at 5e7db8c: every B, S and
N item except release packaging (B6, S24), and except the repository items (single CI smoke
test, scrub gate, PR `edited` trigger) and the toolchain switch, which have their own plans.

## Implements

- `conventions.md`: error codes (both tables, exit codes, one `formatError`), reads fail closed,
  accounts (resolution, pin, default, `account use`, `ACCOUNT_REQUIRED` help, `account:` lines,
  storage under `accounts/`, `account migrate`, `WHATSAPP_AXI_CONFIG_DIR`, the closed environment
  set), output vocabulary (null never printed, local times with `tz:`, `--tz`, hint grammar,
  guessed-flag hints, empty results echo filters, `count: N of M` everywhere), mutations
  (`action:` set, prior value and undo, send `--id` and `already_sent`, the gate inventory with
  `operators add` and raised `retain_days` gated in the daemon, export failures, `daemon upgrade`
  per account), machine output (per-user directory, `overwrote:`, `columns`, the space form),
  home, the hook (24 hours, writes nothing), `setup hooks status` vocabulary and atomic writes,
  `doctor` (`status`, no warning tier, skipped rows, parallel two-second probes, hooks row,
  `--summary`), the `update` shadow, the daemon binary's errors.
- Repository: one command reference (`src/reference.ts`) feeding help, home hints and the skill;
  one module imports the TOON encoder (`src/output/toon.ts`); `main(argv, io)`; `src/flags.ts`;
  `docs` and `docs:check` scripts; the skill directory in `files`.

## Approach

1. Daemon: rename the codes; `WHATSAPP_AXI_CONFIG_DIR` and the `accounts/` level in the one path
   helper; `whatsapp-axid migrate`; send ids with replay; `since` on events; `Loosens` gains
   `retain_days` raised and operators added.
2. CLI: errors, flags and output modules first, then the account resolution in `config.ts`
   applied once in `context.ts`, then each command group, then the dispatcher in `cli.ts`.
3. Tests follow each behaviour; the fake daemon answers lists with a `total` as the real one does,
   and a test opts out to prove a missing total fails closed.

## Validation

- [x] The daemon emits only the `UPPER_SNAKE` codes of the table; Go tests pass with `-race` off and on
- [x] Every CLI code is in the conventions table; an unexpected throw is `INTERNAL_ERROR` with a `doctor` hint and no stack
- [x] Usage-class codes exit 2 (`formatError` unit tests), everything else 1
- [x] Unknown flag sweep on every command; `--json`, `-n`, `--json-out` hints; the space form refused
- [x] Accounts: one account needs no flag; default for reads with `account_source: default`; mutations need `--account` with per-account runnable help; pin, `ACCOUNT_LOCKED`, `ACCOUNT_LOCK_INVALID`
- [x] An unreadable account directory is still an account and counts toward several; an unreadable accounts directory is `CONFIG_INVALID`; home never fails
- [x] The `accounts/` layout, `WHATSAPP_AXI_CONFIG_DIR`, reserved names; old-layout accounts never listed, reported by `doctor` and home, moved by `account migrate` (real binary), which refuses while the daemon holds the lock and is a no-op when in place
- [x] Lists without `total`, marks without their counts, are `UNEXPECTED_RESPONSE`
- [x] Send `--id`: replay answers `already_sent` (daemon and CLI), pending stays `OUTCOME_UNKNOWN` naming the id, failed can be resent; the CLI's retry hint follows the read hint
- [x] `operators add` and raising `retain_days` refused without confirm by the daemon (Go test and the end-to-end test)
- [x] `--json-out`: per-user 0700 directory checked, `overwrote:`, `columns`, export failure after success is `export_error` and exit 1
- [x] `doctor`: `status` ok/fail/skipped, dependent rows skipped, hooks row, `--summary`, `Run` fix lines
- [x] `setup hooks status` installed/stale/absent/error with problems; partly installed; restart note; `WHATSAPP_AXI_DISABLE_HOOKS`
- [x] The hook counts events of the last 24 hours and writes nothing
- [x] `daemon upgrade` waits for each account and lists each result, going on past a failure
- [x] Times in `--tz` with their offset and one `tz:` line; `WHATSAPP_AXI_TIMEOUT_MS` named in `TIMEOUT`
- [x] Only `src/output/toon.ts` imports the encoder (test)
- [x] Leaves-no-trace and marker tests pass; lint, type-check, build, `docs:check` and tests pass

## Risks

- Every output gains `account:` and changes shape for mutations: scripts that parsed TOON break.
  They were never supported (scripts read `--json-out` files), and nothing is released.
- An installed daemon built before this change looks for accounts in the old place. The README's
  upgrade notes give the order: stop, migrate, upgrade.

## Notes

Decisions this plan took where conventions.md left a detail open:

- **Send id form:** 16 to 48 characters of `0-9A-F`, the form WhatsApp clients generate; checked
  by the CLI and the daemon. A pending id replayed is `OUTCOME_UNKNOWN`; a failed one is removed
  and resent; an id used by another message is `VALIDATION_ERROR`.
- **The hook's 24-hour count** uses a new `since` (RFC 3339) query on `GET /v1/events`.
- **`doctor --account <unknown>`** stays a row (`files,fail,no such account`, the rest skipped),
  exit 1, since `doctor` must work when nothing else does.
- **`--account` on commands with no account** (`setup hooks *`, `daemon upgrade`) is accepted by
  the parser and refused by the command with `VALIDATION_ERROR` naming what to do instead.
- **`update` failures** (registry or install) are `UPSTREAM_ERROR`; the conventions table has no
  update code.
- **Absent table cells** print `-`; values that could not be read print `?` or
  `unknown (<CODE>: …)`.

## Follow-ups

- `plans/repo-gates.md`: CI smoke test, scrub gate, PR `edited` trigger.
- `plans/toolchain-bun.md`: bun for install, scripts and tests.
