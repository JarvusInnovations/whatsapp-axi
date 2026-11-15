// Per-user paths, resolved exactly as the daemon resolves them (specs/architecture.md,
// specs/conventions.md "Storage", specs/socket-protocol.md). Accounts live at
// <config>/accounts/<name>/ and <state>/accounts/<name>/; the default is <config>/config.json.
// The CLI stats and lists these; it never opens the daemon's databases.
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const APP = "whatsapp-axi";
const ACCOUNT_RE = /^[a-z][a-z0-9-]{0,23}$/;
/** Names an account may not take: the tool's own entries at the roots. */
export const RESERVED_NAMES = ["accounts", "config.json"];

export function validAccount(name: string): boolean {
  return ACCOUNT_RE.test(name) && !RESERVED_NAMES.includes(name);
}

export type Env = Record<string, string | undefined>;

/** A set environment variable: empty or whitespace-only is unset. */
export function envVar(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function xdg(env: Env, name: string, fallback: string): string {
  const v = env[name];
  if (v && isAbsolute(v)) return v;
  return join(env.HOME || homedir(), fallback);
}

export interface Roots {
  config: string;
  state: string;
  data: string;
  runtime: string;
  /** $XDG_CONFIG_HOME, where the user's systemd units live (not moved by WHATSAPP_AXI_CONFIG_DIR). */
  xdgConfig: string;
  /** Set when WHATSAPP_AXI_CONFIG_DIR chose the config root. */
  configFromEnv?: string;
}

export function roots(env: Env = process.env): Roots {
  const xdgConfig = xdg(env, "XDG_CONFIG_HOME", ".config");
  const override = envVar(env, "WHATSAPP_AXI_CONFIG_DIR");
  const useOverride = override !== undefined && isAbsolute(override);
  const config = useOverride ? override : join(xdgConfig, APP);
  const state = join(xdg(env, "XDG_STATE_HOME", join(".local", "state")), APP);
  const data = join(xdg(env, "XDG_DATA_HOME", join(".local", "share")), APP);
  return { config, state, data, runtime: runtimeRoot(env, state), xdgConfig, ...(useOverride ? { configFromEnv: override } : {}) };
}

function runtimeRoot(env: Env, state: string): string {
  const v = env.XDG_RUNTIME_DIR;
  if (v && isAbsolute(v)) return join(v, APP);
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const run = join("/run/user", String(uid));
    try {
      const st = statSync(run);
      if (st.isDirectory() && (st.mode & 0o777) === 0o700 && st.uid === uid) return join(run, APP);
    } catch {
      // not there: fall through
    }
  }
  return join(state, "run");
}

export interface AccountPaths {
  account: string;
  configDir: string;
  settings: string;
  stateDir: string;
  socket: string;
}

export function accountsDir(r: Roots): { config: string; state: string } {
  return { config: join(r.config, "accounts"), state: join(r.state, "accounts") };
}

export function accountPaths(account: string, r: Roots = roots()): AccountPaths {
  const d = accountsDir(r);
  return {
    account,
    configDir: join(d.config, account),
    settings: join(d.config, account, "settings.json"),
    stateDir: join(d.state, account),
    socket: join(r.runtime, `${account}.sock`),
  };
}

/** Where an account stood before the accounts/ level (specs/conventions.md "Moving an existing account"). */
export function legacyPaths(account: string, r: Roots): { configDir: string; stateDir: string } {
  return { configDir: join(r.config, account), stateDir: join(r.state, account) };
}

/** The default account's file. */
export function configFile(r: Roots): string {
  return join(r.config, "config.json");
}

/** One account found under <config>/accounts: readable, or one whose files cannot be read. */
export interface AccountEntry {
  name: string;
  /** Why its files cannot be read (CONFIG_INVALID), when they cannot. */
  problem?: string;
}

/** The accounts directory exists and cannot be read. */
export class ListError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path} cannot be read: ${reason}`);
  }
}

/**
 * The user's accounts: directories under <config>/accounts with a valid name. One whose
 * settings.json cannot be read is still an account, with a problem (fail closed: it counts toward
 * "more than one account" and is never skipped). A directory without settings.json, or a stray
 * file, is not one. A directory that cannot be read is a ListError, never "no accounts".
 */
export function listAccountEntries(r: Roots): AccountEntry[] {
  const dir = accountsDir(r).config;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw new ListError(dir, code ?? (err as Error).message);
  }
  const out: AccountEntry[] = [];
  for (const n of names.sort()) {
    if (!validAccount(n)) continue;
    try {
      if (!statSync(join(dir, n)).isDirectory()) continue;
    } catch (err) {
      out.push({ name: n, problem: `${join(dir, n)}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` });
      continue;
    }
    try {
      if (!statSync(join(dir, n, "settings.json")).isFile()) out.push({ name: n, problem: `${join(dir, n, "settings.json")} is not a file` });
      else out.push({ name: n });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      out.push({ name: n, problem: `${join(dir, n, "settings.json")}: ${code ?? (err as Error).message}` });
    }
  }
  return out;
}

/** Account names, readable or not. Throws ListError when the directory cannot be read. */
export function listAccounts(r: Roots = roots()): string[] {
  return listAccountEntries(r).map((e) => e.name);
}

export function accountExists(account: string, r: Roots = roots()): boolean {
  try {
    return statSync(accountPaths(account, r).configDir).isDirectory();
  } catch {
    return false;
  }
}

/** Accounts still in the old place, directly under a root. Never treated as accounts. */
export function legacyAccounts(r: Roots): string[] {
  const found = new Set<string>();
  const look = (root: string, marks: string[]) => {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    for (const n of names) {
      if (!validAccount(n)) continue;
      for (const m of marks) {
        try {
          statSync(join(root, n, m));
          found.add(n);
          break;
        } catch {
          // not this one
        }
      }
    }
  };
  look(r.config, ["settings.json"]);
  look(r.state, ["session.db", "store.db", "daemon.lock"]);
  return [...found].sort();
}
