---
status: planned
depends: [pilot]
specs:
  - specs/distribution.md
---

# Release packaging

## Scope

The platform packages, the licence notices and check, the publish workflow, the scheduled build
against the library's latest version, and the first release.

## Implements

- `distribution.md`: all of it.

## Approach

1. Cross-compile the four targets in CI and assemble each platform package with its notices.
2. The licence check.
3. The publish workflow: platform packages first, then the main package.
4. A maintainer performs the one-time first publish of each of the five packages, then trusted
   publishing is configured.
5. The scheduled job against the latest library.

## Validation

- [ ] Every test listed under "Tests" in `distribution.md` exists and passes
- [ ] Each platform package contains the binary, the GPL-3.0 text, the notices and the source statement
- [ ] A fresh machine with only Node installs the package and runs the CLI and daemon
- [ ] The README's licence section matches the spec

## Risks

- The package names may be taken on the registry. Check before the first publish and amend the
  spec if a name has to change.

## Notes

## Follow-ups
