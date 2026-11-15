// setup hooks [status|uninstall] and session-start (specs/cli.md "Agent integrations"): a
// session-start hook for Claude Code, Codex and OpenCode. `setup hooks` is the only code path that
// writes a hook. The hook runs `whatsapp-axi session-start`, which is scoped by the project: it
// prints the accounts a project names in .whatsapp-axi.json, and nothing at all where there is no
// such file. It never prints message text, a sender, a chat name or a phone number, never hangs,
// and always exits 0.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { encode } from "@toon-format/toon";
import {
  computeCodexConfigUpdate,
  computeSessionStartHookUpdate,
  resolvePortableHookCommand,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
  type HookSettings,
  type SessionStartHookScope,
} from "axi-sdk-js";
import { parse, type CommandSpec } from "../args.js";
import { failure, usage } from "../errors.js";
import { accountExists, validAccount } from "../paths.js";
import type { Ctx } from "../context.js";

type Obj = Record<string, unknown>;

/** The marker that identifies this tool's hook entries in shared settings files. */
export const MARKER = "whatsapp-axi";
/** The project file that names the accounts the hook prints. */
export const PROJECT_FILE = ".whatsapp-axi.json";
/** Each account is asked with this limit; the hook's own timeout in the harness is larger. */
export const HOOK_ROW = { ms: 2_000 };
const HOOK_TIMEOUT_S = 10;
/** The SDK's managed-plugin marker, so its status and uninstall recognise the plugin file. */
const OPENCODE_MANAGED = `axi-sdk-js managed opencode plugin: ${MARKER}`;

type Scope = SessionStartHookScope;

function home(): string {
  return process.env.HOME || homedir();
}

