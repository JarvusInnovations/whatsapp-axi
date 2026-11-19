import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GROUPS, SPECS } from "../src/reference.js";
import { commandReferenceMarkdown, spliceGeneratedRegions } from "../src/skill.js";

describe("the installable skill", () => {
  const path = join(import.meta.dirname, "..", "skills", "whatsapp-axi", "SKILL.md");
  const doc = readFileSync(path, "utf-8");

  it("is current with the CLI's own command reference (the docs script)", () => {
    expect(spliceGeneratedRegions(doc, { "command-reference": commandReferenceMarkdown(GROUPS) })).toBe(doc);
  });

  it("names every command as npx -y whatsapp-axi and carries no live state", () => {
    for (const spec of SPECS) expect(doc).toContain(`npx -y whatsapp-axi ${spec.name}`);
    expect(doc).not.toMatch(/\+1555\d{7}|@s\.whatsapp\.net|@lid\b/);
  });
});
