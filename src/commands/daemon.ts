// daemon install|uninstall|start|stop|restart|status|logs|upgrade on Linux with systemd user
// services (specs/daemon.md "Keeping it running", specs/cli.md "The daemon"), and the service
// checks of doctor. Every call to the system goes through ctx.service.
import { copyFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { parse, type CommandSpec } from "../args.js";
import { daemonMessage, findDaemon, runDaemon } from "../binary.js";
import { failure, usage } from "../errors.js";
import { accountExists } from "../paths.js";
import { requireAccountName, type Ctx } from "../context.js";
import { installedBinary, TEMPLATE, unitDir, unitName, unitText, type ServiceManager, type UnitState } from "../service.js";
import { VERSION } from "../version.js";

type Obj = Record<string, unknown>;

function svc(ctx: Ctx): ServiceManager {
  const s = ctx.service;
  if (!s.supported()) {
    throw failure("The daemon service commands support Linux with systemd user services; macOS comes in a later release.", "unsupported_platform", [
      "Run the daemon in the foreground with `whatsapp-axi daemon run <name>`",
    ]);
  }
  return s;
}

function account(ctx: Ctx, name: string): string {
  requireAccountName(name);
  if (!accountExists(name, ctx.roots)) throw failure(`No account named ${name}.`, "no_account", [`Run \`whatsapp-axi account add ${name}\` to create it`]);
  return name;
}

/** Accounts with an enabled service instance for this user. */
export function installedAccounts(ctx: Ctx): string[] {
  try {
    return readdirSync(join(unitDir(ctx.roots), "default.target.wants"))
      .map((f) => /^whatsapp-axi@([a-z][a-z0-9-]{0,23})\.service$/.exec(f)?.[1])
      .filter((n): n is string => !!n)
      .sort();
  } catch {
    return [];
  }
}

function isInstalled(ctx: Ctx, name: string): boolean {
  return existsSync(join(unitDir(ctx.roots), TEMPLATE)) && installedAccounts(ctx).includes(name);
}

function notInstalled(name: string): AxiError {
  return failure(`Account ${name} is not installed as a service.`, "not_installed", [
    `Run \`whatsapp-axi daemon install ${name}\` to install it`,
    `Or run it in the foreground with \`whatsapp-axi daemon run ${name}\``,
  ]);
}

async function systemctl(s: ServiceManager, args: string[]): Promise<void> {
  const r = await s.systemctl(args);
  if (r.code !== 0) {
    const reason = r.stderr.trim().split("\n")[0] || `exit ${r.code}`;
    throw failure(`systemctl --user ${args.join(" ")} failed: ${reason}`, "service_failed", [
      "Check that the user service manager is running (it needs lingering or a login session)",
      "Run `whatsapp-axi doctor` for the service checks",
    ]);
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** Copies the daemon binary to its stable path atomically. Returns whether it changed. */
function placeBinary(src: string, dest: string): boolean {
  if (sameFile(src, dest)) return false;
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.new-${process.pid}`;
  copyFileSync(src, tmp);
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
  return true;
}

function writeUnit(path: string, text: string): boolean {
  try {
    if (readFileSync(path, "utf-8") === text) return false;
  } catch {
    // missing: write it
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.new-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
  return true;
}

async function lingerRefusal(s: ServiceManager): Promise<AxiError | undefined> {
  const on = await s.lingering();
  if (on === true) return undefined;
  const why = on === false ? `Lingering is off for user ${s.user()}` : `Lingering could not be confirmed for user ${s.user()}`;
  return failure(`${why}: without it the service stops, and its socket disappears, when the user's last login session ends.`, "linger_off", [
    `Run \`loginctl enable-linger ${s.user()}\` (some systems need sudo), then install again`,
    "Or pass --no-linger-check on a desktop where you are always logged in",
  ]);
}

/** How long install, start and restart wait for the service to be active and the daemon to answer. */
export const READY = { waitMs: 15_000, pollMs: 250 };

/**
 * Waits until the unit is active and the daemon answers on its socket. A unit that fails, or does
 * not get there in time, is exit 1 with its state and the log command (specs/daemon.md).
 */
async function waitReady(ctx: Ctx, s: ServiceManager, name: string, verb: string): Promise<UnitState> {
  const unit = unitName(name);
  const deadline = Date.now() + READY.waitMs;
  let st = await s.show(unit);
  let why = "";
  for (;;) {
    if (st.active === "active") {
      try {
        await ctx.daemon(name).status();
        return st;
      } catch (err) {
        if (!(err instanceof AxiError)) throw err;
        why = err.code === "daemon_not_running" ? "the daemon does not answer on its socket" : `the daemon answered ${err.code}: ${err.message}`;
      }
    } else if (st.active === "failed") {
      why = "the service failed";
      break;
    } else {
      why = `the service is ${st.active} (${st.sub})`;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, READY.pollMs));
    st = await s.show(unit);
  }
  throw failure(`daemon ${verb} ${name}: ${why}; the service is ${st.active} (${st.sub}).`, "service_not_ready", [
    `Run \`whatsapp-axi daemon logs ${name}\` to see why`,
    `Run \`whatsapp-axi daemon status ${name}\` for the service and the daemon together`,
  ]);
}

