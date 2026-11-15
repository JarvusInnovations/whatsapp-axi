// setup hooks [status|uninstall] and session-start (specs/cli.md "Agent integrations",
// specs/conventions.md "Home, hook and doctor"): a session-start hook for Claude Code, Codex and
// OpenCode. `setup hooks` is the only code path that writes a hook, and writes each file
// atomically. The hook runs `whatsapp-axi session-start`, which is scoped by the project: it prints
// the accounts a project names in .whatsapp-axi.json, and nothing at all where there is no such
// file. It reads only and writes nothing, never prints message text, a sender, a chat name or a
// phone number, never hangs, and always exits 0.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { computeCodexConfigUpdate, computeSessionStartHookUpdate, resolvePortableHookCommand, uninstallSessionStartHooks, type HookSettings, type SessionStartHookScope } from "axi-sdk-js";
import { oneOf, parse, type CommandSpec } from "../flags.js";
import { failure, invalid, reasonOf } from "../errors.js";
import { envVar, listAccounts, validAccount } from "../paths.js";
import type { Ctx } from "../context.js";
import { line } from "../output/toon.js";

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
const DAY_MS = 24 * 60 * 60 * 1000;
export const DISABLE_VAR = "WHATSAPP_AXI_DISABLE_HOOKS";
const RESTART = "Restart your agent session to load the hook";

type Scope = SessionStartHookScope;

