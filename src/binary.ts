// Finding the daemon binary (specs/distribution.md): $WHATSAPP_AXI_DAEMON, then a binary built in a
// source checkout next to the CLI, then the installed platform package.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { failure } from "./errors.js";

export function platformPackage(platform: string = process.platform, arch: string = process.arch): string | undefined {
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
  platform?: string;
  arch?: string;
}

function defaultResolve(name: string): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

export function findDaemon(envOrLookup: Record<string, string | undefined> | Lookup = {}): string {
  const o: Lookup =
    "env" in envOrLookup || "root" in envOrLookup || "resolvePackage" in envOrLookup || "platform" in envOrLookup
      ? (envOrLookup as Lookup)
      : { env: envOrLookup as Record<string, string | undefined> };
  const env = o.env ?? process.env;
  const fromEnv = env.WHATSAPP_AXI_DAEMON;
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    throw failure(`WHATSAPP_AXI_DAEMON points at ${fromEnv}, which does not exist.`, "DAEMON_BINARY_MISSING", [
      "Unset WHATSAPP_AXI_DAEMON, or point it at a built whatsapp-axid",
    ]);
  }
  const root = "root" in o ? o.root : packageRoot();
  if (root) {
    const local = join(root, "daemon", "bin", "whatsapp-axid");
    if (existsSync(local)) return local;
  }
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const pkg = platformPackage(platform, arch);
  if (pkg) {
    const dir = (o.resolvePackage ?? defaultResolve)(pkg);
    if (dir && existsSync(join(dir, "bin", "whatsapp-axid"))) return join(dir, "bin", "whatsapp-axid");
  }
  // A source checkout (the CLI's root holds daemon/go.mod) builds its own binary; an installed
  // package gets its platform package back from a reinstall, or uses a binary built from source.
  if (root && existsSync(join(root, "daemon", "go.mod"))) {
    throw failure("No whatsapp-axid daemon binary found: this source checkout has not built one.", "DAEMON_BINARY_MISSING", [
      "Run `bun run build:daemon` in the checkout to build daemon/bin/whatsapp-axid",
    ]);
  }
  throw failure(
    pkg
      ? `No whatsapp-axid daemon binary found: the platform package ${pkg} is not installed (an install with --omit=optional or --no-optional leaves it out).`
      : `No whatsapp-axid daemon binary found, and no platform package exists for ${platform}-${arch}.`,
    "DAEMON_BINARY_MISSING",
    [
      ...(pkg ? [`Run \`npm install -g whatsapp-axi\` to reinstall it with its optional dependency ${pkg}`] : []),
      `Or build from source: in a checkout of ${SOURCE} at this version's tag, run \`bun run build:daemon\` and set WHATSAPP_AXI_DAEMON to the daemon/bin/whatsapp-axid it builds`,
    ],
  );
}

const SOURCE = "https://github.com/JarvusInnovations/whatsapp-axi";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a one-shot daemon subcommand and captures its output. */
export function runDaemon(bin: string, args: string[], env: Record<string, string | undefined> = process.env): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e) =>
      reject(failure(`Cannot run the daemon binary ${bin}: ${e.message}`, "DAEMON_BINARY_FAILED", ["Run `whatsapp-axi doctor` to check the binary"])),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** The daemon's own one-line error message, without its program prefix. */
export function daemonMessage(stderr: string): string {
  const line = stderr.trim().split("\n").pop() ?? "";
  return line.replace(/^whatsapp-axid [a-z]+: /, "");
}
