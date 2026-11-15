#!/usr/bin/env node
// The licence gate and the notices of the compiled daemon (specs/distribution.md "Licence").
//
// Lists every module compiled into whatsapp-axid for each release target (`go list -deps` with
// CGO disabled), classifies each module's licence file, and fails (exit 1) when one is not on the
// allow-list in daemon/licenses-allowed.json, or cannot be classified and is not pinned there. A
// dependency update therefore cannot change the licence position unnoticed. build-packages.mjs
// uses the same functions to write each platform package's NOTICES.
//
//   node scripts/daemon-licenses.mjs [--allow <file>]   # (bun run check:licenses) exit 0 allowed, 1 not, 2 on error
//
// --allow reads another allow-list in place of daemon/licenses-allowed.json (the tests use it).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DAEMON = join(ROOT, "daemon");
export const TARGETS = JSON.parse(readFileSync(join(ROOT, "packaging", "targets.json"), "utf-8"));
export const REPOSITORY = "https://github.com/JarvusInnovations/whatsapp-axi";

const PRIMARY = ["license", "license.txt", "license.md", "licence", "licence.txt", "licence.md", "copying", "copying.txt"];
const NOTICE_FILE = /^(licen[cs]e|copying|notice|patents)([-._].*)?$/i;

/** The SPDX-style id of a licence text, or "unknown". Checked from the most to the least specific. */
export function classify(text) {
  const t = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");
  // The GNU licences and the MPL name each other in their bodies, so each is known by its title.
  const head = t.slice(0, 300);
  if (/Mozilla Public License,? (Version|v\.?) ?2\.0/i.test(head)) return "MPL-2.0";
  const gnu = /GNU (AFFERO |LESSER |LIBRARY )?GENERAL PUBLIC LICENSE,? Version (\d)/i.exec(head);
  if (gnu) {
    const kind = (gnu[1] ?? "").trim().toUpperCase();
    if (kind === "AFFERO") return "AGPL-3.0";
    if (kind) return gnu[2] === "3" ? "LGPL-3.0" : "LGPL-2.1";
    return gnu[2] === "3" ? "GPL-3.0" : gnu[2] === "2" ? "GPL-2.0" : "unknown";
  }
  if (/Apache License,? Version 2\.0/i.test(t) || (/Apache License/i.test(t) && /Version 2\.0, January 2004/i.test(t))) return "Apache-2.0";
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    if (/advertising materials/i.test(t)) return "BSD-4-Clause";
    return /endorse or promote/i.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  if (/Permission to use, copy, modify, and(\/or)? distribute this software for any purpose with or without fee/i.test(t)) return "ISC";
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) return "MIT";
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return "Unlicense";
  return "unknown";
}

/** The licence and notice files at a module's root: the primary licence file first. */
export function licenseFiles(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => NOTICE_FILE.test(n) && statSync(join(dir, n)).isFile());
  } catch {
    return { primary: undefined, all: [] };
  }
  const primary = names.find((n) => PRIMARY.includes(n.toLowerCase()));
  const rest = names.filter((n) => n !== primary).sort();
  return { primary, all: primary ? [primary, ...rest] : rest };
}

