// Per-user paths, resolved exactly as the daemon resolves them (specs/architecture.md,
// specs/socket-protocol.md). The CLI only stats and lists these; it never opens the daemon's files.
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const APP = "whatsapp-axi";
const ACCOUNT_RE = /^[a-z][a-z0-9-]{0,23}$/;

export function validAccount(name: string): boolean {
  return ACCOUNT_RE.test(name);
}

type Env = Record<string, string | undefined>;

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
}

export function roots(env: Env = process.env): Roots {
  const config = join(xdg(env, "XDG_CONFIG_HOME", ".config"), APP);
  const state = join(xdg(env, "XDG_STATE_HOME", join(".local", "state")), APP);
  const data = join(xdg(env, "XDG_DATA_HOME", join(".local", "share")), APP);
  return { config, state, data, runtime: runtimeRoot(env, state) };
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

export function accountPaths(account: string, r: Roots = roots()): AccountPaths {
  return {
    account,
    configDir: join(r.config, account),
    settings: join(r.config, account, "settings.json"),
    stateDir: join(r.state, account),
    socket: join(r.runtime, `${account}.sock`),
  };
}

/** The user's accounts: directories under <config> with a valid name and a settings.json. */
export function listAccounts(r: Roots = roots()): string[] {
  let names: string[];
  try {
    names = readdirSync(r.config);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((n) => validAccount(n))
    .filter((n) => {
      try {
        return statSync(join(r.config, n, "settings.json")).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

export function accountExists(account: string, r: Roots = roots()): boolean {
  try {
    return statSync(accountPaths(account, r).settings).isFile();
  } catch {
    return false;
  }
}