/** The git work tree containing dir, or undefined. */
function gitRoot(dir: string): string | undefined {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/** Where session-start looks for .whatsapp-axi.json: --dir, else the git root, else the working directory. */
export function hookDir(dirFlag: unknown): string {
  if (typeof dirFlag === "string") return resolve(dirFlag);
  return gitRoot(process.cwd()) ?? process.cwd();
}

/** The project a project-scope hook is written to: --dir, else the git root; never the bare working directory. */
function projectTarget(dirFlag: unknown): string {
  if (typeof dirFlag === "string") return resolve(dirFlag);
  const root = gitRoot(process.cwd());
  if (!root) {
    throw failure("--scope project needs a project: the working directory is not in a git work tree, and no --dir was given.", "no_project", [
      "Run `whatsapp-axi setup hooks --scope project --dir <path>`, or run it inside the project's git work tree",
    ]);
  }
  return root;
}

interface Paths {
  claude: string;
  codex: string;
  codexConfig: string;
  opencode: string;
}

/** The files each agent reads, laid out exactly as the SDK lays them out. */
function paths(scope: Scope, project: string): Paths {
  const h = home();
  const root = scope === "project" ? project : h;
  return {
    claude: join(root, ".claude", "settings.json"),
    codex: join(root, ".codex", "hooks.json"),
    codexConfig: join(h, ".codex", "config.toml"),
    opencode: scope === "project" ? join(root, ".opencode", "plugins", `axi-${MARKER}.js`) : join(h, ".config", "opencode", "plugins", `axi-${MARKER}.js`),
  };
}

/**
 * The executable the hook runs: the bare name when `whatsapp-axi` on PATH is this very CLI (so a
 * project hook stays portable), else this CLI's absolute path. Every install recomputes it, so
 * installing again repairs a hook whose executable moved.
 */
export function hookExecutable(execPath = process.argv[1] ?? ""): string {
  return resolvePortableHookCommand(resolve(execPath), [MARKER], MARKER, {
    pathEntries: (process.env.PATH ?? "").split(delimiter).filter(Boolean),
    pathExtensions: [""],
    resolveRealPath: (p) => {
      try {
        return statSync(p).isFile() ? realpathSync(p) : undefined;
      } catch {
        return undefined;
      }
    },
  });
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The shell command of the Claude Code and Codex hooks. */
function hookCommand(exe: string): string {
  return `${shellQuote(exe)} session-start`;
}

function readJSON(path: string): HookSettings {
  if (!existsSync(path)) return {};
  const v = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
  return v as HookSettings;
}

/** The command of this tool's hook in a settings file, or undefined. */
function installedCommand(path: string): string | undefined {
  try {
    for (const g of readJSON(path).hooks?.SessionStart ?? []) {
      for (const h of g.hooks ?? []) if (typeof h.command === "string" && h.command.includes(MARKER)) return h.command;
    }
  } catch {
    // unreadable: reported by the SDK's status as not installed
  }
  return undefined;
}

function openCodePlugin(exe: string): string {
  return `// ${OPENCODE_MANAGED}
// Generated by whatsapp-axi setup hooks. Safe to edit only if you remove the managed marker above.
import { spawn } from "node:child_process";

const command = ${JSON.stringify(exe)};
const args = ["session-start"];
const timeoutMs = ${HOOK_TIMEOUT_S * 1000};

function run(cwd) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child;
    try {
      child = spawn(command, args, { cwd: cwd || process.cwd(), env: process.env, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGTERM");
      resolve("");
    }, timeoutMs);
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (c) => (out += c));
    child.on("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

function contextFor(directory) {
  const cache = new Map();
  return async (sessionID) => {
    const key = sessionID ?? "__global__";
    if (!cache.has(key)) cache.set(key, await run(directory));
    return cache.get(key);
  };
}

export default {
  id: "axi-whatsapp-axi",
  async setup(ctx) {
    const context = contextFor(ctx.location.directory);
    await ctx.session.hook("context", async (event) => {
      const text = await context(event.sessionID);
      if (text) event.system.push({ type: "text", text });
    });
  },
  async server({ directory }) {
    const context = contextFor(directory);
    return {
      "experimental.chat.system.transform": async (input, output) => {
        const text = await context(input.sessionID);
        if (text) output.system.push(text);
      },
    };
  },
};
`;
}

const SETUP_FLAGS = {
  scope: { type: "string" as const, value: "<scope>", desc: "user (default: every session of this user) or project (this project's agent config)" },
  dir: { type: "string" as const, value: "<path>", desc: "the project for --scope project (default: the git root of the working directory)" },
};

export const setupHooksSpec: CommandSpec = {
  name: "setup hooks",
  summary: "Install or repair the session-start hook for Claude Code, Codex and OpenCode (--scope user|project, default user). The only command that writes a hook",
  positionals: [],
  flags: SETUP_FLAGS,
  examples: ["whatsapp-axi setup hooks", "whatsapp-axi setup hooks --scope project"],
};

export const setupHooksStatusSpec: CommandSpec = {
  name: "setup hooks status",
  summary: "What is installed, for each agent, at a scope; and the accounts this project names",
  positionals: [],
  flags: SETUP_FLAGS,
  examples: ["whatsapp-axi setup hooks status", "whatsapp-axi setup hooks status --scope project"],
};

export const setupHooksUninstallSpec: CommandSpec = {
  name: "setup hooks uninstall",
  summary: "Remove the session-start hook at a scope; other hooks are left alone",
  positionals: [],
  flags: SETUP_FLAGS,
  examples: ["whatsapp-axi setup hooks uninstall", "whatsapp-axi setup hooks uninstall --scope project"],
};

function scopeOf(v: unknown): Scope {
  if (v === undefined || v === "user") return "user";
  if (v === "project") return "project";
  throw usage(`--scope must be user or project, got ${JSON.stringify(v)}`);
}

function scopeFlags(scope: Scope, dir: unknown): string {
  return scope === "project" ? ` --scope project${typeof dir === "string" ? ` --dir ${dir}` : ""}` : "";
}

/** The status rows, read through the SDK, with whether each runs this CLI. */
function statusRows(scope: Scope, project: string): Obj[] {
  const st = sessionStartHookStatus({ marker: MARKER, scope, projectDir: project, homeDir: home() });
  const want = hookCommand(hookExecutable());
  const p = paths(scope, project);
  const plugin = existsSync(p.opencode) ? readFileSync(p.opencode, "utf-8") : "";
  const rows: Obj[] = [
    { agent: "claude", installed: st.claude.installed, current: st.claude.installed ? installedCommand(st.claude.path) === want : null, path: st.claude.path },
    { agent: "codex", installed: st.codex.installed, current: st.codex.installed ? installedCommand(st.codex.path) === want && st.codex.userFeatureEnabled : null, path: st.codex.path },
    { agent: "opencode", installed: st.opencode.installed, current: st.opencode.installed ? plugin === openCodePlugin(hookExecutable()) : null, path: st.opencode.path },
  ];
  return rows;
}

function projectNote(project: string): string {
  const cfg = readProjectFile(project);
  if (cfg.kind === "ok") return cfg.accounts.length ? cfg.accounts.join(", ") : "none listed: the hook prints nothing";
  if (cfg.kind === "missing") return `no ${PROJECT_FILE}: the hook prints nothing here`;
  return `invalid ${PROJECT_FILE}: ${cfg.why}`;
}

/** `setup hooks`: writes or repairs every agent's hook, then verifies by reading status again. */
export async function setupHooks(_ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(setupHooksSpec, args);
  const scope = scopeOf(p.flags.scope);
  const project = scope === "project" ? projectTarget(p.flags.dir) : hookDir(p.flags.dir);
  const t = paths(scope, project);
  const exe = hookExecutable();
  const command = hookCommand(exe);
  const rerun = `whatsapp-axi setup hooks${scopeFlags(scope, p.flags.dir)}`;
  const errors: string[] = [];
  const changed: string[] = [];
  const write = (path: string, text: string) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      changed.push(path);
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`);
    }
  };
  for (const path of [t.claude, t.codex]) {
    let cur: HookSettings;
    try {
      cur = readJSON(path);
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`);
      continue;
    }
    const [next, did] = computeSessionStartHookUpdate(cur, { marker: MARKER, command, timeoutSeconds: HOOK_TIMEOUT_S });
    if (did) write(path, `${JSON.stringify(next, null, 2)}\n`);
  }
  // Codex runs hooks only with the user-level feature flag on.
  try {
    const toml = existsSync(t.codexConfig) ? readFileSync(t.codexConfig, "utf-8") : "";
    const [next, did] = computeCodexConfigUpdate(toml);
    if (did) write(t.codexConfig, next);
  } catch (e) {
    errors.push(`${t.codexConfig}: ${(e as Error).message}`);
  }
  const plugin = openCodePlugin(exe);
  const curPlugin = existsSync(t.opencode) ? readFileSync(t.opencode, "utf-8") : undefined;
  if (curPlugin !== undefined && !curPlugin.includes(OPENCODE_MANAGED)) errors.push(`${t.opencode}: exists and is not managed by whatsapp-axi; it was left alone`);
  else if (curPlugin !== plugin) write(t.opencode, plugin);

  const rows = statusRows(scope, project);
  if (errors.length) {
    throw failure(`setup hooks failed at ${scope} scope: ${errors.join("; ")}`, "setup_failed", [`Fix the file named above, then run \`${rerun}\` again`]);
  }
  const bad = rows.filter((r) => r.installed !== true || r.current !== true).map((r) => r.agent);
  if (bad.length) {
    throw failure(`setup hooks wrote the hook, but reading it back it is not installed and current for ${bad.join(", ")}.`, "setup_failed", [`Run \`whatsapp-axi setup hooks status${scopeFlags(scope, p.flags.dir)}\``]);
  }
  const help: string[] = [];
  if (!existsSync(join(project, PROJECT_FILE))) {
    help.push(`The hook prints nothing in a project until it names its accounts in ${PROJECT_FILE} at its root: {"accounts": ["<name>"]}`);
  }
  if (scope === "project" && exe !== MARKER) help.push("The hook runs this CLI by its absolute path, which other machines may not share; put whatsapp-axi on PATH and run setup hooks again for a portable project hook");
  help.push(`Run \`whatsapp-axi setup hooks uninstall${scopeFlags(scope, p.flags.dir)}\` to remove it`);
  return {
    status: changed.length ? `installed or repaired at ${scope} scope` : `already installed and current at ${scope} scope (no-op)`,
    command,
    hooks: rows,
    help,
  };
}

