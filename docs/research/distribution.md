# Distribution: shipping a Go daemon through npm

Research notes for the spec author; not a spec. Compiled 2026-11-14.

Marks: **[verified]** = read in the cited doc or source, or measured locally; **[inferred]** =
reasoned from verified facts or general knowledge, not checked against a primary source;
**[unknown]** = not established.

---

## 1. The per-platform optionalDependencies pattern

### How esbuild does it

- The main `esbuild` package lists every platform package as an `optionalDependencies`
  entry pinned to the same exact version (`"@esbuild/linux-x64": "0.28.2"`, etc.). It also
  has a `postinstall: node install.js` and a `bin`. [verified]
  <https://github.com/evanw/esbuild/blob/main/npm/esbuild/package.json>
- Each platform package (e.g. `@esbuild/linux-x64`) declares `"os": ["linux"]`,
  `"cpu": ["x64"]` and `"preferUnplugged": true` (for Yarn PnP), and ships the binary at
  `bin/esbuild`. [verified] <https://github.com/evanw/esbuild/blob/main/npm/@esbuild/linux-x64/package.json>
- npm reads `os` from `process.platform` and `cpu` from `process.arch`. `libc` "only applies
  if `os` is `linux`". [verified]
  <https://docs.npmjs.com/cli/v11/configuring-npm/package-json>. The package manager skips
  optional deps whose `os`/`cpu` don't match. [inferred: the npm doc does not state the
  mismatch behaviour explicitly]
- **Runtime resolution:** `pkgAndSubpathForCurrentPlatform()` builds the key
  `` `${process.platform} ${os.arch()} ${os.endianness()}` `` (e.g. `darwin arm64 LE`) and
  looks it up in a table to get the package name and subpath. It then calls
  `require.resolve(`${pkg}/${subpath}`)`. An `ESBUILD_BINARY_PATH` env var overrides all of
  this. [verified] <https://github.com/evanw/esbuild/blob/main/lib/npm/node-platform.ts>
- **Fallback chain** when the platform package is missing: [verified] (node-platform.ts and
  <https://github.com/evanw/esbuild/blob/main/lib/npm/node-install.ts>)
  1. postinstall runs a nested `npm install <pkg>@<version>` in a temp dir;
  2. failing that, it downloads the tarball directly from
     `https://registry.npmjs.org/<pkg>/-/<name>-<version>.tgz`, extracts the binary and checks
     its integrity;
  3. at runtime, if the package is still absent, it checks whether a *different* platform's
     package is present, which means `node_modules` was copied across OS/arch, and prints
     a targeted message.
- The postinstall also checks the binary's version (`validateBinaryVersion`). On non-Windows,
  non-Yarn installs it optimises by replacing the JS shim with the native binary
  (`maybeOptimizePackage`). [verified] (node-install.ts)

### Others using the same pattern

| Project | Language | Platform packages | libc split | postinstall | Source |
| --- | --- | --- | --- | --- | --- |
| `@biomejs/biome` | Rust | `@biomejs/cli-<os>-<arch>[-musl]` | yes: `libc: ["glibc"]` / `["musl"]` | none | [verified] npm registry metadata |
| `lefthook` | **Go** | `lefthook-<os>-<arch>` (11 packages) | no | `node postinstall.js` | [verified] npm registry metadata |
| `turbo` | Rust (was Go) | `turbo-<os>-<arch>` | no `libc` field | [unknown] | [verified] npm registry metadata |
| `@swc/core` | Rust | `@swc/core-<os>-<arch>[-gnu/-musl]` | yes, `libc: ["musl"]` | [unknown] | [verified] npm registry metadata |

- Biome's `bin/biome` shim detects musl at runtime by running `ldd --version` and checking
  stderr for "musl". It maps platform/arch to a package path, honours a `BIOME_BINARY`
  override, and runs the binary with `spawnSync`. [verified]
  <https://github.com/biomejs/biome/blob/main/packages/@biomejs/biome/bin/biome>
- lefthook is the closest analogue: a Go binary shipped exactly this way. [verified, registry]

### Failure modes

- **`--no-optional` / `--omit=optional`:** optional deps are not installed. The npm doc says
  "It is still your program's responsibility to handle the lack of the dependency". [verified]
  (package-json doc). esbuild's error text names exactly these flags. [verified]
  (node-platform.ts)
- **`--ignore-scripts` together with omitted optionals:** both mechanisms fail. esbuild
  explicitly does not handle this case. [verified] (node-platform.ts comment)
- **Script-blocking package managers:** recent pnpm and bun do not run dependency lifecycle
  scripts by default unless allow-listed. A design that relies on postinstall, like
  GoReleaser's (section 3), breaks there. A design that relies on optionalDependencies does
  not. [inferred: pnpm v10 / bun `trustedDependencies` behaviour, docs not read]
- **Lockfile from another platform:** a lockfile generated on macOS and installed on Linux
  (CI, Docker) can omit the needed optional package. esbuild's "installed for another
  platform" message targets the related case of copying `node_modules`. [verified for the
  message; inferred for lockfile behaviour]
