# Releasing

whatsapp-axi ships as five npm packages that share one version
([`specs/distribution.md`](../specs/distribution.md)):

| Package | Contents | Licence |
| --- | --- | --- |
| `whatsapp-axi` | the CLI; lists the four below as optional dependencies | MIT |
| `whatsapp-axi-linux-x64`, `whatsapp-axi-linux-arm64`, `whatsapp-axi-darwin-arm64`, `whatsapp-axi-darwin-x64` | one prebuilt `whatsapp-axid`, the GPL-3.0 text, `NOTICES`, `SOURCE.md` | GPL-3.0-only |

Releases use the house develop→main Release-PR flow: pushing `develop` opens a `Release: vX.Y.Z`
PR into `main`, and **merging that PR publishes**.

## Workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push / PR to `main` or `develop` | Daemon and CLI checks; the `packages` job runs the licence gate, cross-compiles the four daemons, assembles and packs the five packages, and installs the packed CLI and platform package from local tarballs to run them |
| `release-prepare.yml` | push to `develop` | Opens or refreshes the `Release: vX.Y.Z` PR and its bot `## Changelog` comment |
| `release-validate.yml` | PR to `main` | Title format and tag collision |
| `release-publish.yml` | Release PR merged | Tags `main`'s merge commit `vX.Y.Z` and creates the GitHub release (uses the org secret `BOT_GITHUB_TOKEN`) |
| `publish-npm.yml` | GitHub release published | `gate`: version from the tag, the full CI gate at the tag. `publish-npm`: `bun run build:packages`, then the four platform packages, then `whatsapp-axi`, with trusted publishing (OIDC, no token) and provenance; `-rc.N` goes under the `next` dist-tag; a version already on the registry is skipped with a warning; a missing platform package stops the run before the main package |
| `library-latest.yml` | weekly, or by hand | Builds and tests against the latest whatsmeow; opens or comments on an issue when that fails |

**The trusted-publisher setting of each package names `publish-npm.yml`.** Renaming that file
stops publishing until all five packages are reconfigured.

## How the version flows

1. `package.json` says `0.1.0` in git and is never bumped in a commit. The tag is the version.
2. `release-publish` cuts `vX.Y.Z` from the Release PR's title.
3. `publish-npm.yml` runs `npm version --no-git-tag-version --allow-same-version X.Y.Z`, then
   `bun run build:packages` stamps `X.Y.Z` into the daemon binaries, every platform package and the
   main package's `optionalDependencies`.

## Building the packages locally

```sh
bun install && bun run build
bun run check:licenses          # every compiled-in licence is on daemon/licenses-allowed.json
bun run build:packages          # release/<package>/ for all five, then verifies the set
for d in release/*/; do (cd "$d" && npm pack --dry-run); done
```

`node scripts/build-packages.mjs --version 0.0.0-test --only linux-x64` builds one platform
package (and the main package) at a version no registry has, for an install test from tarballs.

## The first publish (one time, by a maintainer)

Trusted publishing is configured per package on npmjs.com, and a package's settings page exists
only after its first publish, so the first version of each of the five packages goes out by hand.
Publishing claims a name for good (unpublish is limited to 72 hours): run this once, deliberately.
None of these steps is run by an agent.

1. **Check the five names are free.** Each must answer `E404`:

   ```sh
   for n in whatsapp-axi whatsapp-axi-linux-x64 whatsapp-axi-linux-arm64 whatsapp-axi-darwin-arm64 whatsapp-axi-darwin-x64; do
     npm view "$n" version
   done
   ```

   If one is taken, stop: the spec and the package template change first.

2. **Get the Release PR ready.** `release-prepare` keeps a `Release: v0.1.0` PR open into `main`.
   Write the release notes into its body and keep the title `Release: v0.1.0`. Wait for its checks
   to be green.