export async function setupHooksStatus(_ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(setupHooksStatusSpec, args);
  const scope = scopeOf(p.flags.scope);
  const project = scope === "project" ? projectTarget(p.flags.dir) : hookDir(p.flags.dir);
  const rows = statusRows(scope, project);
  const help: string[] = [];
  if (rows.some((r) => r.current === false)) help.push(`A hook does not run this CLI (or Codex hooks are off); run \`whatsapp-axi setup hooks${scopeFlags(scope, p.flags.dir)}\` to repair it`);
  if (!rows.some((r) => r.installed)) help.push(`Run \`whatsapp-axi setup hooks${scopeFlags(scope, p.flags.dir)}\` to install it`);
  return { scope, hooks: rows, project, accounts: projectNote(project), ...(help.length ? { help } : {}) };
}

export async function setupHooksUninstall(_ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(setupHooksUninstallSpec, args);
  const scope = scopeOf(p.flags.scope);
  const project = scope === "project" ? projectTarget(p.flags.dir) : hookDir(p.flags.dir);
  const before = statusRows(scope, project).filter((r) => r.installed).map((r) => r.agent);
  const errors: string[] = [];
  // The Codex feature flag is shared with other tools and stays on.
  uninstallSessionStartHooks({ marker: MARKER, scope, projectDir: project, homeDir: home(), onError: (m) => errors.push(m) });
  const after = statusRows(scope, project).filter((r) => r.installed).map((r) => r.agent);
  if (errors.length || after.length) {
    throw failure(`setup hooks uninstall did not finish at ${scope} scope: ${errors.length ? errors.join("; ") : `still installed for ${after.join(", ")}`}`, "setup_failed", [
      `Fix the file named above, then run \`whatsapp-axi setup hooks uninstall${scopeFlags(scope, p.flags.dir)}\` again`,
    ]);
  }
  if (!before.length) return { status: `not installed at ${scope} scope (no-op)` };
  return { status: `removed at ${scope} scope from ${before.join(", ")}`, help: [`Run \`whatsapp-axi setup hooks status${scopeFlags(scope, p.flags.dir)}\` to confirm`] };
}

