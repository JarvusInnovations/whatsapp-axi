#!/usr/bin/env node
// Assembles the five npm packages of a release (specs/distribution.md), from the version in
// package.json (the publish workflow sets it from the release tag first):
//
//   release/whatsapp-axi-<os>-<cpu>/   one per target in packaging/targets.json, from the one
//                                      template in packaging/platform/: package.json (os, cpu,
//                                      files, GPL-3.0-only, no scripts), bin/whatsapp-axid
//                                      cross-compiled with CGO disabled, LICENSE (GPL-3.0),
//                                      NOTICES (generated) and SOURCE.md
//   release/whatsapp-axi/              the CLI: dist/, the skill, LICENSE, README.md and a
//                                      manifest with no scripts and the platform packages as
//                                      optionalDependencies at the same version
//
// Every build runs the licence gate first. Then it verifies the set: a release never publishes a
// main package that points at a platform package missing from the set.
//
//   node scripts/build-packages.mjs [--out <dir>] [--version <v>] [--only <os-cpu>,...]
//   node scripts/build-packages.mjs --verify [--out <dir>]      # check an assembled set only
//
// Run `bun run build` first. Exit 0 on success, 1 on a failed check, 2 on error.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, components, DAEMON, notices, readAllowList, ROOT, TARGETS } from "./daemon-licenses.mjs";

export { TARGETS };
export const MAIN = "whatsapp-axi";
const TEMPLATE = join(ROOT, "packaging", "platform");
const LIBRARY = "go.mau.fi/whatsmeow";
const RUNNER = "github.com/JarvusInnovations/whatsapp-axi/daemon/internal/runner";

export function packageName(target) {
  return `${MAIN}-${target.os}-${target.cpu}`;
}

