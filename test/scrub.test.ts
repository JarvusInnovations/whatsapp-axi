// The public-repo scrub gate (scripts/scrub-check.sh): it passes on this tree and fails on each
// kind of planted marker. Markers are assembled at run time and planted in a throwaway git
// repository, so no marker ever exists in this one.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
const SCRIPT = join(REPO, "scripts", "scrub-check.sh");
const tmp = mkdtempSync(join(tmpdir(), "wa-scrub-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function scrub(cwd: string) {
  const r = spawnSync("bash", [SCRIPT], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

let n = 0;
/** A fresh git repository holding one untracked file with the given text. */
function plant(text: string, file = "notes.md"): string {
  const dir = join(tmp, `r${n++}`);
  mkdirSync(dir);
  expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
  writeFileSync(join(dir, file), `${text}\n`);
  return dir;
}

const j = (...parts: string[]) => parts.join("");

describe("scrub gate", () => {
  it("passes on this repository's tree", () => {
    const r = scrub(REPO);
    expect(r.out).toMatch(/files clean/);
    expect(r.status).toBe(0);
  });

  it.each([
    ["phone number", j("+4", "4", "7700", "900123")],
    ["phone-number id", j("4477", "009001", "23", "@s.whatsapp.net")],
    ["hidden id", j("2318", "4562", "77193@lid")],
    ["group id", j("1203634", "05519", "822014@g.us")],
    ["message id", j("3EB0", "4F2A9C1B", "77D3E8A1")],
    ["home path", j("/ho", "me/", "alice/notes")],
    ["email address", j("carol", "@", "mail-host", ".com")],
  ])("fails on a planted %s", (rule, marker) => {
    const r = scrub(plant(`see ${marker} for details`));
    expect(r.status).toBe(1);
    expect(r.out).toContain(`scrub: ${rule} found`);
  });

  it("allows the synthetic values the tests and specs use", () => {
    const synthetic = [
      j("+1555", "0100001"),
      j("1555", "010", "0001@s.whatsapp.net"),
      j("1000000000000", "01@lid"),
      j("1203630000000000", "01@g.us"),
      j("3EB0AAAA", "0000000001"),
      j("/ho", "me/", "user/src"),
      j("ops", "@", "example", ".com"),
      j("whatsapp-axi", "@", "example.service"),
    ].join(" ");
    const r = scrub(plant(synthetic));
    expect(r.out).toMatch(/files clean/);
    expect(r.status).toBe(0);
  });

  it("never scans node_modules/ or dist/", () => {
    const dir = plant("clean");
    for (const d of ["node_modules/pkg", "dist"]) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, "x.js"), j("/ho", "me/", "alice/x"));
    }
    expect(scrub(dir).status).toBe(0);
  });
});
