---
status: planned
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

- [ ] `daemon install --dry-run` prints the unit and paths and changes nothing
- [ ] The unit runs the binary from the stable path, never from a package directory
- [ ] Install refuses without lingering and names the command; the override works
- [ ] On a real Linux host: install, a reboot, and the daemon is back in its previous state without a login
- [ ] `daemon upgrade` replaces the binary and restarts installed accounts; `doctor` then reports matching versions

## Risks

- Reaching the user service manager from a shell without a login session needs the runtime
  directory variable set. The CLI sets it for its own calls when it is missing and the directory
  exists.

## Notes

## Follow-ups