// ---- install ---------------------------------------------------------------

const NAME = { name: "name", required: true, desc: "the account" };

export const daemonInstallSpec: CommandSpec = {
  name: "daemon install",
  summary: "Install the daemon binary and the account's systemd user service, enable and start it",
  positionals: [NAME],
  flags: {
    "dry-run": { type: "bool", desc: "print the unit, the binary path and the commands, and change nothing" },
    "no-linger-check": { type: "bool", desc: "install even when lingering is off (desktops where you are always logged in)" },
  },
  examples: ["whatsapp-axi daemon install example --dry-run", "whatsapp-axi daemon install example"],
};

export async function daemonInstall(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(daemonInstallSpec, args);
  const name = account(ctx, p.pos[0]);
  const s = svc(ctx);
  const src = findDaemon();
  const dest = installedBinary(ctx.roots);
  const unitPath = join(unitDir(ctx.roots), TEMPLATE);
  const text = unitText(ctx.roots);
  const unit = unitName(name);
  const refusal = p.flags["no-linger-check"] ? undefined : await lingerRefusal(s);

  if (p.flags["dry-run"]) {
    const summary = {
      dry_run: true,
      account: name,
      binary: { from: src, to: dest },
      unit: { path: unitPath, instance: unit },
      lingering: (await s.lingering()) ?? "unknown",
      would_run: [`copy ${src} to ${dest} (mode 0755)`, `write ${unitPath}`, "systemctl --user daemon-reload", `systemctl --user enable --now ${unit}`],
      ...(refusal ? { would_refuse: refusal.message } : {}),
    };
    return `${encode(summary)}\nunit_file ${unitPath}:\n${text}`;
  }
  if (refusal) throw refusal;

  const before = await s.show(unit);
  if (before.active !== "active") {
    try {
      await ctx.daemon(name).status();
      throw failure(`The daemon of account ${name} is already running outside the service.`, "daemon_running", [
        "Stop the foreground daemon (Ctrl-C where `whatsapp-axi daemon run` runs), then install again",
      ]);
    } catch (err) {
      if (!(err instanceof AxiError) || err.code === "daemon_running") throw err;
      // not running, or not answering: fine
    }
  }
  const binaryChanged = placeBinary(src, dest);
  const unitChanged = writeUnit(unitPath, text);
  if (unitChanged) await systemctl(s, ["daemon-reload"]);
  const wasInstalled = installedAccounts(ctx).includes(name);
  await systemctl(s, ["enable", "--now", unit]);
  if (binaryChanged && before.active === "active") await systemctl(s, ["restart", unit]);
  const after = await waitReady(ctx, s, name, "install");
  const noop = !binaryChanged && !unitChanged && wasInstalled && before.active === "active";
  return {
    installed: noop ? `${name} already installed and running (no-op)` : name,
    unit,
    binary: dest,
    service: `${after.active} (${after.sub})`,
    help: [`Run \`whatsapp-axi daemon status ${name}\` to see the service and the daemon`, `Run \`whatsapp-axi daemon logs ${name}\` for its log`, `Run \`whatsapp-axi auth link --phone <number> --account ${name}\` if it is not linked yet`],
  };
}

// ---- uninstall -------------------------------------------------------------

export const daemonUninstallSpec: CommandSpec = {
  name: "daemon uninstall",
  summary: "Stop and remove the account's service; the account's files are left in place",
  positionals: [NAME],
  flags: { confirm: { type: "bool", desc: "required: confirms the removal" } },
  examples: ["whatsapp-axi daemon uninstall example --confirm"],
};

export async function daemonUninstall(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(daemonUninstallSpec, args);
  requireAccountName(p.pos[0]);
  const name = p.pos[0];
  if (!p.flags.confirm) throw usage("`daemon uninstall` stops and removes the service; add --confirm", [`whatsapp-axi daemon uninstall ${name} --confirm`]);
  const s = svc(ctx);
  const unit = unitName(name);
  const state = await s.show(unit);
  if (!installedAccounts(ctx).includes(name) && state.active !== "active") {
    return { uninstalled: `${name} is not installed (no-op)` };
  }
  await systemctl(s, ["disable", "--now", unit]);
  let template = "kept: other accounts use it";
  if (installedAccounts(ctx).length === 0) {
    rmSync(join(unitDir(ctx.roots), TEMPLATE), { force: true });
    await systemctl(s, ["daemon-reload"]);
    template = "removed";
  }
  return {
    uninstalled: name,
    template_unit: template,
    note: "the account's files and the installed binary are left in place",
    help: [`Run \`whatsapp-axi daemon run ${name}\` to run it in the foreground`, `Run \`whatsapp-axi account remove ${name} --confirm ${name}\` to delete the account`],
  };
}

