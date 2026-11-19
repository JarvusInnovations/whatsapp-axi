---
status: done
pr: 29
depends: [repo-gates]
specs:
  - specs/conventions.md
---

# Toolchain: bun and a formatter

## Scope

The toolchain item of `specs/conventions.md` "Repository": bun for install, scripts and tests,
with the committed lockfile, while the published package stays an ordinary npm package for
Node 22 or later. A formatter (oxfmt) checked in CI.

## Implements

- `conventions.md` "Repository", the toolchain line.

## Approach

1. `asdf set bun 1.4.4`; `bun install` writes `bun.lock`; `package-lock.json` goes.
2. CI installs with `bun install --frozen-lockfile` and runs every script with `bun run`; Node
   stays set up, since the tests and the published CLI run on Node.
3. `oxfmt` with a 160-column width, `format` and `format:check` scripts, a CI step, and one
   commit that formats the tree and changes nothing else.

## Validation

- [x] `bun install`, `bun run build`, `bun run build:daemon` (the version is stamped), `bun run docs:check`, `bun run lint` and `bun run test` pass locally
- [x] `bun run format:check` passes after the formatting commit, which changes no behaviour (the tests pass on it unchanged)
- [x] CI passes on this PR with bun

## Risks

- Runtime code must stay Node-only; nothing here imports a bun API.

## Notes

The tests run under vitest on Node (bun is the script runner), so the Node APIs the published
package uses are what the tests exercise.

## Follow-ups

None.
