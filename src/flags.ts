// The strict parser (specs/conventions.md, the house `flags` rules, adapted from the family's
// reference parser). Every command declares its flags and positionals in one CommandSpec, which
// also feeds --help, the top-level help and the generated skill. Anything undeclared is refused
// before any work: an unknown flag is UNKNOWN_FLAG, wrong arity or a missing value is USAGE, a bad
// value or a contradiction is VALIDATION_ERROR. --help, --account and --tz are global.
import { BIN, ToolError, invalid, usage } from "./errors.js";

export type FlagType = "string" | "bool" | "int";

export interface FlagSpec {
  type: FlagType;
  value?: string; // placeholder shown in help, e.g. "<n>"
  desc: string;
  repeat?: boolean;
  /** The values an enum flag accepts; anything else is VALIDATION_ERROR. */
  values?: string[];
}

/**
 * How a command finds its account:
 * - "resolve": the pin, --account, the default, or the only account
 * - "positional": as resolve, and the account name may also be the first positional
 * - "named": the account is the first positional, which must be given (account add, account use)
 * - "all": acts on every account unless --account narrows it (doctor)
 * - "none": acts on no account (setup hooks)
 */
export type AccountMode = "resolve" | "positional" | "named" | "all" | "none";

export interface CommandSpec {
  /** The command path as typed, e.g. "chat view". */
  name: string;
  summary: string;
  positionals: { name: string; required: boolean; desc: string }[];
  flags: Record<string, FlagSpec>;
  examples: string[];
  /** Whether the command changes anything; a string names the flag that makes it one. */
  mutation?: boolean | string;
  account?: AccountMode;
  /** Takes --json-out[=path]. */
  jsonOut?: boolean;
}

export type FlagValue = string | boolean | number | string[] | undefined;

export interface Parsed {
  flags: Record<string, FlagValue>;
  pos: string[];
}

/** Flags every command accepts; the dispatcher takes them out before a command parses. */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  account: { type: "string", value: "<name>", desc: "the account (needed for a change when there are several accounts)" },
  tz: { type: "string", value: "<iana>", desc: "show times in this zone (default: the system's)" },
};

const ALWAYS = "(--help, --account and --tz always allowed)";

/** Commands that take --json-out, filled in by the dispatcher for the hint of a command without it. */
export const jsonOutCommands: string[] = [];

/** Whether the command changes anything with these flags. */
export function isMutation(spec: CommandSpec, flags: Record<string, FlagValue>): boolean {
  if (typeof spec.mutation === "string") return flags[spec.mutation] !== undefined && flags[spec.mutation] !== false;
  return spec.mutation === true;
}

function flagNames(spec: CommandSpec): string[] {
  const names = Object.keys(spec.flags).map((n) => `--${n}`);
  if (spec.jsonOut) names.push("--json-out[=path]");
  return names;
}

export function usageLine(spec: CommandSpec): string {
  const pos = spec.positionals.map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`)).join(" ");
  return `${BIN} ${spec.name}${pos ? ` ${pos}` : ""}${Object.keys(spec.flags).length || spec.jsonOut ? " [flags]" : ""}`;
}

function validFlags(spec: CommandSpec): string {
  const names = flagNames(spec);
  return names.length ? `valid flags for \`${spec.name}\`: ${names.join(", ")} ${ALWAYS}` : `\`${spec.name}\` takes no flags of its own ${ALWAYS}`;
}

function usageHelp(spec: CommandSpec): string[] {
  return [`usage: ${usageLine(spec)}`, validFlags(spec)];
}

function jsonOutExamples(): string {
  const names = jsonOutCommands.length ? jsonOutCommands : ["read", "events", "chats"];
  return (
    names
      .slice(0, 4)
      .map((n) => `\`${n}\``)
      .join(", ") + (names.length > 4 ? " and the other commands that call the daemon" : "")
  );
}

/**
 * Flags agents guess from other tools, and their pointed hint. A hint must be true of the command
 * printing it, so it is built here, per command.
 */
function guessed(spec: CommandSpec, typed: string): string | undefined {
  if (typed === "--json") {
    return spec.jsonOut
      ? "--json is not a flag of this tool: standard output is always TOON; add --json-out to also write the complete result as JSON to a file"
      : `--json is not a flag of this tool, and \`${spec.name}\` writes no JSON; --json-out works on ${jsonOutExamples()}`;
  }
  if (typed === "-n") {
    return spec.flags.limit ? "-n is not a flag of this tool; use --limit <n>" : `-n is not a flag of this tool, and \`${spec.name}\` takes no limit`;
  }
  if (typed === "--json-out" || typed.startsWith("--json-out=")) {
    return `\`${spec.name}\` writes no JSON file; --json-out works on ${jsonOutExamples()}`;
  }
  if (typed === "--force")
    return "--force is not a flag of this tool: a change that needs consent takes --confirm, and the error that asks for it shows the full command";
  return undefined;
}

function unknownFlag(spec: CommandSpec, typed: string): ToolError {
  const hint = guessed(spec, typed);
  return new ToolError(`unknown flag ${typed} for \`${spec.name}\``, "UNKNOWN_FLAG", hint ? [hint, validFlags(spec)] : [validFlags(spec)]);
}

/** A token that starts a flag: `--x…` or `-x` with a letter; `-`, `--- text`, `-5` are text. */
export function isFlagToken(a: string): boolean {
  return /^--[A-Za-z]/.test(a) || /^-[A-Za-z]/.test(a);
}