// ---- start, stop, restart ----------------------------------------------------

function controlSpec(verb: string, summary: string): CommandSpec {
  return { name: `daemon ${verb}`, summary, positionals: [NAME], flags: {}, examples: [`whatsapp-axi daemon ${verb} example`] };
}

export const daemonStartSpec = controlSpec("start", "Start the account's service");
export const daemonStopSpec = controlSpec("stop", "Stop the account's service");
export const daemonRestartSpec = controlSpec("restart", "Restart the account's service");

export async function daemonControl(ctx: Ctx, args: string[], verb: "start" | "stop" | "restart"): Promise<unknown> {
  const spec = { start: daemonStartSpec, stop: daemonStopSpec, restart: daemonRestartSpec }[verb];
  const p = parse(spec, args);
  const name = account(ctx, p.pos[0]);
  const s = svc(ctx);
  if (!isInstalled(ctx, name)) throw notInstalled(name);
  const unit = unitName(name);
  const before = await s.show(unit);
  if (verb === "start" && before.active === "active") {
    await waitReady(ctx, s, name, verb);
    return { service: `${name} already running (no-op)` };
  }
  if (verb === "stop" && before.active !== "active" && before.active !== "activating") return { service: `${name} already stopped (no-op)` };
  await systemctl(s, [verb, unit]);
  const after = verb === "stop" ? await s.show(unit) : await waitReady(ctx, s, name, verb);
  return {
    service: `${name} ${after.active} (${after.sub})`,
    ...(verb === "stop" ? {} : { help: [`Run \`whatsapp-axi daemon status ${name}\` to see the daemon's state`] }),
  };
}

// ---- status ------------------------------------------------------------------

export const daemonStatusSpec = controlSpec("status", "The service's state and the daemon's state together");

export async function daemonStatus(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(daemonStatusSpec, args);
  const name = account(ctx, p.pos[0]);
  const s = svc(ctx);
  const unit = unitName(name);
  const installed = isInstalled(ctx, name);
  const st = await s.show(unit);
  const out: Obj = {
    service: { unit, installed, enabled: st.enabled || "unknown", active: st.active, sub: st.sub, since: st.since, pid: st.pid },
  };
  try {
    const ds = await ctx.daemon(name).status();
    out.daemon = { state: ds.state, since: ds.since, reason: ds.reason, version: ds.daemon_version };
  } catch (err) {
    if (!(err instanceof AxiError)) throw err;
    out.daemon = { state: err.code === "daemon_not_running" ? "not running" : `${err.code}: ${err.message}` };
  }
  if (!installed) out.help = [`Run \`whatsapp-axi daemon install ${name}\` to run it as a service`];
  else if (st.active !== "active") out.help = [`Run \`whatsapp-axi daemon start ${name}\``, `Run \`whatsapp-axi daemon logs ${name}\` to see why it stopped`];
  return out;
}

// ---- logs --------------------------------------------------------------------

export const daemonLogsSpec: CommandSpec = {
  name: "daemon logs",
  summary: "The daemon's log from the user journal",
  positionals: [NAME],
  flags: {
    lines: { type: "int", value: "<n>", desc: "how many recent lines (default 50, max 10000)" },
    follow: { type: "bool", desc: "keep printing new lines until Ctrl-C" },
  },
  examples: ["whatsapp-axi daemon logs example", "whatsapp-axi daemon logs example --lines 200 --follow"],
};

export async function daemonLogs(ctx: Ctx, args: string[], write: (s: string) => void, signal?: AbortSignal): Promise<unknown> {
  const p = parse(daemonLogsSpec, args);
  const name = account(ctx, p.pos[0]);
  const lines = (p.flags.lines as number | undefined) ?? 50;
  if (lines < 1 || lines > 10000) throw usage("--lines must be from 1 to 10000");
  const s = svc(ctx);
  const unit = unitName(name);
  const got: string[] = [];
  const follow = p.flags.follow === true;
  const r = await s.logs(unit, lines, follow, (l) => {
    if (!l.trim()) return;
    if (follow) write(`${encode({ log: [{ line: l }] })}\n`);
    else got.push(l);
  }, signal);
  if (r.code !== 0 && !signal?.aborted) {
    throw failure(`journalctl failed: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`, "logs_failed", ["Some systems keep no per-user journal; check `journalctl --user` works for this user"]);
  }
  if (follow) return { follow: "stopped" };
  const real = got.filter((l) => !l.startsWith("-- "));
  // journalctl can exit 0 having read nothing at all (no journal files, no permission). That is
  // a failure to read the log, never an empty log; only "-- No entries --" is a real empty one.
  if (real.length === 0 && !got.some((l) => l.startsWith("-- No entries")) && r.stderr.trim()) {
    throw failure(`journalctl read no log: ${r.stderr.trim().split("\n")[0]}`, "logs_failed", ["Some systems keep no per-user journal; check `journalctl --user` works for this user"]);
  }
  if (real.length === 0) return { log: `0 lines for ${unit}`, ...(isInstalled(ctx, name) ? {} : { help: [`Run \`whatsapp-axi daemon install ${name}\`; a foreground daemon logs to its terminal`] }) };
  return { unit, log: real.map((line) => ({ line })) };
}

