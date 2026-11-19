# Distribution

How the two programs are built, licensed and delivered. The aim is that one install command gives
a working CLI and daemon on a supported platform, with no Go toolchain.

## Packages

| Package | Contents | Licence |
| --- | --- | --- |
| `whatsapp-axi` | the CLI | MIT |
| `whatsapp-axi-linux-x64`, `whatsapp-axi-linux-arm64`, `whatsapp-axi-darwin-arm64`, `whatsapp-axi-darwin-x64` | one prebuilt `whatsapp-axid` each, with its notices | GPL-3.0-only |

- The main package lists the platform packages as **optional dependencies**, each restricted by
  `os` and `cpu`, so a package manager installs only the one that fits. Nothing runs at install
  time: there is no post-install script and no download.
- All packages of a release share one version number.
- The CLI finds the daemon binary in this order: the `WHATSAPP_AXI_DAEMON` environment variable; a
  binary built in a source checkout next to the CLI; the installed platform package. If none is
  found it says which platform package is missing and how to build from source.
- Service units never run the binary from inside the package directory. `daemon install` copies it
  to a stable path ([daemon.md](daemon.md)).

## Building the daemon

- Pure Go, with CGO disabled, so every platform is built from one Linux runner by setting the
  target OS and architecture.
- The SQLite driver is a pure-Go one. The connection string turns on foreign keys, WAL and a busy
  timeout; the exact string is fixed in code in one place and covered by a test that opens and
  migrates both databases.
- The daemon version and the library version are stamped in at build time and reported by
  `whatsapp-axid version` and by `status`.
- Builds are reproducible from the tagged source and the committed module checksums.

## Licence

- **Source.** Everything in this repository is MIT.
- **Daemon binaries.** A compiled daemon includes a GPL-3.0 library, so each binary is distributed
  under GPL-3.0. Every platform package contains:
  - the GPL-3.0 licence text
  - a `NOTICES` file listing every compiled-in dependency with its version and licence
  - a statement of where the complete corresponding source is: this repository at the release tag,
    plus the dependency versions in the notices
- **The CLI** is a separate program that talks to the daemon over a socket, and is MIT.
- **A CI check** lists the licences of the daemon's dependencies and fails if one appears that is
  not on an allowed list, so a dependency update cannot change the licence position unnoticed.
- The README's licence section says all of this in plain words. It is not legal advice.

## Releases

Releases follow the repository's develop-to-main release pull request flow. Publishing a release:

1. builds the CLI and the four daemon binaries
2. generates each platform package's notices
3. publishes the platform packages, then the main package, so the main package never points at a
   version that does not exist yet

Publishing uses the registry's trusted publishing from CI. Each package has to exist before trust
can be configured for it, so the **first publish of each of the five packages is done once by
hand** by a maintainer, and is a listed step in the plan that implements this spec.

## Staying current

WhatsApp periodically rejects old client versions. The fix is a release built on a newer library.

- Updating the library is a routine release, not an emergency procedure.
- A scheduled CI job builds and tests against the library's latest version and opens an issue when
  that fails, so breakage is seen before WhatsApp forces it.
- An operator learns an upgrade is needed from `doctor`, which names the `outdated` state and the
  two commands that fix it: upgrade the package, then `daemon upgrade`.

## Before packages exist

Until the first release, the tool is used from a source checkout: build the daemon with Go, build
the CLI with npm, and the CLI finds the locally built binary. The pilot runs this way.

## Tests

- The binary lookup order, including the message when nothing is found.
- Each platform package's manifest restricts `os` and `cpu` correctly and has no install scripts.
- The licence check fails on a dependency whose licence is not allowed.
- A cross-compile of all four targets succeeds in CI.

## Principles

**Inherited** ([principles.md](principles.md)):

- *Follow the house style, and write down each departure*: an npm package with platform
  binaries, released by the develop→main flow.

**Local:** none.
