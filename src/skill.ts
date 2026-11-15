// The installable skill's command reference (specs/cli.md "Agent integrations"), generated from the
// CLI's own command specs so the skill cannot drift from the implementation. The prose of
// skills/whatsapp-axi/SKILL.md is hand-written and lives outside the generated markers.
import type { CommandSpec } from "./args.js";

/** How the skill tells an agent to run the CLI: it may not be installed on PATH. */
export const SKILL_INVOCATION = "npx -y whatsapp-axi";

function usage(spec: CommandSpec): string {
  const pos = spec.positionals.map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`)).join(" ");
  const flags = Object.entries(spec.flags)
    .filter(([n]) => n !== "account")
    .map(([n, f]) => (f.type === "bool" ? `[--${n}]` : `[--${n} ${f.value ?? "<value>"}]`))
    .join(" ");
  return [spec.name, pos, flags].filter(Boolean).join(" ");
}

export function commandReferenceMarkdown(specs: CommandSpec[]): string {
  const sorted = [...specs].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((s) => `- \`${SKILL_INVOCATION} ${usage(s)}\` — ${s.summary}`).join("\n");
}

/** Replaces each generated region between its markers. Throws when a region's markers are missing. */
export function spliceGeneratedRegions(doc: string, regions: Record<string, string>): string {
  let out = doc;
  for (const [id, body] of Object.entries(regions)) {
    const begin = `<!-- BEGIN GENERATED: ${id} -->`;
    const end = `<!-- END GENERATED: ${id} -->`;
    const a = out.indexOf(begin);
    const b = out.indexOf(end);
    if (a < 0 || b < a) throw new Error(`SKILL.md is missing the generated region markers for "${id}"`);
    out = `${out.slice(0, a)}${begin}\n\n${body.trim()}\n\n${out.slice(b)}`;
  }
  return out;
}
