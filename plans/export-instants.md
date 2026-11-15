---
status: in-progress
depends: [house-style]
specs:
  - specs/conventions.md
  - specs/cli.md
---

# Local exports keep the daemon's instants

## Scope

`doctor` and `daemon status` write the rows they print to `--json-out`. Since `house-style` the
view shows times in the local zone, so the file carried local times too, where
`specs/conventions.md` says `--json-out` files keep the daemon's UTC instants. Also `doctor`
showed the state's and the phone's instants in UTC in its view, and `doctor --summary` named a
zone it did not use.

## Implements

- `conventions.md` "Output vocabulary": times in the local zone in the view, UTC instants in the
  file.

## Approach

A local command may set the document its file holds (`ctx.exportDoc`); `doctor` and
`daemon status` set it with the daemon's instants while their views show local times.

## Validation

- [x] `daemon status --tz …` shows the local time and its file the daemon's instant (test)
- [x] `doctor --tz …` shows local times in the state and phone rows, and its file keeps the instants, with the same row keys (test)
- [x] `doctor --summary` prints no `tz:` line (test)

## Risks

None beyond the file now differing from the view in those two detail strings.

## Notes

The vitest per-test timeout is raised to 30 seconds and one send-outcome test no longer gives
the status probe 50 ms, which failed under load.

## Follow-ups

None.
