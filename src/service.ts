// The service manager behind the daemon commands (specs/daemon.md "Keeping it running", Linux):
// systemd user services from a template unit, and lingering. Everything that touches the system
// goes through ServiceManager, so tests use a fake and `--dry-run` changes nothing.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Roots } from "./paths.js";

export const TEMPLATE = "whatsapp-axi@.service";

export function unitName(account: string): string {
  return `whatsapp-axi@${account}.service`;
}

/** Where the user's units live: $XDG_CONFIG_HOME/systemd/user. */
export function unitDir(r: Roots): string {
  return join(dirname(r.config), "systemd", "user");
}

/** The stable path service units run the daemon from (never a package directory). */
export function installedBinary(r: Roots): string {
  return join(r.data, "bin", "whatsapp-axid");
}

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The template unit. The XDG base directories are written in, so the service resolves the same
 * paths as the CLI that installed it; the runtime directory comes from the user manager.
 */
export function unitText(r: Roots): string {
  return [
    "# Written by whatsapp-axi daemon install. One instance per account: whatsapp-axi@<account>.service",
    "[Unit]",
    "Description=whatsapp-axi daemon for account %i",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `Environment=${q(`XDG_CONFIG_HOME=${dirname(r.config)}`)}`,
    `Environment=${q(`XDG_STATE_HOME=${dirname(r.state)}`)}`,
    `Environment=${q(`XDG_DATA_HOME=${dirname(r.data)}`)}`,
    `ExecStart=${q(installedBinary(r))} run --account %i`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface UnitState {
  /** active, inactive, failed, activating, ... */
  active: string;
  /** the sub-state: running, dead, auto-restart, ... */
  sub: string;
  /** enabled, disabled, static, or "" when the unit is unknown */
  enabled: string;
  since: string | null;
  pid: number | null;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ServiceManager {
  /** Whether this platform has the service manager the commands use. */
  supported(): boolean;
  user(): string;
  /** Lingering for the user: true, false, or undefined when it cannot be told. */
  lingering(): Promise<boolean | undefined>;
  /** Runs `systemctl --user <args>`. */
  systemctl(args: string[]): Promise<CommandResult>;
  show(unit: string): Promise<UnitState>;
  /** Runs `journalctl --user` for a unit; with follow, calls line for each new line until the signal. */
  logs(unit: string, lines: number, follow: boolean, line: (s: string) => void, signal?: AbortSignal): Promise<CommandResult>;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, onLine?: (s: string) => void, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], signal });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: (e as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let buf = "";
    child.stdout.on("data", (c: Buffer) => {
      const s = c.toString();
      stdout += onLine ? "" : s;
      if (onLine) {
        buf += s;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
    });
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.name === "AbortError") resolve({ code: 0, stdout, stderr });
      else resolve({ code: e.code === "ENOENT" ? 127 : 1, stdout, stderr: stderr || e.message });
    });
    child.on("close", (code) => {
      if (onLine && buf) onLine(buf);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * The environment for calls to the user's service manager. From a shell without a login session
 * XDG_RUNTIME_DIR can be missing; it is set when the user's runtime directory exists.
 */
export function managerEnv(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.()): NodeJS.ProcessEnv {
  if (env.XDG_RUNTIME_DIR || uid === undefined) return env;
  const dir = `/run/user/${uid}`;
  try {
    if (statSync(dir).isDirectory()) return { ...env, XDG_RUNTIME_DIR: dir };
  } catch {
    // not there
  }
  return env;
}

export class SystemdUser implements ServiceManager {
  supported(): boolean {
    return process.platform === "linux";
  }

  user(): string {
    return userInfo().username;
  }

  async lingering(): Promise<boolean | undefined> {
    const name = this.user();
    if (existsSync(`/var/lib/systemd/linger/${name}`)) return true;
    const r = await run("loginctl", ["show-user", name, "--property=Linger", "--value"], managerEnv());
    if (r.code !== 0) return existsSync("/var/lib/systemd/linger") ? false : undefined;
    return r.stdout.trim() === "yes";
  }

  systemctl(args: string[]): Promise<CommandResult> {
    return run("systemctl", ["--user", ...args], managerEnv());
  }

  async show(unit: string): Promise<UnitState> {
    const r = await this.systemctl(["show", unit, "--property=ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestamp"]);
    const props: Record<string, string> = {};
    for (const line of r.stdout.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const pid = Number(props.MainPID);
    return {
      active: props.ActiveState || "unknown",
      sub: props.SubState || "",
      enabled: props.UnitFileState || "",
      since: props.ActiveEnterTimestamp || null,
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    };
  }

  logs(unit: string, lines: number, follow: boolean, line: (s: string) => void, signal?: AbortSignal): Promise<CommandResult> {
    const args = ["--user", "-u", unit, "-n", String(lines), "--no-pager", "-o", "short-iso"];
    if (follow) args.push("-f");
    return run("journalctl", args, managerEnv(), line, signal);
  }
}