// ---- session-start (what the hook runs) --------------------------------------------

type ProjectFile = { kind: "missing" } | { kind: "invalid"; why: string } | { kind: "ok"; accounts: string[] };

export function readProjectFile(dir: string): ProjectFile {
  const path = join(dir, PROJECT_FILE);
  if (!existsSync(path)) return { kind: "missing" };
  try {
    const v = JSON.parse(readFileSync(path, "utf-8")) as { accounts?: unknown };
    if (!v || typeof v !== "object" || !Array.isArray(v.accounts) || !v.accounts.every((a) => typeof a === "string")) {
      return { kind: "invalid", why: 'expected {"accounts": ["<name>", ...]}' };
    }
    return { kind: "ok", accounts: [...new Set(v.accounts as string[])] };
  } catch {
    return { kind: "invalid", why: "not valid JSON" };
  }
}

export const sessionStartSpec: CommandSpec = {
  name: "session-start",
  summary: "What the hook runs: one row per account named in the project's .whatsapp-axi.json (state, scope, events kept since the last run); nothing without the file; always exits 0",
  positionals: [],
  flags: { dir: { type: "string", value: "<path>", desc: "the project (default: the git root of the working directory, else the working directory)" } },
  examples: ["whatsapp-axi session-start"],
};

interface HookRow {
  account: string;
  state: string;
  scope: string | null;
  new_events: number | null;
}

/** The per-project record of the highest seq the hook has seen for each account. */
function seenPath(ctx: Ctx, project: string): string {
  const id = createHash("sha256").update(project).digest("hex").slice(0, 24);
  return join(ctx.roots.state, ".hook-seen", `${id}.json`);
}

function readSeen(path: string): Record<string, number> {
  try {
    const v = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number")) as Record<string, number>;
  } catch {
    return {};
  }
}

async function hookRow(ctx: Ctx, name: string, after: number): Promise<{ row: HookRow; seq?: number }> {
  if (!validAccount(name) || !accountExists(name, ctx.roots)) return { row: { account: name, state: "no such account", scope: null, new_events: null } };
  const d = ctx.daemon(name, HOOK_ROW.ms);
  const ask = async () => {
    const st = await d.status();
    const s = await d.call("GET", "/v1/settings");
    const scope = typeof (s.settings as Obj | undefined)?.scope === "string" ? ((s.settings as Obj).scope as string) : null;
    // Only counts: the events themselves are never printed.
    const ev = await d.call("GET", `/v1/events?after=${after}&limit=1`);
    const total = typeof ev.total === "number" ? ev.total : null;
    const latest = typeof ev.latest_seq === "number" ? ev.latest_seq : undefined;
    return { row: { account: name, state: st.state, scope, new_events: total }, seq: latest };
  };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<{ row: HookRow }>((r) => {
    timer = setTimeout(() => r({ row: { account: name, state: "not answering", scope: null, new_events: null } }), HOOK_ROW.ms + 100);
  });
  try {
    return await Promise.race([
      ask().catch((err: unknown) => {
        const code = (err as { code?: string }).code ?? "internal";
        const state = code === "daemon_not_running" ? "stopped" : code === "daemon_timeout" ? "not answering" : `error (${code})`;
        return { row: { account: name, state, scope: null, new_events: null } };
      }),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The hook's output, or "" for nothing. Never throws. */
export async function hookOutput(ctx: Ctx, dir: string): Promise<string> {
  const cfg = readProjectFile(dir);
  if (cfg.kind === "missing") return "";
  if (cfg.kind === "invalid") return `${encode({ whatsapp_axi: `${PROJECT_FILE} is invalid: ${cfg.why}` })}\n`;
  if (cfg.accounts.length === 0) return "";
  const path = seenPath(ctx, dir);
  const seen = readSeen(path);
  const results = await Promise.all(cfg.accounts.map((a) => hookRow(ctx, a, seen[a] ?? 0)));
  let moved = false;
  for (const [i, r] of results.entries()) {
    if (r.seq !== undefined && r.seq !== seen[cfg.accounts[i]]) {
      seen[cfg.accounts[i]] = r.seq;
      moved = true;
    }
  }
  if (moved) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(seen)}\n`, { mode: 0o600 });
    } catch {
      // the next run counts from the last record it could write
    }
  }
  const rows = results.map((r) => r.row);
  const out: Obj = { whatsapp_axi: rows };
  const help = ["Run `whatsapp-axi events --account <name>` to read what was kept"];
  if (rows.some((r) => r.state === "stopped")) help.push("Run `whatsapp-axi doctor` for a stopped account");
  out.help = help;
  return `${encode(out)}\n`;
}