function fill(text, vars) {
  return text.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** A platform package's manifest, from the template. */
export function platformManifest(target, version) {
  return JSON.parse(fill(readFileSync(join(TEMPLATE, "package.json"), "utf-8"), { ...target, version }));
}

/** The published main manifest: the repository's, at `version`, without scripts or devDependencies, with the platform packages. */
export function mainManifest(pkg, version, targets = TARGETS) {
  const { scripts: _scripts, devDependencies: _dev, optionalDependencies: _opt, ...rest } = pkg;
  return {
    ...rest,
    version,
    optionalDependencies: Object.fromEntries(targets.map((t) => [packageName(t), version])),
  };
}

function goOut(args, env = {}) {
  return execFileSync("go", args, { cwd: DAEMON, encoding: "utf-8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function write(path, text, mode) {
  writeFileSync(path, text);
  if (mode) chmodSync(path, mode);
}

export function buildPlatform(target, { out, version, library, goversion, allow }) {
  const name = packageName(target);
  const dir = join(out, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "bin"), { recursive: true });

  const list = check(components(target), allow);
  const bad = list.filter((c) => !c.allowed);
  if (bad.length)
    throw new Error(`${name}: licence not allowed: ${bad.map((c) => `${c.path} ${c.version} (${c.license})`).join(", ")}; run \`bun run check:licenses\``);

  const ldflags = `-s -w -X main.version=${version} -X ${RUNNER}.LibraryVersion=${library}`;
  execFileSync("go", ["build", "-trimpath", "-buildvcs=false", "-ldflags", ldflags, "-o", join(dir, "bin", "whatsapp-axid"), "./cmd/whatsapp-axid"], {
    cwd: DAEMON,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CGO_ENABLED: "0", GOOS: target.goos, GOARCH: target.goarch },
  });
  chmodSync(join(dir, "bin", "whatsapp-axid"), 0o755);

  const vars = { ...target, version, library, goversion };
  write(join(dir, "package.json"), `${JSON.stringify(platformManifest(target, version), null, 2)}\n`);
  cpSync(join(TEMPLATE, "LICENSE"), join(dir, "LICENSE"));
  write(join(dir, "README.md"), fill(readFileSync(join(TEMPLATE, "README.md"), "utf-8"), vars));
  write(join(dir, "SOURCE.md"), fill(readFileSync(join(TEMPLATE, "SOURCE.md"), "utf-8"), vars));
  write(join(dir, "NOTICES"), notices(list, { version, target }));
  return dir;
}

export function buildMain({ out, version, targets }) {
  const dir = join(out, MAIN);
  if (!existsSync(join(ROOT, "dist", "bin", "whatsapp-axi.js"))) throw new Error("dist/ is missing: run `bun run build` first");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  for (const f of pkg.files) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  write(join(dir, "package.json"), `${JSON.stringify(mainManifest(pkg, version, targets), null, 2)}\n`);
  return dir;
}

/** The problems with an assembled set; empty when it can be published. */
export function verify(out, targets = TARGETS) {
  const problems = [];
  const read = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      return undefined;
    }
  };
  const main = read(join(out, MAIN));
  if (!main) return [`${MAIN}: no package at ${join(out, MAIN)}`];
  if (main.scripts) problems.push(`${MAIN}: has scripts`);
  if (main.license !== "MIT") problems.push(`${MAIN}: licence is ${main.license}, not MIT`);
  const deps = main.optionalDependencies ?? {};
  const want = targets.map(packageName);
  for (const n of Object.keys(deps)) if (!want.includes(n)) problems.push(`${MAIN}: unexpected optional dependency ${n}`);
  for (const t of targets) {
    const name = packageName(t);
    const dir = join(out, name);
    if (deps[name] !== main.version) problems.push(`${MAIN}: optional dependency ${name} is ${deps[name] ?? "missing"}, not ${main.version}`);
    const m = read(dir);
    if (!m) {
      problems.push(`${name}: missing from the set`);
      continue;
    }
    if (m.name !== name) problems.push(`${name}: manifest names ${m.name}`);
    if (m.version !== main.version) problems.push(`${name}: version ${m.version}, not ${main.version}`);
    if (m.scripts) problems.push(`${name}: has scripts`);
    if (m.license !== "GPL-3.0-only") problems.push(`${name}: licence is ${m.license}`);
    if (JSON.stringify(m.os) !== JSON.stringify([t.os]) || JSON.stringify(m.cpu) !== JSON.stringify([t.cpu]))
      problems.push(`${name}: os/cpu are ${m.os}/${m.cpu}`);
    for (const f of ["bin/whatsapp-axid", "LICENSE", "NOTICES", "SOURCE.md", "README.md"]) {
      const p = join(dir, f);
      if (!existsSync(p) || statSync(p).size === 0) problems.push(`${name}: ${f} is missing or empty`);
    }
    const bin = join(dir, "bin", "whatsapp-axid");
    if (existsSync(bin) && (statSync(bin).mode & 0o111) === 0) problems.push(`${name}: bin/whatsapp-axid is not executable`);
  }
  const extra = existsSync(out) ? readdirSync(out).filter((n) => n !== MAIN && !want.includes(n)) : [];
  for (const n of extra) problems.push(`${n}: not a package of this release`);
  return problems;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const out = resolve(arg("--out") ?? join(ROOT, "release"));
  if (!process.argv.includes("--verify")) {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    const version = arg("--version") ?? pkg.version;
    const only = arg("--only")?.split(",");
    const targets = only ? TARGETS.filter((t) => only.includes(`${t.os}-${t.cpu}`)) : TARGETS;
    if (only && targets.length !== only.length)
      throw new Error(`--only names an unknown target; targets: ${TARGETS.map((t) => `${t.os}-${t.cpu}`).join(", ")}`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const library = goOut(["list", "-mod=readonly", "-m", "-f", "{{if .Replace}}{{.Replace.Version}}{{else}}{{.Version}}{{end}}", LIBRARY]);
    const goversion = goOut(["env", "GOVERSION"]);
    const allow = readAllowList();
    for (const t of targets) console.log(`built ${buildPlatform(t, { out, version, library, goversion, allow })}`);
    console.log(`built ${buildMain({ out, version, targets: TARGETS })}`);
    if (only) {
      console.log(`partial set (${only.join(", ")}): not publishable`);
      return;
    }
  }
  const problems = verify(out);
  if (problems.length) {
    console.error(`the package set in ${out} cannot be published:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`the package set in ${out} is complete`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    console.error(`build-packages: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