- **Yarn PnP:** binaries inside zip archives can't be `exec`'d, hence `preferUnplugged` and
  esbuild's copy-out hack. [verified] (node-platform.ts)
- **Rosetta 2:** npm running under Rosetta installs `darwin-x64`, and a later native node
  wants `darwin-arm64` (or the reverse). esbuild has a dedicated error message for this.
  [verified] (node-platform.ts). For a daemon, an x64 binary under Rosetta still works, just
  emulated. [inferred]
- **musl vs glibc:** only matters if the binary links libc dynamically, which is the case
  with a CGO build: the `mattn` test binary below is "dynamically linked, interpreter
  /lib64/ld-linux-x86-64.so.2". A `CGO_ENABLED=0` binary is "statically linked" and needs no
  musl variant. [verified: `file`/`ldd` on locally built test binaries]
- **Global installs with `npx`:** `npx whatsapp-axi` caches per version. A daemon whose
  binary path lives inside an npx cache dir breaks when the cache is pruned. A supervisor unit
  should point at a stable path. [inferred]

## 2. CGO and the SQLite driver

### What whatsmeow needs

- `whatsmeow` itself imports no SQLite driver. Its `go.mod` has no `mattn/go-sqlite3`,
  `modernc` or `ncruces` dependency. [verified] (go.mod at ecc39170bc14)
- `sqlstore.New(ctx, dialect, address, log)` passes `dialect` both to `sql.Open(dialect,
  address)` (the **driver name**) and to `dbutil.NewWithDB`, which parses it as the
  **dialect**. [verified]
  <https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/sqlstore/container.go#L46-L51>,
  <https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/sqlstore/container.go#L78-L79>
