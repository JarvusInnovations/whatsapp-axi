#!/usr/bin/env node
// Regenerates the command reference in skills/whatsapp-axi/SKILL.md from the built CLI's command
// specs. `--check` fails (exit 1) when the committed file is stale, for CI. Run `npm run build` first.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { SPECS } = await import(join(root, "dist/src/cli.js"));
const { commandReferenceMarkdown, spliceGeneratedRegions } = await import(join(root, "dist/src/skill.js"));
const path = join(root, "skills/whatsapp-axi/SKILL.md");
const current = readFileSync(path, "utf-8");
const next = spliceGeneratedRegions(current, { "command-reference": commandReferenceMarkdown(SPECS) });
if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error("skills/whatsapp-axi/SKILL.md is stale: run `npm run build && npm run build:skill` and commit it");
    process.exit(1);
  }
  console.log("skills/whatsapp-axi/SKILL.md is current");
} else if (next !== current) {
  writeFileSync(path, next);
  console.log("wrote skills/whatsapp-axi/SKILL.md");
} else {
  console.log("skills/whatsapp-axi/SKILL.md already current");
}
