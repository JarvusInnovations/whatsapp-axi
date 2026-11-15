// Finding the daemon binary (specs/distribution.md): $WHATSAPP_AXI_DAEMON, then a binary built in a
// source checkout next to the CLI, then the installed platform package.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { failure } from "./errors.js";

export function platformPackage(platform = process.platform, arch = process.arch): string | undefined {
  const os = platform === "linux" || platform === "darwin" ? platform : undefined;
  const cpu = arch === "x64" || arch === "arm64" ? arch : undefined;
  return os && cpu ? `whatsapp-axi-${os}-${cpu}` : undefined;
}

/** The package root of this CLI (holds package.json named whatsapp-axi). */
function packageRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { name?: string };
      if (pkg.name === "whatsapp-axi") return dir;
    } catch {
      // keep walking up
    }
    dir = dirname(dir);
  }
  return undefined;
}

export interface Lookup {
  env?: Record<string, string | undefined>;
  root?: string | undefined;
  resolvePackage?: (name: string) => string | undefined;
}

function defaultResolve(name: string): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

export function findDaemon(o: Lookup = {}): string {
  const env = o.env ?? process.env;
  const fromEnv = env.WHATSAPP_AXI_DAEMON;
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    throw failure(`WHATSAPP_AXI_DAEMON points at ${fromEnv}, which does not exist.`, "daemon_binary_missing", ["Unset it, or point it at a built whatsapp-axid"]);
  }
  const root = "root" in o ? o.root : packageRoot();
  if (root) {
    const local = join(root, "daemon", "bin", "whatsapp-axid");
    if (existsSync(local)) return local;
  }
  const pkg = platformPackage();
  if (pkg) {
    const dir = (o.resolvePackage ?? defaultResolve)(pkg);
    if (dir && existsSync(join(dir, "bin", "whatsapp-axid"))) return join(dir, "bin", "whatsapp-axid");
  }
  throw failure(
    pkg ? `No whatsapp-axid daemon binary found: the platform package ${pkg} is not installed.` : `No whatsapp-axid daemon binary found, and no platform package exists for ${process.platform}-${process.arch}.`,
    "daemon_binary_missing",
    [
      ...(pkg ? [`Reinstall whatsapp-axi so that its optional dependency ${pkg} is installed`] : []),
      "Or build from source: cd daemon && go build -o bin/whatsapp-axid ./cmd/whatsapp-axid (in a checkout of this repository)",
    ],
  );
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a one-shot daemon subcommand and captures its output. */
export function runDaemon(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e) => reject(failure(`Cannot run the daemon binary ${bin}: ${e.message}`, "daemon_binary_failed")));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** The daemon's own one-line error message, without its program prefix. */
export function daemonMessage(stderr: string): string {
  const line = stderr.trim().split("\n").pop() ?? "";
  return line.replace(/^whatsapp-axid [a-z]+: /, "");
}