export function parse(spec: CommandSpec, args: string[]): Parsed {
  const out: Parsed = { flags: {}, pos: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.pos.push(...args.slice(i + 1));
      break;
    }
    if (!isFlagToken(a)) {
      out.pos.push(a);
      continue;
    }
    if (!a.startsWith("--")) throw unknownFlag(spec, a);
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const f = spec.flags[name];
    if (!f) throw unknownFlag(spec, name === "json-out" ? a : `--${name}`);
    if (f.type === "bool") {
      if (eq > 0) throw usage(`--${name} is a switch and takes no value`, usageHelp(spec));
      if (out.flags[name] !== undefined) throw usage(`--${name} is given more than once`, usageHelp(spec));
      out.flags[name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq > 0) value = a.slice(eq + 1);
    else {
      value = args[i + 1];
      if (value === undefined || isFlagToken(value)) throw usage(`--${name} needs a value: --${name} ${f.value ?? "<value>"}`, usageHelp(spec));
      i++;
    }
    if (value === "") throw usage(`--${name} needs a value: --${name} ${f.value ?? "<value>"}`, usageHelp(spec));
    let v: string | number = value;
    if (f.type === "int") {
      if (!/^[0-9]+$/.test(value)) throw invalid(`--${name} must be a whole number, got ${JSON.stringify(value)}`, usageHelp(spec));
      v = Number(value);
    }
    if (f.values && !f.values.includes(value)) throw invalid(`--${name} must be one of ${f.values.join(", ")}, got ${JSON.stringify(value)}`, usageHelp(spec));
    if (f.repeat) {
      const prev = (out.flags[name] as string[] | undefined) ?? [];
      out.flags[name] = [...prev, String(v)];
    } else {
      if (out.flags[name] !== undefined) throw usage(`--${name} is given more than once`, usageHelp(spec));
      out.flags[name] = v;
    }
  }
  const required = spec.positionals.filter((p) => p.required).length;
  if (out.pos.length > spec.positionals.length) {
    throw usage(`unexpected argument ${JSON.stringify(out.pos[spec.positionals.length])} for \`${spec.name}\``, usageHelp(spec));
  }
  if (out.pos.length < required) {
    const missing = spec.positionals[out.pos.length];
    throw usage(`<${missing.name}> is required for \`${spec.name}\``, usageHelp(spec));
  }
  return out;
}

/** Two flags or arguments that cannot be given together: VALIDATION_ERROR naming both. */
export function contradiction(a: string, b: string, help: string[] = []): ToolError {
  return invalid(`give ${a} or ${b}, not both`, help);
}

/** A value outside the allowed set: VALIDATION_ERROR listing them. */
export function oneOf(what: string, allowed: string[], got: string): ToolError {
  return invalid(`${what} must be one of ${allowed.join(", ")}, got ${JSON.stringify(got)}`);
}

/**
 * Takes the global flags out of a command's arguments (before `--`). A repeated global flag or a
 * missing value is USAGE.
 */
export function takeGlobals(args: string[]): { args: string[]; account?: string; tz?: string } {
  const dd = args.indexOf("--");
  const head = dd < 0 ? args : args.slice(0, dd);
  const tail = dd < 0 ? [] : args.slice(dd);
  const rest: string[] = [];
  const got: Record<string, string> = {};
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    const m = /^--(account|tz)(=(.*))?$/.exec(a);
    if (!m) {
      rest.push(a);
      continue;
    }
    const name = m[1];
    let value: string | undefined;
    if (m[2] !== undefined) value = m[3];
    else {
      value = head[i + 1];
      if (value === undefined || isFlagToken(value)) throw usage(`--${name} needs a value: --${name} ${GLOBAL_FLAGS[name].value}`);
      i++;
    }
    if (!value) throw usage(`--${name} needs a value: --${name} ${GLOBAL_FLAGS[name].value}`);
    if (got[name] !== undefined) throw usage(`--${name} is given more than once`);
    got[name] = value;
  }
  return { args: [...rest, ...tail], ...(got.account !== undefined ? { account: got.account } : {}), ...(got.tz !== undefined ? { tz: got.tz } : {}) };
}

/** Concise per-command help: usage, arguments, flags, examples. Rendered by hand in block form. */
export function renderHelp(spec: CommandSpec): string {
  const lines = [`command: ${spec.name}`, `description: ${spec.summary}`, `usage: ${usageLine(spec)}`];
  if (spec.positionals.length) {
    lines.push(`args[${spec.positionals.length}]:`);
    for (const p of spec.positionals) lines.push(`  <${p.name}>: ${p.required ? "" : "(optional) "}${p.desc}`);
  }
  const flags = Object.entries(spec.flags);
  const n = flags.length + (spec.jsonOut ? 1 : 0);
  if (n) {
    lines.push(`flags[${n}]:`);
    for (const [name, f] of flags) lines.push(`  --${name}${f.type === "bool" ? "" : ` ${f.value ?? "<value>"}`}: ${f.desc}`);
    if (spec.jsonOut)
      lines.push("  --json-out[=path]: also write the complete result as JSON to a file (bare: under the temp directory); standard output stays TOON");
  }
  lines.push("global_flags[3]:", `  --account <name>: ${GLOBAL_FLAGS.account.desc}`, `  --tz <iana>: ${GLOBAL_FLAGS.tz.desc}`, "  --help: this help");
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
    if (!extra.includes(f)) throw invalid(`unknown field ${JSON.stringify(f)} for \`${spec.name}\``, [`fields available: ${extra.join(", ")}`]);
  }
  return asked;
}