function go(args, env = {}) {
  return execFileSync("go", args, { cwd: DAEMON, encoding: "utf-8", env: { ...process.env, CGO_ENABLED: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Every component compiled into whatsapp-axid for one target: the Go standard library and runtime,
 * then each non-main module with its version, directory and licence.
 */
export function components(target) {
  const env = { GOOS: target.goos, GOARCH: target.goarch };
  const fmt = "{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{with .Replace}}\t{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}{{end}}";
  const lines = go(["list", "-mod=readonly", "-deps", "-f", fmt, "./cmd/whatsapp-axid"], env).split("\n").filter(Boolean);
  const seen = new Map();
  for (const line of lines) {
    const f = line.split("\t");
    const [path, version, dir] = f.length > 3 ? [f[0], f[4] || f[1], f[5]] : f;
    if (!seen.has(path)) seen.set(path, { path, version, dir });
  }
  const goroot = go(["env", "GOROOT"]).trim();
  const goversion = go(["env", "GOVERSION"]).trim();
  const list = [
    { path: "go (standard library and runtime)", version: goversion, dir: goroot },
    ...[...seen.values()].sort((a, b) => a.path.localeCompare(b.path)),
  ];
  return list.map((c) => {
    const files = licenseFiles(c.dir);
    const license = files.primary ? classify(readFileSync(join(c.dir, files.primary), "utf-8")) : "none";
    return { ...c, files: files.all, primary: files.primary, license };
  });
}

export function readAllowList(path = join(DAEMON, "licenses-allowed.json")) {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return { allowed: new Set(raw.allowed ?? []), modules: raw.modules ?? {} };
}

/** Marks each component allowed or not. A module pinned in the allow-list uses its pinned licence. */
export function check(list, allow) {
  return list.map((c) => {
    const pin = allow.modules[c.path];
    const license = pin ? pin.license : c.license;
    return { ...c, license, pinned: Boolean(pin), allowed: allow.allowed.has(license) };
  });
}

/** The NOTICES file of one platform package. */
export function notices(list, { version, target }) {
  const pad = (s, n) => (s.length >= n ? `${s} ` : s.padEnd(n));
  const w = Math.max(...list.map((c) => c.path.length)) + 2;
  const v = Math.max(...list.map((c) => c.version.length)) + 2;
  const out = [
    `NOTICES for whatsapp-axid ${version} (${target.os}-${target.cpu})`,
    "",
    "This program is distributed under the GNU General Public License version 3 (see LICENSE),",
    "because it includes go.mau.fi/libsignal, which is GPL-3.0. The complete corresponding source",
    `is ${REPOSITORY} at the tag v${version} (the daemon/ directory and its go.sum), built with`,
    "the Go toolchain and the modules below at exactly these versions. See SOURCE.md.",
    "",
    "Compiled-in components:",
    "",
    ...list.map((c) => `  ${pad(c.path, w)}${pad(c.version, v)}${c.license}`),
    "",
  ];
  for (const c of list) {
    for (const f of c.files) {
      out.push("=".repeat(78), `${c.path} ${c.version}: ${f}`, "=".repeat(78), "", readFileSync(join(c.dir, f), "utf-8").trimEnd(), "");
    }
  }
  return out.join("\n");
}

function main() {
  const i = process.argv.indexOf("--allow");
  const allow = i > 0 ? readAllowList(process.argv[i + 1]) : readAllowList();
  const rows = new Map();
  for (const target of TARGETS) {
    for (const c of check(components(target), allow)) {
      const key = `${c.path}@${c.version}`;
      const row = rows.get(key) ?? { ...c, targets: [] };
      row.targets.push(`${target.os}-${target.cpu}`);
      rows.set(key, row);
    }
  }
  const all = [...rows.values()];
  const bad = all.filter((r) => !r.allowed);
  console.log(`daemon dependency licences (${all.length} components, ${TARGETS.length} targets):`);
  for (const r of all) {
    const where = r.targets.length === TARGETS.length ? "" : ` [${r.targets.join(", ")}]`;
    console.log(`  ${r.allowed ? "ok " : "NOT"} ${r.license.padEnd(13)} ${r.path} ${r.version}${r.pinned ? " (pinned)" : ""}${where}`);
  }
  if (bad.length) {
    console.error(`\n${bad.length} not allowed by daemon/licenses-allowed.json:`);
    for (const r of bad) console.error(`  ${r.path} ${r.version}: ${r.license}${r.primary ? ` (${r.primary})` : " (no licence file)"}`);
    console.error("A licence that is not on the list changes the licence position of the daemon binaries; review it before adding it.");
    process.exit(1);
  }
  console.log("all allowed");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    console.error(`check:licenses: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
