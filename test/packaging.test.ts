// The package set of a release (specs/distribution.md "Packages" and "Tests"): each platform
// package's manifest restricts os and cpu and has no scripts; the main package lists every platform
// package as an optional dependency at its own version; an incomplete set is never publishable.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { platformPackage } from "../src/binary.js";
// @ts-expect-error: a plain ESM script without types
import { mainManifest, packageName, platformManifest, TARGETS, verify } from "../scripts/build-packages.mjs";

type Target = { os: string; cpu: string; goos: string; goarch: string };
type Manifest = Record<string, unknown> & { optionalDependencies?: Record<string, string> };

const root = join(import.meta.dirname, "..");
const repoPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as Manifest;
const targets = TARGETS as Target[];
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const tmp = mkdtempSync(join(tmpdir(), "wa-packaging-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("platform packages", () => {
  it("are the four supported targets, named as the CLI looks them up", () => {
    expect(targets.map((t) => `${t.os}-${t.cpu}`)).toEqual(["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]);
    for (const t of targets) expect(packageName(t)).toBe(platformPackage(t.os, t.cpu));
  });

  it("restrict os and cpu to their own target, have no scripts, and are GPL-3.0-only", () => {
    for (const t of targets) {
      const m = platformManifest(t, "1.2.3") as Manifest;
      expect(m.name).toBe(`whatsapp-axi-${t.os}-${t.cpu}`);
      expect(m.version).toBe("1.2.3");
      expect(m.os).toEqual([t.os]);
      expect(m.cpu).toEqual([t.cpu]);
      expect(m.scripts).toBeUndefined();
      expect(m.dependencies).toBeUndefined();
      expect(m.license).toBe("GPL-3.0-only");
      expect(m.files).toEqual(["bin/whatsapp-axid", "LICENSE", "NOTICES", "SOURCE.md", "README.md"]);
      expect((m.repository as { url: string }).url).toBe(repoPkg.repository && (repoPkg.repository as { url: string }).url);
      expect(JSON.stringify(m)).not.toContain("${");
    }
  });
});

describe("the main package", () => {
  it("lists every platform package as an optional dependency at its own version", () => {
    const m = mainManifest(repoPkg, "1.2.3") as Manifest;
    expect(m.version).toBe("1.2.3");
    expect(Object.keys(m.optionalDependencies ?? {}).sort()).toEqual(targets.map((t) => packageName(t)).sort());
    for (const v of Object.values(m.optionalDependencies ?? {})) expect(v).toBe(m.version);
  });

  it("stays MIT, with no scripts at all and no dev dependencies", () => {
    const m = mainManifest(repoPkg, "1.2.3") as Manifest;
    expect(m.license).toBe("MIT");
    expect(m.scripts).toBeUndefined();
    expect(m.devDependencies).toBeUndefined();
    expect(m.bin).toEqual(repoPkg.bin);
  });

  it("the repository's own manifest has no install-time scripts", () => {
    const scripts = (repoPkg.scripts ?? {}) as Record<string, string>;
    for (const s of INSTALL_SCRIPTS) expect(scripts[s], s).toBeUndefined();
  });
});

describe("verifying an assembled set", () => {
  function assemble(dir: string, version: string, skip?: string): void {
    mkdirSync(join(dir, "whatsapp-axi"), { recursive: true });
    writeFileSync(join(dir, "whatsapp-axi", "package.json"), JSON.stringify(mainManifest(repoPkg, version)));
    for (const t of targets) {
      const name = packageName(t);
      if (name === skip) continue;
      mkdirSync(join(dir, name, "bin"), { recursive: true });
      writeFileSync(join(dir, name, "package.json"), JSON.stringify(platformManifest(t, version)));
      for (const f of ["LICENSE", "NOTICES", "SOURCE.md", "README.md"]) writeFileSync(join(dir, name, f), "x");
      writeFileSync(join(dir, name, "bin", "whatsapp-axid"), "x", { mode: 0o755 });
    }
  }

  it("a complete set passes", () => {
    const dir = join(tmp, "complete");
    assemble(dir, "1.2.3");
    expect(verify(dir)).toEqual([]);
  });

  it("a missing platform package fails, so the main package never points at nothing", () => {
    const dir = join(tmp, "missing");
    assemble(dir, "1.2.3", "whatsapp-axi-darwin-x64");
    expect(verify(dir)).toEqual(["whatsapp-axi-darwin-x64: missing from the set"]);
  });

  it("a platform package at another version fails", () => {
    const dir = join(tmp, "skew");
    assemble(dir, "1.2.3");
    const t = targets[0]!;
    writeFileSync(join(dir, packageName(t), "package.json"), JSON.stringify(platformManifest(t, "1.2.4")));
    expect(verify(dir)).toEqual([`${packageName(t)}: version 1.2.4, not 1.2.3`]);
  });
});
