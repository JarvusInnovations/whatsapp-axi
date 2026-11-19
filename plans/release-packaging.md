---
status: in-progress
pr: 31
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

- [x] Every test listed under "Tests" in `distribution.md` exists and passes
- [x] Each platform package contains the binary, the GPL-3.0 text, the notices and the source statement
- [ ] A fresh machine with only Node installs the package and runs the CLI and daemon
- [x] The README's licence section matches the spec

## Risks

- The package names may be taken on the registry. Check before the first publish and amend the
  spec if a name has to change. On 2026-11-15 all five (`whatsapp-axi`, `whatsapp-axi-linux-x64`,
  `-linux-arm64`, `-darwin-arm64`, `-darwin-x64`) answered `npm view` with E404: free.

## Notes

- **Built here (PR 31):** `scripts/build-packages.mjs` (`bun run build:packages`), the template in
  `packaging/platform/`, the targets in `packaging/targets.json`, the licence gate
  `scripts/daemon-licenses.mjs` (`bun run check:licenses`) with its allow-list
  `daemon/licenses-allowed.json`, the CI `packages` job, `publish-npm.yml`, `library-latest.yml`,
  `docs/releasing.md`, and the CLI's missing-binary, `outdated` and `update` hints.
- **The trusted-publisher setting of all five packages names the workflow filename
  `publish-npm.yml`** in repository `JarvusInnovations/whatsapp-axi`. Renaming the file stops
  publishing until all five are reconfigured.
- The main package's manifest in git carries no `optionalDependencies`: `build:packages` writes
  the published manifest (no scripts, no dev dependencies, the four platform packages at its own
  version) into `release/whatsapp-axi/`. Listing them in git would make `bun install` resolve
  packages that do not exist yet and pin the lockfile to a placeholder version.
- `NOTICES` is generated per target (darwin compiles in one module linux does not), lists the Go
  standard library and runtime as well as every module, and carries each component's licence and
  notice files in full. The gate classifies each module's primary licence file; extra files
  (`LICENSE-3RD-PARTY.md` and the like) are copied into `NOTICES` but not classified.
- Daemon builds use `-trimpath -buildvcs=false` so that a build from the tag is reproducible; the
  version and library version are stamped with `-ldflags -X`.
- How each Validation box was verified (2026-11-15):
  - *Tests*: binary lookup and its messages (`test/conventions.test.ts`), platform manifests'
    `os`/`cpu` and no scripts, and the main package's `optionalDependencies` at its own version
    (`test/packaging.test.ts`), the licence check failing on a disallowed licence
    (`test/licenses.test.ts`, by unit and by running the script with a list that lacks GPL-3.0),
    and the cross-compile of all four targets (the CI `packages` job). 202 tests pass locally;
    CI green on PR 31.
  - *Package contents*: `bun run build:packages` locally, then `npm pack --dry-run` in each
    platform directory listed `bin/whatsapp-axid`, `LICENSE` (GPL-3.0), `NOTICES`, `SOURCE.md`,
    `README.md`, `package.json`; `file` showed static linux ELF and darwin Mach-O binaries for
    both architectures; `whatsapp-axid version` printed the stamped versions. CI repeats the
    build and dry runs on every push.
  - *Fresh machine*: **not done, because it needs a real publish.** What was verified instead,
    locally and in CI: the packed `whatsapp-axi` and the runner's platform package, installed from
    local tarballs (at version `0.0.0-ci`, which no registry has) with `npm install -g --prefix`
    into a temp prefix, run `--version`, `doctor` (no accounts), `account add example` (which runs
    the installed daemon) and `daemon install example --dry-run` (which names the installed
    platform package's binary as the copy source), against a temp home. npm skipped the main
    package's unpublished optional dependency and the CLI found the sibling platform package. The
    box stays open until a maintainer installs a published release on a machine with only Node.
  - *README*: its licence section was compared line by line with "Licence" in the spec.
- Not done by this plan (a maintainer's steps, `docs/releasing.md`): the first publish of each of
  the five packages, the trusted-publisher setting for each, confirming `BOT_GITHUB_TOKEN`, and
  the first release.
- This plan `depends: [pilot]`, which is still in progress; the packaging does not change the
  pilot's source-checkout install.

## Follow-ups

- After the first release: install it from the registry on a machine with only Node, check the
  last Validation box and mark this plan done.
- `library-latest.yml` first runs on its schedule; trigger it once by hand after merging to see an
  issue-free run.