function home(ctx: Ctx): string {
  return ctx.io.env.HOME || homedir();
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
export function hookDir(dirFlag: unknown, cwd = process.cwd()): string {
  if (typeof dirFlag === "string") return resolve(cwd, dirFlag);
  return gitRoot(cwd) ?? cwd;
}

/** The project a project-scope hook is written to: --dir, else the git root; never the bare working directory. */
function projectTarget(ctx: Ctx, dirFlag: unknown): string {
  if (typeof dirFlag === "string") return resolve(ctx.io.cwd, dirFlag);
  const root = gitRoot(ctx.io.cwd);
  if (!root) {
    throw failure("--scope project needs a project: the working directory is not in a git work tree, and no --dir was given.", "NO_PROJECT", [
      "Run `whatsapp-axi setup hooks --scope project --dir <path>` to name the project",
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
function paths(ctx: Ctx, scope: Scope, project: string): Paths {
  const h = home(ctx);
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
export function hookExecutable(execPath = process.argv[1] ?? "", env: Record<string, string | undefined> = process.env): string {
  return resolvePortableHookCommand(resolve(execPath), [MARKER], MARKER, {
    pathEntries: (env.PATH ?? "").split(delimiter).filter(Boolean),
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

/** A settings file: {} when missing; throws when it exists and cannot be read or parsed. */
function readJSON(path: string): HookSettings {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("is not valid JSON; it was left as it is");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("is not a JSON object; it was left as it is");
  return v as HookSettings;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
}

/** The command of this tool's hook in a settings object, or undefined. */
function ourCommand(s: HookSettings): string | undefined {
  for (const g of s.hooks?.SessionStart ?? []) {
    for (const h of g.hooks ?? []) if (typeof h.command === "string" && h.command.includes(MARKER)) return h.command;
  }
  return undefined;
}

/** Writes a file atomically: a temp file beside it, then a rename. Keeps an existing file's mode. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o644;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${path}.whatsapp-axi-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
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
  scope: { type: "string" as const, value: "<scope>", desc: "user (default: every session of this user) or project (this project's agent config)", values: ["user", "project"] },
  dir: { type: "string" as const, value: "<path>", desc: "the project for --scope project (default: the git root of the working directory)" },
};

export const setupHooksSpec: CommandSpec = {
  name: "setup hooks",
  summary: "Install or repair the session-start hook for Claude Code, Codex and OpenCode (--scope user|project, default user). The only command that writes a hook",
  positionals: [],
  flags: SETUP_FLAGS,
  examples: ["whatsapp-axi setup hooks", "whatsapp-axi setup hooks --scope project"],
  account: "none",
};

export const setupHooksStatusSpec: CommandSpec = {
  name: "setup hooks status",
  summary: "Each agent's hook at a scope (installed, stale, absent or error), and the accounts this project names",
  positionals: [],
  flags: SETUP_FLAGS,
  examples: ["whatsapp-axi setup hooks status", "whatsapp-axi setup hooks status --scope project"],
  account: "none",
};

export const setupHooksUninstallSpec: CommandSpec = {
  name: "setup hooks uninstall",
  summary: "Remove the session-start hook at a scope; other hooks are left alone",
  positionals: [],
  flags: SETUP_FLAGS,
  examples: ["whatsapp-axi setup hooks uninstall", "whatsapp-axi setup hooks uninstall --scope project"],
  account: "none",
};

function scopeOf(v: unknown): Scope {
  if (v === undefined || v === "user") return "user";
  if (v === "project") return "project";
  throw oneOf("--scope", ["user", "project"], String(v));
}

function scopeFlags(scope: Scope, dir: unknown): string {
  return scope === "project" ? ` --scope project${typeof dir === "string" ? ` --dir ${shellQuote(dir)}` : ""}` : "";
}

function noAccount(ctx: Ctx, name: string): void {
  if (ctx.accountFlag !== undefined) {
    throw invalid(`\`${name}\` acts on agents' settings, not on an account; --account does not apply`, [`Name the project's accounts in ${PROJECT_FILE} at its root: {"accounts": ["<name>"]}`]);
  }
}

export type HookState = "installed" | "stale" | "absent" | "error";

export interface HookStatus {
  rows: { agent: string; status: HookState; path: string }[];
  problems: { path: string; problem: string }[];
}

/** Each agent's hook, read from its file: installed (current), stale, absent, or error (unreadable). */
export function hookStatus(ctx: Ctx, scope: Scope, project: string): HookStatus {
  const p = paths(ctx, scope, project);
  const exe = hookExecutable(process.argv[1], ctx.io.env);
  const want = hookCommand(exe);
  const problems: HookStatus["problems"] = [];
  const settingsRow = (agent: string, path: string, extra?: () => boolean): HookStatus["rows"][number] => {
    let s: HookSettings;
    try {
      s = readJSON(path);
    } catch (err) {
      problems.push({ path, problem: (err as Error).message });
      return { agent, status: "error", path };
    }
    const cmd = ourCommand(s);
    if (cmd === undefined) return { agent, status: "absent", path };
    let current = cmd === want;
    if (current && extra) {
      try {
        current = extra();
      } catch (err) {
        problems.push({ path: p.codexConfig, problem: (err as Error).message });
        return { agent, status: "error", path };
      }
    }
    return { agent, status: current ? "installed" : "stale", path };
  };
  const codexFeature = () => {
    const toml = readText(p.codexConfig) ?? "";
    return !computeCodexConfigUpdate(toml)[1];
  };
  const rows = [settingsRow("claude", p.claude), settingsRow("codex", p.codex, codexFeature)];
  let plugin: string | undefined;
  try {
    plugin = readText(p.opencode);
  } catch (err) {
    problems.push({ path: p.opencode, problem: (err as Error).message });
    rows.push({ agent: "opencode", status: "error", path: p.opencode });
    return { rows, problems };
  }
  if (plugin === undefined) rows.push({ agent: "opencode", status: "absent", path: p.opencode });
  else if (!plugin.includes(OPENCODE_MANAGED)) {
    problems.push({ path: p.opencode, problem: "exists and is not managed by whatsapp-axi" });
    rows.push({ agent: "opencode", status: "error", path: p.opencode });
  } else rows.push({ agent: "opencode", status: plugin === openCodePlugin(exe) ? "installed" : "stale", path: p.opencode });
  return { rows, problems };
}

function projectNote(project: string): string {
  const cfg = readProjectFile(project);
  if (cfg.kind === "ok") return cfg.accounts.length ? cfg.accounts.join(", ") : "none listed: the hook prints nothing";
  if (cfg.kind === "missing") return `no ${PROJECT_FILE}: the hook prints nothing here`;
  return `invalid ${PROJECT_FILE}: ${cfg.why}`;
}

function disabled(ctx: Ctx): boolean {
  return envVar(ctx.io.env, DISABLE_VAR) !== undefined;
}

/** `setup hooks`: writes or repairs every agent's hook atomically, then verifies by reading status again. */
export async function setupHooks(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(setupHooksSpec, args);
  noAccount(ctx, "setup hooks");
  const scope = scopeOf(p.flags.scope);
  const project = scope === "project" ? projectTarget(ctx, p.flags.dir) : hookDir(p.flags.dir, ctx.io.cwd);
  if (disabled(ctx)) return { action: "unchanged", reason: `${DISABLE_VAR} is set: no hook file was written (no-op)`, scope };
  const t = paths(ctx, scope, project);
  const exe = hookExecutable(process.argv[1], ctx.io.env);
  const command = hookCommand(exe);
  const rerun = `whatsapp-axi setup hooks${scopeFlags(scope, p.flags.dir)}`;
  const errors: { path: string; problem: string }[] = [];
  const written: string[] = [];
  const write = (path: string, text: string) => {
    try {
      writeAtomic(path, text);
      written.push(path);
    } catch (e) {
      errors.push({ path, problem: (e as NodeJS.ErrnoException).code ?? (e as Error).message });
    }
  };
  for (const path of [t.claude, t.codex]) {
    let cur: HookSettings;
    try {
      cur = readJSON(path);
    } catch (e) {
      errors.push({ path, problem: (e as Error).message });
      continue;
    }
    const [next, did] = computeSessionStartHookUpdate(cur, { marker: MARKER, command, timeoutSeconds: HOOK_TIMEOUT_S });
    if (did) write(path, `${JSON.stringify(next, null, 2)}\n`);
  }
  // Codex runs hooks only with the user-level feature flag on.
  try {
    const [next, did] = computeCodexConfigUpdate(readText(t.codexConfig) ?? "");
    if (did) write(t.codexConfig, next);
  } catch (e) {
    errors.push({ path: t.codexConfig, problem: (e as Error).message });
  }
  const plugin = openCodePlugin(exe);
  try {
    const cur = readText(t.opencode);
    if (cur !== undefined && !cur.includes(OPENCODE_MANAGED)) errors.push({ path: t.opencode, problem: "exists and is not managed by whatsapp-axi; it was left alone" });
    else if (cur !== plugin) write(t.opencode, plugin);
  } catch (e) {
    errors.push({ path: t.opencode, problem: (e as Error).message });
  }

  const st = hookStatus(ctx, scope, project);
  const bad = st.rows.filter((r) => r.status !== "installed");
  const hooks = st.rows.map((r) => ({ agent: r.agent, status: r.status, path: r.path }));
  if (errors.length || bad.length) {
    const some = st.rows.some((r) => r.status === "installed");
    ctx.exitCode = 1;
    const problems = [...errors, ...st.problems.filter((x) => !errors.some((e) => e.path === x.path))];
    return {
      status: some ? "partly installed (see errors)" : "not installed (see errors)",
      scope,
      hooks,
      ...(problems.length ? { errors: problems } : {}),
      error: `setup hooks did not finish at ${scope} scope: ${bad.map((r) => `${r.agent} is ${r.status}`).join(", ") || "a file could not be written"}`,
      code: "SETUP_FAILED",
      help: [`Run \`${rerun}\` again after fixing the files named in errors`, ...(written.length ? [RESTART] : [])],
    };
  }
  const help: string[] = [];
  if (written.length) help.push(RESTART);
  if (!existsSync(join(project, PROJECT_FILE))) {
    help.push(`Name a project's accounts in ${PROJECT_FILE} at its root ({"accounts": ["<name>"]}): the hook prints nothing in a project without it`);
  }
  if (scope === "project" && exe !== MARKER) help.push("Run `whatsapp-axi setup hooks --scope project` again once whatsapp-axi is on PATH: the hook now runs this CLI by an absolute path other machines may not share");
  help.push(`Run \`whatsapp-axi setup hooks uninstall${scopeFlags(scope, p.flags.dir)}\` to undo`);
  if (!written.length) return { action: "unchanged", reason: `already installed and current at ${scope} scope (no-op)`, scope, hooks, help };
  return { action: "installed", scope, command, hooks, help };
}

export async function setupHooksStatus(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(setupHooksStatusSpec, args);
  noAccount(ctx, "setup hooks status");
  const scope = scopeOf(p.flags.scope);
  const project = scope === "project" ? projectTarget(ctx, p.flags.dir) : hookDir(p.flags.dir, ctx.io.cwd);
  const st = hookStatus(ctx, scope, project);
  const help: string[] = [];
  if (st.rows.some((r) => r.status === "stale" || r.status === "absent")) help.push(`Run \`whatsapp-axi setup hooks${scopeFlags(scope, p.flags.dir)}\` to install or repair it`);
  if (st.problems.length) ctx.exitCode = 1;
  return {
    scope,
    hooks: st.rows,
    ...(st.problems.length ? { problems: st.problems } : {}),
    project,
    accounts: projectNote(project),
    ...(help.length ? { help } : {}),
  };
}

export async function setupHooksUninstall(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(setupHooksUninstallSpec, args);
  noAccount(ctx, "setup hooks uninstall");
  const scope = scopeOf(p.flags.scope);
  const project = scope === "project" ? projectTarget(ctx, p.flags.dir) : hookDir(p.flags.dir, ctx.io.cwd);
  if (disabled(ctx)) return { action: "unchanged", reason: `${DISABLE_VAR} is set: no hook file was changed (no-op)`, scope };
  const before = hookStatus(ctx, scope, project);
  const present = before.rows.filter((r) => r.status === "installed" || r.status === "stale").map((r) => r.agent);
  const errors: string[] = [];
  // The Codex feature flag is shared with other tools and stays on.
  uninstallSessionStartHooks({ marker: MARKER, scope, projectDir: project, homeDir: home(ctx), onError: (m) => errors.push(m) });
  const after = hookStatus(ctx, scope, project);
  const left = after.rows.filter((r) => r.status === "installed" || r.status === "stale").map((r) => r.agent);
  if (errors.length || left.length) {
    throw failure(`setup hooks uninstall did not finish at ${scope} scope: ${errors.length ? errors.join("; ") : `still installed for ${left.join(", ")}`}`, "SETUP_FAILED", [
      `Run \`whatsapp-axi setup hooks uninstall${scopeFlags(scope, p.flags.dir)}\` again after fixing the files named above`,
    ]);
  }
  if (!present.length) return { action: "unchanged", reason: `not installed at ${scope} scope (no-op)`, scope };
  return { action: "uninstalled", scope, agents: present.join(", "), help: [RESTART, `Run \`whatsapp-axi setup hooks${scopeFlags(scope, p.flags.dir)}\` to undo`] };
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
  summary: "What the hook runs: one row per account named in the project's .whatsapp-axi.json (state, scope, events kept in the last 24 hours); nothing without the file; writes nothing; always exits 0",
  positionals: [],
  flags: { dir: { type: "string", value: "<path>", desc: "the project (default: the git root of the working directory, else the working directory)" } },
  examples: ["whatsapp-axi session-start"],
  account: "none",
};

interface HookRow {
  account: string;
  state: string;
  scope: string;
  events_24h: number | string;
}

async function hookRow(ctx: Ctx, name: string, names: string[]): Promise<HookRow> {
  if (!validAccount(name) || !names.includes(name)) return { account: name, state: "unknown (NO_ACCOUNT: no such account)", scope: "?", events_24h: "?" };
  const d = ctx.daemon(name, HOOK_ROW.ms);
  const since = new Date(ctx.io.now() - DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const ask = async (): Promise<HookRow> => {
    const st = await d.status();
    const s = await d.call("GET", "/v1/settings");
    const scope = typeof (s.settings as Obj | undefined)?.scope === "string" ? ((s.settings as Obj).scope as string) : "unknown (UNEXPECTED_RESPONSE: settings without a scope)";
    // Only a count: the events themselves are never printed.
    const ev = await d.call("GET", `/v1/events?since=${encodeURIComponent(since)}&limit=1`);
    const total = typeof ev.total === "number" ? ev.total : "unknown (UNEXPECTED_RESPONSE: no total)";
    return { account: name, state: st.state, scope, events_24h: total };
  };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<HookRow>((r) => {
    timer = setTimeout(() => r({ account: name, state: `unavailable (TIMEOUT: no answer in ${HOOK_ROW.ms / 1000} s)`, scope: "?", events_24h: "?" }), HOOK_ROW.ms + 100);
  });
  try {
    return await Promise.race([ask().catch((err: unknown): HookRow => ({ account: name, state: `unavailable (${reasonOf(err)})`, scope: "?", events_24h: "?" })), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The hook's output, or "" for nothing. Never throws, never writes. */
export async function hookOutput(ctx: Ctx, dir: string): Promise<string> {
  try {
    const cfg = readProjectFile(dir);
    if (cfg.kind === "missing") return "";
    if (cfg.kind === "invalid") return line({ whatsapp_axi: `${PROJECT_FILE} is invalid: ${cfg.why}` });
    if (cfg.accounts.length === 0) return "";
    let names: string[];
    try {
      names = listAccounts(ctx.roots);
    } catch (err) {
      return line({ whatsapp_axi: `unavailable (CONFIG_INVALID: ${(err as Error).message})`, help: ["Run `whatsapp-axi doctor` to see what is wrong and the fix"] });
    }
    const rows = await Promise.all(cfg.accounts.map((a) => hookRow(ctx, a, names)));
    const help = [`Run \`whatsapp-axi events${names.length > 1 ? " --account <name>" : ""}\` to read what was kept`];
    if (rows.some((r) => r.state.startsWith("unavailable") || r.state.startsWith("unknown"))) help.push("Run `whatsapp-axi doctor` to see what is wrong and the fix");
    return line({ whatsapp_axi: rows, help });
  } catch {
    return "";
  }
}