3. **Publish the five packages from a clean clone of that commit**, logged in to npm as a maintainer
   of the JarvusInnovations packages. The four platform packages first, the main package last,
   all at `0.1.0`, all from the clone's `release/` directory:

   ```sh
   sha=$(git ls-remote https://github.com/JarvusInnovations/whatsapp-axi.git refs/heads/develop | cut -f1)
   git clone https://github.com/JarvusInnovations/whatsapp-axi.git /tmp/wa-release
   cd /tmp/wa-release && git checkout --detach "$sha"
   asdf install                                   # go, node and bun from .tool-versions
   npm version --no-git-tag-version --allow-same-version 0.1.0
   bun install --frozen-lockfile
   bun run build && bun run test && bun run check:licenses
   bun run build:packages                         # "the package set in .../release is complete"
   for d in release/*/; do (cd "$d" && npm pack --dry-run); done
   npm login                                      # if not already
   npm publish ./release/whatsapp-axi-linux-x64 --access public
   npm publish ./release/whatsapp-axi-linux-arm64 --access public
   npm publish ./release/whatsapp-axi-darwin-arm64 --access public
   npm publish ./release/whatsapp-axi-darwin-x64 --access public
   for n in linux-x64 linux-arm64 darwin-arm64 darwin-x64; do npm view "whatsapp-axi-$n@0.1.0" version; done   # all four print 0.1.0
   npm publish ./release/whatsapp-axi --access public
   npx -y whatsapp-axi@0.1.0 --version             # 0.1.0
   ```

   Keep `$sha`: step 6 checks the tag against it.

4. **Configure trusted publishing for each of the five packages.** On npmjs.com, open the package
   → **Settings** → **Trusted Publisher** → **GitHub Actions**, and enter:

   | Field | Value |
   | --- | --- |
   | Organization or user | `JarvusInnovations` |
   | Repository | `whatsapp-axi` |
   | Workflow filename | `publish-npm.yml` |
   | Environment | (blank) |

   Do this for `whatsapp-axi`, `whatsapp-axi-linux-x64`, `whatsapp-axi-linux-arm64`,
   `whatsapp-axi-darwin-arm64` and `whatsapp-axi-darwin-x64`. Optionally, under **Publishing
   access**, require two-factor authentication and disallow tokens on each.

5. **Confirm the org secret `BOT_GITHUB_TOKEN` is available to this repository**
   (Settings → Secrets and variables → Actions → Organization secrets). `release-publish.yml`
   needs it to create the tag and the release.

6. **Merge the Release PR** with a merge commit. `release-publish` tags `v0.1.0`; `publish-npm`
   runs its gate, finds all five packages at `0.1.0` on the registry and skips each with a warning.
   Then check that the tag is the commit you published:

   ```sh
   git fetch --tags && git diff "$sha" v0.1.0 --stat   # prints nothing
   ```

The trusted-publisher settings are first exercised by the next release.

## Every release after that

Follow the `jarvus-release-flow` skill. In short:

1. Merge feature PRs into `develop` (merge commits only). Each push refreshes the Release PR.
2. Read the bot changelog, write the notes into the Release PR body, and set its title to the right
   version (the bot proposes the last tag plus a patch).
3. Merge the Release PR with a merge commit. `release-publish` tags and creates the release;
   `publish-npm` publishes the four platform packages, then `whatsapp-axi`.
4. Verify that each went through the workflow:

   ```sh
   for n in whatsapp-axi whatsapp-axi-linux-x64 whatsapp-axi-linux-arm64 whatsapp-axi-darwin-arm64 whatsapp-axi-darwin-x64; do
     npm view "$n@X.Y.Z" version _npmUser.name dist.attestations.provenance.predicateType
   done
   # _npmUser.name 'GitHub Actions', predicateType https://slsa.dev/provenance/v1
   npx -y whatsapp-axi@X.Y.Z --version
   ```

   A person's name in `_npmUser` means that publish did not go through the workflow.

**If a run stops part-way** (some platform packages published, the main package not), re-run the
failed `publish-npm` job: it skips what is already on the registry. A set that cannot be completed
at that version is fixed by releasing the next version; npm versions cannot be replaced.

**Updating the library.** When `library-latest.yml` opens its issue, or `doctor` reports
`outdated`: move `go.mau.fi/whatsmeow` in `daemon/go.mod` to the new version (`go get
go.mau.fi/whatsmeow@latest && go mod tidy` in `daemon/`), fix what broke, and release as usual.
`check:licenses` fails the PR if the update brings in a licence that is not on the allow-list.
