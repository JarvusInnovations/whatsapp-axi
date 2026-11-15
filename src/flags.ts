// Strict per-command argument parsing: unknown flags, missing values and extra arguments are usage
// errors that list the command's valid flags (specs/cli.md "Conventions").
import { BIN, usage } from "./errors.js";

export type FlagType = "string" | "bool" | "int";

export interface FlagSpec {
  type: FlagType;
  value?: string; // placeholder shown in help, e.g. "<n>"
  desc: string;
  repeat?: boolean;
}

export interface CommandSpec {
  /** The command path as typed, e.g. "chat view". */
  name: string;
  summary: string;
  positionals: { name: string; required: boolean; desc: string }[];
  flags: Record<string, FlagSpec>;
  examples: string[];
}

export interface Parsed {
  flags: Record<string, string | boolean | number | string[] | undefined>;
  pos: string[];
}

function flagList(spec: CommandSpec): string {
  const names = Object.entries(spec.flags).map(([n, f]) => (f.type === "bool" ? `--${n}` : `--${n} ${f.value ?? "<value>"}`));
  return names.length ? names.join(", ") : "none";
}

function usageLine(spec: CommandSpec): string {
  const pos = spec.positionals.map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`)).join(" ");
  return `${BIN} ${spec.name}${pos ? ` ${pos}` : ""}${Object.keys(spec.flags).length ? " [flags]" : ""}`;
}

function helpFor(spec: CommandSpec): string[] {
  return [`valid flags for \`${spec.name}\`: ${flagList(spec)} (--help always allowed)`, `usage: ${usageLine(spec)}`];
}

export function parse(spec: CommandSpec, args: string[]): Parsed {
  const out: Parsed = { flags: {}, pos: [] };
  let onlyPositionals = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!onlyPositionals && a === "--") {
      onlyPositionals = true;
      continue;
    }
    if (!onlyPositionals && a.startsWith("-") && a !== "-") {
      if (!a.startsWith("--")) throw usage(`unknown flag ${a} for \`${spec.name}\``, helpFor(spec));
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const f = spec.flags[name];
      if (!f) throw usage(`unknown flag --${name} for \`${spec.name}\``, helpFor(spec));
      if (f.type === "bool") {
        if (eq > 0) throw usage(`--${name} takes no value`, helpFor(spec));
        out.flags[name] = true;
        continue;
      }
      let value: string | undefined;
      if (eq > 0) value = a.slice(eq + 1);
      else {
        value = args[i + 1];
        if (value === undefined || (value.startsWith("--") && value.length > 2)) {
          throw usage(`--${name} needs a value`, helpFor(spec));
        }
        i++;
      }
      if (value === "") throw usage(`--${name} needs a value`, helpFor(spec));
      let v: string | number = value;
      if (f.type === "int") {
        if (!/^[0-9]+$/.test(value)) throw usage(`--${name} must be a whole number, got ${JSON.stringify(value)}`, helpFor(spec));
        v = Number(value);
      }
      if (f.repeat) {
        const prev = (out.flags[name] as string[] | undefined) ?? [];
        out.flags[name] = [...prev, String(v)];
      } else {
        if (out.flags[name] !== undefined) throw usage(`--${name} is given more than once`, helpFor(spec));
        out.flags[name] = v;
      }
      continue;
    }
    out.pos.push(a);
  }
  const required = spec.positionals.filter((p) => p.required).length;
  if (out.pos.length > spec.positionals.length) {
    throw usage(`unexpected argument ${JSON.stringify(out.pos[spec.positionals.length])} for \`${spec.name}\``, helpFor(spec));
  }
  if (out.pos.length < required) {
    const missing = spec.positionals[out.pos.length];
    throw usage(`<${missing.name}> is required for \`${spec.name}\``, helpFor(spec));
  }
  return out;
}

/** Concise per-command help: usage, arguments, flags, examples. */
export function renderHelp(spec: CommandSpec): string {
  const lines = [`command: ${spec.name}`, `description: ${spec.summary}`, `usage: ${usageLine(spec)}`];
  if (spec.positionals.length) {
    lines.push(`args[${spec.positionals.length}]:`);
    for (const p of spec.positionals) lines.push(`  <${p.name}>: ${p.required ? "" : "(optional) "}${p.desc}`);
  }
  const flags = Object.entries(spec.flags);
  if (flags.length) {
    lines.push(`flags[${flags.length}]:`);
    for (const [n, f] of flags) lines.push(`  --${n}${f.type === "bool" ? "" : ` ${f.value ?? "<value>"}`}: ${f.desc}`);
  }
  if (spec.examples.length) {
    lines.push(`examples[${spec.examples.length}]:`);
    for (const e of spec.examples) lines.push(`  ${e}`);
  }
  return lines.join("\n") + "\n";
}

/** Parses --fields against the fields a list offers beyond its defaults. */
export function parseFields(spec: CommandSpec, value: unknown, extra: string[]): string[] {
  if (value === undefined) return [];
  const asked = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const f of asked) {
    if (!extra.includes(f)) throw usage(`unknown field ${JSON.stringify(f)} for \`${spec.name}\``, [`fields available: ${extra.join(", ")}`]);
  }
  return asked;
}
