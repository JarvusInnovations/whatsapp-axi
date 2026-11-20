---
status: done
pr: 34
depends: [review-v0-1-0]
specs:
  - specs/conventions.md
---

# The publish gate is the CI workflow

## Scope

The `v0.1.1` publish run failed in its gate on two `doctor` tests that pass in CI, so nothing was
published. The test fixture's daemon reported a fixed `0.1.0`, equal to the placeholder in
`package.json`; the gate stamps the tag's version before building, so the CLI said `0.1.1`,
`doctor`'s versions check failed and `doctor` exited 1. `v0.1.0` passed only because its tag
matched the placeholder. `doctor` was right: a daemon on another version is a failed check.

## Implements

- `conventions.md` "Repository": the publish gate is the CI workflow run at the tag, and CI builds
  with a stamped version that is never the placeholder.

## Approach

1. The fixture's `daemon_version` is the CLI's own `VERSION`, so it follows whatever was stamped.
2. `ci.yml` gains a `workflow_call` trigger with a `version` input. Every job that builds stamps
   `package.json` first: the input at a release, `0.0.0-ci` on a push or pull request. The CLI
   job also checks the built CLI reports the stamped version (moved from the gate).
3. `publish-npm.yml` resolves and checks the version from the tag in a small job, then its `gate`
   is `uses: ./.github/workflows/ci.yml` with that version. `publish-npm` still `needs: gate` and
   stays in `publish-npm.yml`, which the trusted-publisher settings name.
4. `docs/releasing.md` says so.

## Validation

- [x] Reproduced locally: stamping `0.1.1` and running the gate's steps fails the same two tests.
- [x] With the fix, the whole gate set (scrub, lint, format, typecheck, build, docs check,
      `--version` equals the stamp, licence gate, `go vet`, `go test`, daemon build, CLI tests)
      passes stamped `0.0.0-ci`, `0.1.1` and `0.1.0`.
- [x] CI on the pull request is green with the `0.0.0-ci` stamp; locally the old fixture fails
      the same two tests under that stamp.

## Risks

- A reusable workflow's jobs show as `gate / <job>` in the publish run; the CI check names on
  pull requests are unchanged.
- The gate now also runs CI's `go test -race` and the packed-tarball install test, so a release
  takes longer. That is the point.

## Notes

- `v0.1.0`'s publish run passed its gate and skipped all five packages, which were published by
  hand first. `v0.1.1` was the first release whose version differed from the placeholder.
- `inputs.version` is empty on push and pull request events, so the workflow-level
  `STAMP_VERSION` falls back to `0.0.0-ci`.
