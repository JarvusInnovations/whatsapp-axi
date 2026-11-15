---
status: in-progress
depends: [cli-core]
specs:
  - specs/daemon.md
  - specs/cli.md
---

# Running as a service on Linux

## Scope

`daemon install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs` and `upgrade` on Linux
with systemd user services, and the service checks in `doctor`. macOS is a later plan.

## Implements

- `daemon.md`: "Keeping it running" for Linux; installing and upgrading the binary.
- `cli.md`: the daemon commands and the service part of `doctor`.

## Approach

1. Copy the binary to its stable path; write the template unit once per user.
2. The lingering check, with the refusal and the override.
3. Thin wrappers over the service manager for the control commands and logs.
4. `--dry-run` for install, used by tests.

## Validation

- [x] `daemon install --dry-run` prints the unit and paths and changes nothing
- [x] The unit runs the binary from the stable path, never from a package directory
- [x] Install refuses without lingering and names the command; the override works
- [ ] On a real Linux host: install, a reboot, and the daemon is back in its previous state without a login
- [ ] `daemon upgrade` replaces the binary and restarts installed accounts; `doctor` then reports matching versions

## Risks

- Reaching the user service manager from a shell without a login session needs the runtime
  directory variable set. The CLI sets it for its own calls when it is missing and the directory
  exists.

## Notes

Validated locally with `npm run lint`, `typecheck`, `build`, `test` (`test/service.test.ts`), and by
hand: `daemon install <name> --dry-run` from the built CLI in a throwaway XDG tree printed the unit
and paths, and a file listing before and after showed no change. No unit was installed or started
on the build machine and lingering was not changed; every test runs against a fake service manager.

Two boxes stay open, so this plan is `in-progress`:

- **Reboot on a real host** needs a real install and a reboot; it belongs to the pilot.
- **`daemon upgrade`** is verified against the fake service manager with stand-in binaries
  (the binary is replaced atomically, each installed account gets `systemctl --user restart`, and
  `doctor` then reports the installed binary, the CLI and the running daemon at one version). A
  restart by real systemd has not been seen; confirm it in the pilot and check the box then.

Readings taken where a spec left room:

- **Service manager interface** (`src/service.ts`): `supported`, `user`, `lingering`, `systemctl`,
  `show`, `logs`. `Ctx` carries it; `setServiceFactory` swaps in the fake. Unit and binary files
  are written by the CLI directly; enablement is `systemctl --user enable`, whose links under
  `default.target.wants/` are how the CLI lists installed accounts (for `upgrade`, `status`,
  `doctor`).
- **The template unit** lives at `$XDG_CONFIG_HOME/systemd/user/whatsapp-axi@.service`, runs
  `"<data>/bin/whatsapp-axid" run --account %i`, `Restart=on-failure`, `RestartSec=5`,
  `WantedBy=default.target`, and pins `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_DATA_HOME` to the
  values the installing CLI resolved, so the service finds the same files. `XDG_RUNTIME_DIR` comes
  from the user manager, which gives the socket path the CLI computes.
- **Binary placement.** `<data>/bin` is created 0700 (architecture.md: every directory 0700) and the
  binary 0755, copied to a temporary name and renamed, so a running daemon is not disturbed. An
  identical binary is not copied again.
- **Lingering** is read from `/var/lib/systemd/linger/<user>`, else `loginctl show-user`. When it
  cannot be confirmed, install refuses as if it were off. The fix named is
  `loginctl enable-linger <user>` (some systems need sudo).
- **Install** refuses with `daemon_running` while a foreground daemon answers on the socket and the
  service is not active (the service would only restart into "already running"). Installing again
  is a no-op when nothing changed and the service runs; a changed binary restarts a running service.
- **Uninstall** disables and stops the instance; the template unit is removed with the last
  instance. The binary and the account's files stay.
- **start/stop/restart** need an installed service (`not_installed`, naming `daemon install`);
  starting a running service and stopping a stopped one are no-ops.
- **status** prints the unit's state (installed, enabled, active, sub-state, since, pid) and the
  daemon's state from the socket, or "not running".
- **logs** reads `journalctl --user -u whatsapp-axi@<name>.service -o short-iso`, default 50 lines
  (max 10000), printed as rows; `--follow` prints each new line until Ctrl-C. A journal that cannot
  be read is `logs_failed`.
- **upgrade** with nothing installed is a no-op; with the binary already current it restarts
  nothing.
- **doctor** (Linux only): `service` (ok when active; fail when installed but not active, fix
  `daemon start`; warn when not installed, fix `daemon install`), `linger` (fail when off and the
  service is installed, warn otherwise), `binary` (installed version against the CLI, fix
  `daemon upgrade`; against the running daemon, fix `daemon restart`). The `suspended` fix now names
  `daemon restart`.
- **Not-running help** names `whatsapp-axi daemon start <name>`, with `daemon install` for an
  account that is not a service; `account add` points at `daemon install`.
- **Platforms.** On anything but Linux the service commands fail with `unsupported_platform` and
  point at `daemon run`; doctor skips the service checks.
- **Running from a shell without a login session**, the CLI sets `XDG_RUNTIME_DIR=/run/user/<uid>`
  for its `systemctl`/`journalctl`/`loginctl` calls when it is unset and the directory exists.

## Follow-ups

- Pilot: install on the pilot host, reboot, confirm the daemon is back without a login; run
  `daemon upgrade` against the real service and check both open boxes here, then mark this plan
  done.
- macOS LaunchAgent: a later plan.