// ---- upgrade -----------------------------------------------------------------

export const daemonUpgradeSpec: CommandSpec = {
  name: "daemon upgrade",
  summary: "Replace the installed daemon binary with this CLI's and restart the user's installed accounts",
  positionals: [],
  flags: {},
  examples: ["whatsapp-axi daemon upgrade"],
};

/** The version an installed binary reports, or null. */
export async function binaryVersion(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    const r = await runDaemon(path, ["version"]);
    if (r.code !== 0) return null;
    return /^whatsapp-axid (\S+)/m.exec(r.stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function daemonUpgrade(ctx: Ctx, args: string[]): Promise<unknown> {
  parse(daemonUpgradeSpec, args);
  const s = svc(ctx);
  const src = findDaemon();
  const dest = installedBinary(ctx.roots);
  const accounts = installedAccounts(ctx);
  if (!existsSync(dest) && accounts.length === 0) {
    return { upgrade: "no installed binary and 0 installed accounts (no-op)", help: ["Run `whatsapp-axi daemon install <name>` to install one"] };
  }
  const replaced = placeBinary(src, dest);
  const version = await binaryVersion(dest);
  if (!replaced) return { upgrade: `the installed binary is already this CLI's (no-op)`, binary: dest, version };
  const restarted: string[] = [];
  for (const a of accounts) {
    await systemctl(s, ["restart", unitName(a)]);
    restarted.push(a);
  }
  return {
    upgrade: "replaced",
    binary: dest,
    version,
    restarted: restarted.length ? restarted : "0 installed accounts",
    help: ["Run `whatsapp-axi doctor` to check that the versions now match"],
  };
}

// ---- doctor ------------------------------------------------------------------

export interface ServiceCheck {
  check: string;
  result: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

/** The service part of doctor: service installed, enabled and running; lingering; the installed binary. */
export async function serviceChecks(ctx: Ctx, name: string, runningVersion: string | null): Promise<ServiceCheck[]> {
  const s = ctx.service;
  if (!s.supported()) return [];
  const checks: ServiceCheck[] = [];
  const installed = isInstalled(ctx, name);
  const unit = unitName(name);
  let st: UnitState | undefined;
  if (installed) {
    st = await s.show(unit);
    checks.push(
      st.active === "active"
        ? { check: "service", result: "ok", detail: `${unit} installed, ${st.enabled || "enabled"}, ${st.active} (${st.sub})` }
        : { check: "service", result: "fail", detail: `${unit} installed but ${st.active} (${st.sub})`, fix: `whatsapp-axi daemon start ${name}` },
    );
  } else {
    checks.push({ check: "service", result: "warn", detail: "not installed as a service; a foreground daemon stops with its terminal", fix: `whatsapp-axi daemon install ${name}` });
  }
  const linger = await s.lingering();
  if (linger === true) checks.push({ check: "linger", result: "ok", detail: `lingering on for ${s.user()}` });
  else {
    checks.push({
      check: "linger",
      result: installed ? "fail" : "warn",
      detail: `lingering ${linger === false ? "off" : "unknown"} for ${s.user()}: the service stops when the last login session ends`,
      fix: `loginctl enable-linger ${s.user()}`,
    });
  }
  const bin = installedBinary(ctx.roots);
  const v = await binaryVersion(bin);
  if (v === null) {
    if (installed) checks.push({ check: "binary", result: "fail", detail: `${bin} is missing or does not run`, fix: "whatsapp-axi daemon upgrade" });
  } else if (v !== VERSION) {
    checks.push({ check: "binary", result: "warn", detail: `installed binary ${v}, cli ${VERSION}`, fix: "whatsapp-axi daemon upgrade" });
  } else if (runningVersion && runningVersion !== v) {
    checks.push({ check: "binary", result: "warn", detail: `installed binary ${v}, running daemon ${runningVersion}`, fix: `whatsapp-axi daemon restart ${name}` });
  } else {
    checks.push({ check: "binary", result: "ok", detail: `installed binary ${v} matches the cli${runningVersion ? " and the running daemon" : ""}` });
  }
  return checks;
}

export { daemonMessage };