- `dbutil.ParseDialect` lower-cases the name and maps anything starting with `postgres` (or
  `pgx`) to Postgres, and anything starting with `sqlite` or `litestream` to SQLite. Both
  `"sqlite"` (modernc) and `"sqlite3"` (mattn, ncruces) parse as SQLite. [verified]
  go.mau.fi/util v0.11.0 `dbutil/database.go` L39-L49
  (<https://github.com/mautrix/go-util/blob/v0.11.0/dbutil/database.go#L39>)
- `Container.Upgrade` runs `PRAGMA foreign_keys` and **hard-fails** with "foreign keys are not
  enabled" when the dialect is SQLite and FKs are off. The pragma is a DSN concern. [verified]
  <https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/sqlstore/container.go#L101-L113>
- The doc comment examples use mattn syntax: `"sqlite3", "file:yoursqlitefile.db?_foreign_keys=on"`.
  [verified] (container.go L43-L45)
- `go.mau.fi/util/dbutil/litestream` registers `sqlite3-fk-wal` and other drivers on top of
  `mattn/go-sqlite3`, behind `//go:build cgo`. It is optional; the core `dbutil` does not
  import mattn. [verified] (util v0.11.0 `dbutil/litestream/register.go`)

### Driver comparison

Test: a minimal program calling `sqlstore.New` + `GetAllDevices` against whatsmeow
`ecc39170bc14`, built with `-ldflags="-s -w"` and Go 1.26. Sizes are the whole program
(whatsmeow included), not the driver alone. [verified: built and run locally]

| | `mattn/go-sqlite3` v1.14 | `modernc.org/sqlite` v1.62.0 | `ncruces/go-sqlite3` v0.37.0 |
| --- | --- | --- | --- |
| CGO | required (`//go:build cgo`; "you are required to set ... `CGO_ENABLED=1` and have a `gcc`") [verified, source + README] | no [verified] | no; SQLite compiled to Wasm and translated to Go with wasm2go, no wazero dep in the module graph [verified, README + go.mod] |
| Driver name | `sqlite3` [verified] | `sqlite` [verified, `sqlite.go` `driverName = "sqlite"`] | `sqlite3`, changeable by ldflags [verified, `driver/driver.go`] |
| FK DSN | `_foreign_keys=on` / `_fk` [verified, sqlite3.go] | `_pragma=foreign_keys(1)` [verified]; **v1.62.0 also accepts `_foreign_keys`/`_fk`** [verified: sqlite.go L362, and the test passed with `?_foreign_keys=on`]; older versions ignored mattn-style params [inferred from <https://github.com/ory/pop/pull/15>] | `_pragma=foreign_keys(1)` [verified, driver docs + test] |
| whatsmeow upgrade + FK check | passes [verified] | passes with `CGO_ENABLED=0` [verified] | passes with `CGO_ENABLED=0` [verified] |
| No FK param | n/a | fails: "foreign keys are not enabled" [verified] | not tested |
| Built with `CGO_ENABLED=0` | builds, then fails at runtime: "Binary was compiled with 'CGO_ENABLED=0', go-sqlite3 requires cgo to work. This is a stub" [verified] | works | works |
| Cross-compile linux/amd64 to darwin/arm64 | failed: `cgo: C compiler "clang" not found` (needs osxcross/zig or a macOS runner) [verified] | `GOOS=… GOARCH=… go build` worked for linux/arm64, darwin/arm64, darwin/amd64 [verified] | not tested; expected to work [inferred] |
| Stripped size, linux/amd64 | 8.4 MB, dynamically linked to glibc [verified] | 11.0 MB static (linux/arm64 10.6, darwin/arm64 10.8, darwin/amd64 11.1) [verified] | 12.1 MB static [verified] |
| Supported targets | wherever a C toolchain exists [inferred] | explicit list including darwin amd64/arm64 and linux amd64/arm64 [verified, `doc.go`] | [unknown] exact list; pure Go [inferred] |
| Compile time | fast after the first cgo build [inferred] | slow: the first cross-builds took minutes (large generated libc) [verified, observed] | [unknown] |

- Community: whatsmeow discussion #551 (2024) asked about modernc with
  `sqlstore.New("sqlite", "file:…?_pragma=foreign_keys(1)")` and reported it "didn't work
  well" with no error and **no replies**. [verified] <https://github.com/tulir/whatsmeow/discussions/551>.
  The local test above contradicts that for current versions. [verified, local]. Long-running
  behaviour such as concurrency, `SQLITE_BUSY` and WAL under real message load is
  [unknown].
- The #551 premise that mattn "depends on libsqlite3.so" is wrong by default. mattn bundles
  the SQLite amalgamation and links only libc, as `ldd` showed (libc only).
  [verified: ldd output]
- `dbutil` contains no mattn-specific error handling. A grep for "database is locked",
  `SQLITE_BUSY` and mattn imports in `dbutil/*.go` found nothing. [verified]

## 3. Release automation

### Build matrix

- **Pure-Go driver:** one Linux runner can cross-compile every target with `GOOS`/`GOARCH`
  (linux-x64, linux-arm64, darwin-x64, darwin-arm64), with no separate musl build.
  [verified for the modernc build above]
- **CGO driver:** needs a macOS runner for darwin, or zig/osxcross, plus either a musl build
  or a static link (`-linkmode external -extldflags -static` with musl-gcc, per the mattn
  README). [verified: README cross-compile section]

### Publishing N+1 packages

- Order: publish every platform package at version X, then the main package whose
  `optionalDependencies` pin X exactly. Publishing the main package first gives a window where
  installs fail. [inferred]
- A partial failure leaves an inconsistent set. npm versions are immutable (unpublish is
  restricted), so the usual recovery is to bump to X+1 and re-run. [inferred]
- The version comes from the Git tag and is stamped into all N+1 `package.json` files and the
  Go binary (`-ldflags -X`), so the CLI can compare its own version with the daemon's.
  [inferred]

### Trusted publishing / provenance

- Requires npm CLI >= 11.5.1 and Node >= 22.14.0. The GitHub Actions workflow needs
  `permissions: id-token: write`, and both caller and callee need it with `workflow_call`.
  Supported: GitHub-hosted runners, GitLab.com shared runners, CircleCI cloud. Self-hosted
  runners are "not currently supported". [verified] <https://docs.npmjs.com/trusted-publishers>
- Provenance is generated automatically under trusted publishing from GitHub/GitLab, with no
  `--provenance` flag, but only for public repo + public package. [verified] (same link)
- Up to 10 trusted publishers per package. Configs can't be edited, only deleted and
  recreated. A new config must complete its first successful publish within 2 days.
  [verified] (same link)
- **The package must already exist** before a trusted publisher can be configured. npm has
  no "pending publisher" feature like PyPI's, and the usual bootstrap is a manual first
  publish, often a placeholder under a non-`latest` dist-tag. [inferred: consistent across
  community guides and tools such as <https://github.com/azu/setup-npm-trusted-publish>; the
  official page does not state it explicitly]. With N+1 packages that bootstrap is N+1 manual
  publishes plus N+1 trusted-publisher configs, each one naming the repo and workflow
  filename. [inferred]
- Scoped packages default to restricted access, so the first publish needs
  `--access public`. [inferred]

### GoReleaser

- npm publishing (`npms:`) is "exclusively available with GoReleaser Pro", since v2.8.
  [verified] <https://goreleaser.com/customization/npm>
- Its model is **postinstall download**, not optionalDependencies: "a `postinstall` script
  will download the archive, and extract/copy the binaries", and "This will not work if the
  user installs with `--ignore-scripts`". [verified] (same link)
- Its support for provenance or trusted publishing: [unknown] (not stated on that page).
- OSS GoReleaser can still build the binaries, archives and checksums. A small script would
  then lay out the platform packages and publish them. [inferred]

### Trigger

- `on: release: types: [published]` runs on GitHub release publish. [inferred: standard GHA
  event] Jobs: build (cross-compile) → publish platform packages (matrix or loop) → publish
  main package → attach binaries to the GitHub release. The `id-token: write` permission goes
  on the publish job only. [inferred]
- Trusted-publisher config pins the workflow **filename**, so renaming the workflow breaks
  publishing until every package is reconfigured. [inferred]

## 4. macOS signing and Gatekeeper

- The Go linker ad-hoc code-signs `darwin/arm64` executables: `NeedCodeSign()` returns
  `ctxt.IsDarwin() && ctxt.IsARM64()`, and `macho.go` calls `codesign.Sign`. Apple Silicon
  refuses to run unsigned arm64 code, so this is what lets a cross-compiled binary run at all.
  [verified: Go 1.26 source `cmd/link/internal/ld/lib.go` `NeedCodeSign`, `macho.go`;
  <https://github.com/golang/go/blob/master/src/cmd/link/internal/ld/lib.go>]. Whether that
  holds with external linking (CGO): [unknown]; Apple's `ld` signs by default [inferred].
- Quarantine: command-line network tools such as curl and scp do not set
  `com.apple.quarantine`, and Gatekeeper checks quarantined files. A binary written by
  npm/node is therefore normally not quarantined and runs without notarization.
  [inferred: secondary sources, e.g. Unit 42 and MITRE ATT&CK T1553.001
  <https://attack.mitre.org/techniques/T1553/001/>]
- Exceptions: quarantine can reach package files when copied from an already-quarantined
  source (`clonefile`/`copyfile` keep xattrs), or when the creating process inherited
  quarantine. One package-manager project strips the attribute from native binaries after
  install for this reason. [verified as that project's claim]
  <https://github.com/nubjs/nub/pull/601>. Whether npm-in-Terminal ever hits this: [unknown].
- launchd will run an ad-hoc-signed, non-notarized binary from a LaunchAgent. [inferred]
  Background-item login notifications and the "Login Items & Extensions" settings on recent
  macOS can show the agent to the user. [inferred]
- Developer ID signing + notarization of a bare Mach-O is possible (`codesign` + `notarytool`
  on a zip). It needs a paid Apple account and a macOS runner. [inferred]

## Implications for the spec (not decisions)

1. **CGO is avoidable.** whatsmeow upgrades and passes its FK check under `CGO_ENABLED=0`
   with both `modernc.org/sqlite` (driver `"sqlite"`) and `ncruces/go-sqlite3`. That gives
   static binaries, one-runner cross-compilation, and no musl packages, at a cost of about
   2.5 to 3.7 MB per binary and slower builds. Production-load behaviour of the pure-Go
   drivers with whatsmeow is unproven.
2. The DSN is load-bearing: no FK pragma means a hard startup failure. The spec should fix
   the exact DSN (driver name + pragma syntax) per driver and not rely on version-dependent
   alias support.
3. optionalDependencies (esbuild/biome/lefthook) survives `--ignore-scripts` and
   script-blocking package managers. GoReleaser Pro's postinstall model does not. A
   postinstall fallback is optional extra robustness, not the primary path.
4. Trusted publishing needs each of the N+1 packages to exist first. The spec should plan a
   one-time manual bootstrap per package and pin the workflow filename.
5. Supervisor units should reference a stable binary path, not one inside an npx or
   `node_modules` cache that upgrades or pruning can move.
