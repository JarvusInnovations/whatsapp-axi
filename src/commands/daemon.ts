// daemon install|uninstall|start|stop|restart|status|logs|upgrade on Linux with systemd user
// services (specs/daemon.md "Keeping it running", specs/cli.md "The daemon"), and the service
// checks of doctor. Every call to the system goes through ctx.service.
import { copyFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parse, type CommandSpec } from "../flags.js";
import { daemonMessage, findDaemon, runDaemon } from "../binary.js";
import { confirmRequired, failure, invalid, reasonOf, type ToolError } from "../errors.js";
import { pinOf, PIN_VAR } from "../config.js";
import { account, time, type Ctx } from "../context.js";
import { installedBinary, TEMPLATE, unitDir, unitName, unitText, type ServiceManager, type UnitState } from "../service.js";
import { line } from "../output/toon.js";

type Obj = Record<string, unknown>;

function svc(ctx: Ctx): ServiceManager {
  const s = ctx.service;
  if (!s.supported()) {
    throw failure("The daemon service commands support Linux with systemd user services; macOS comes in a later release.", "UNSUPPORTED_PLATFORM", [
      "Run `whatsapp-axi daemon run <name>` to run the daemon in the foreground instead",
    ]);
  }
  return s;
}

/**
 * Accounts with an enabled service instance for this user. A missing directory is none; one that
 * cannot be read is SERVICE_FAILED, never "not installed".
 */
export function installedAccounts(ctx: Ctx): string[] {
  const dir = join(unitDir(ctx.roots), "default.target.wants");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw failure(`The user's service directory ${dir} cannot be read (${code ?? (err as Error).message}).`, "SERVICE_FAILED", [
      "Run `whatsapp-axi doctor` for the service checks",
    ]);
  }
  return names
    .map((f) => /^whatsapp-axi@([a-z][a-z0-9-]{0,23})\.service$/.exec(f)?.[1])
    .filter((n): n is string => !!n)
    .sort();
}

function isInstalled(ctx: Ctx, name: string): boolean {
  return installedAccounts(ctx).includes(name) && existsSync(join(unitDir(ctx.roots), TEMPLATE));
}

function notInstalled(name: string): AxiError {
  return failure(`Account ${name} is not installed as a service.`, "NOT_INSTALLED", [
    `Run \`whatsapp-axi daemon install ${name}\` to install it`,
    `Run \`whatsapp-axi daemon run ${name}\` to run it in the foreground instead`,
  ]);
}

async function systemctl(s: ServiceManager, args: string[]): Promise<void> {
  const r = await s.systemctl(args);
  if (r.code !== 0) {
    const reason = r.stderr.trim().split("\n")[0] || `exit ${r.code}`;
    throw failure(`systemctl --user ${args.join(" ")} failed: ${reason}`, "SERVICE_FAILED", [
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
  return failure(`${why}: without it the service stops, and its socket disappears, when the user's last login session ends.`, "LINGER_OFF", [
    `Run \`loginctl enable-linger ${s.user()}\` to turn it on (some systems need sudo), then install again`,
    "Run the install again with --no-linger-check on a desktop where you are always logged in",
  ]);
}

/** How long install, start, restart and upgrade wait for the service to be active and the daemon to answer. */
export const READY = { waitMs: 15_000, pollMs: 250 };

/**
 * Waits until the unit is active and the daemon answers on its socket. A unit that fails, or does
 * not get there in time, is SERVICE_NOT_READY with its state and the log command (specs/daemon.md).
 */
async function waitReady(ctx: Ctx, s: ServiceManager, name: string, verb: string): Promise<UnitState> {
  const unit = unitName(name);
  const deadline = Date.now() + READY.waitMs;
  let st = await s.show(unit);
  let why = "";
  for (;;) {
    if (st.active === "active") {
      try {
        await ctx.daemon(name, 2_000).status();
        return st;
      } catch (err) {
        if (!(err instanceof AxiError)) throw err;
        why = err.code === "DAEMON_NOT_RUNNING" ? "the daemon does not answer on its socket" : `the daemon answered ${err.code}: ${err.message}`;
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
  throw failure(`daemon ${verb} ${name}: ${why}; the service is ${st.active} (${st.sub}).`, "SERVICE_NOT_READY", [
    `Run \`whatsapp-axi daemon logs ${name}\` to see why`,
    `Run \`whatsapp-axi daemon status ${name}\` for the service and the daemon together`,
  ]);
}

/** Unit states in which the daemon may still be running. */
const RUNNING = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);

/**
 * Waits until the unit is seen stopped, the way waitReady waits for it to answer. A unit that
 * stays up is SERVICE_FAILED, never "stopped" (specs/conventions.md "Reads fail closed").
 */
async function waitStopped(s: ServiceManager, name: string): Promise<UnitState> {
  const unit = unitName(name);
  const deadline = Date.now() + READY.waitMs;
  let st = await s.show(unit);
  while (RUNNING.has(st.active)) {
    if (Date.now() >= deadline) {
      throw failure(`daemon stop ${name}: the service is still ${st.active} (${st.sub}).`, "SERVICE_FAILED", [
        `Run \`whatsapp-axi daemon status ${name}\` to see the service and the daemon`,
        `Run \`whatsapp-axi daemon logs ${name}\` to see why`,
      ]);
    }
    await new Promise((r) => setTimeout(r, READY.pollMs));
    st = await s.show(unit);
  }
  return st;
}

// ---- install ---------------------------------------------------------------

const NAME = { name: "name", required: false, desc: "the account (or --account)" };

export const daemonInstallSpec: CommandSpec = {
  name: "daemon install",
  summary: "Install the daemon binary and the account's systemd user service, enable and start it",
  positionals: [NAME],
  flags: {
    "dry-run": { type: "bool", desc: "print the unit, the binary path and the commands, and change nothing" },
    "no-linger-check": { type: "bool", desc: "install even when lingering is off (desktops where you are always logged in)" },
  },
  examples: ["whatsapp-axi daemon install example --dry-run", "whatsapp-axi daemon install example"],
  mutation: true,
  account: "positional",
};

export async function daemonInstall(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(daemonInstallSpec, args);
  const name = account(ctx, { positional: p.pos[0], mutation: p.flags["dry-run"] !== true });
  const s = svc(ctx);
  const src = findDaemon(ctx.io.env);
  const dest = installedBinary(ctx.roots);
  const unitPath = join(unitDir(ctx.roots), TEMPLATE);
  const text = unitText(ctx.roots);
  const unit = unitName(name);
  const refusal = p.flags["no-linger-check"] ? undefined : await lingerRefusal(s);

  if (p.flags["dry-run"]) {
    const summary = {
      account: name,
      dry_run: true,
      binary: { from: src, to: dest },
      unit: { path: unitPath, instance: unit },
      lingering: (await s.lingering()) ?? "unknown",
      would_run: [`copy ${src} to ${dest} (mode 0755)`, `write ${unitPath}`, "systemctl --user daemon-reload", `systemctl --user enable --now ${unit}`],
      ...(refusal ? { would_refuse: refusal.message } : {}),
    };
    return `${line(summary)}unit_file ${unitPath}:\n${text}`;
  }
  if (refusal) throw refusal;

  const before = await s.show(unit);
  if (before.active !== "active") {
    try {
      await ctx.daemon(name, 2_000).status();
      throw failure(`The daemon of account ${name} is already running outside the service.`, "DAEMON_RUNNING", [
        "Stop the foreground daemon (Ctrl-C where `whatsapp-axi daemon run` runs), then install again",
      ]);
    } catch (err) {
      if (!(err instanceof AxiError) || err.code === "DAEMON_RUNNING") throw err;
      // not running, or not answering: fine
    }
  }
  const wasInstalled = installedAccounts(ctx).includes(name);
  const binaryChanged = placeBinary(src, dest);
  const unitChanged = writeUnit(unitPath, text);
  if (unitChanged) await systemctl(s, ["daemon-reload"]);
  await systemctl(s, ["enable", "--now", unit]);
  if (binaryChanged && before.active === "active") await systemctl(s, ["restart", unit]);
  const after = await waitReady(ctx, s, name, "install");
  const noop = !binaryChanged && !unitChanged && wasInstalled && before.active === "active";
  if (noop) return { action: "unchanged", reason: `${name} is already installed and running (no-op)`, unit, service: `${after.active} (${after.sub})` };
  return {
    action: "installed",
    unit,
    binary: dest,
    service: `${after.active} (${after.sub})`,
    help: [
      `Run \`whatsapp-axi daemon status ${name}\` to see the service and the daemon`,
      `Run \`whatsapp-axi auth link --phone <number> --account ${name}\` if it is not linked yet`,
      `Run \`whatsapp-axi daemon uninstall ${name} --confirm\` to undo`,
    ],
  };
}

// ---- uninstall -------------------------------------------------------------

export const daemonUninstallSpec: CommandSpec = {
  name: "daemon uninstall",
  summary: "Stop and remove the account's service; the account's files are left in place",
  positionals: [NAME],
  flags: { confirm: { type: "bool", desc: "required: confirms the removal" } },
  examples: ["whatsapp-axi daemon uninstall example --confirm"],
  mutation: true,
  account: "positional",
};

export async function daemonUninstall(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(daemonUninstallSpec, args);
  const name = account(ctx, { positional: p.pos[0] });
  if (!p.flags.confirm)
    throw confirmRequired("`daemon uninstall` stops and removes the service; add --confirm", [
      `Run \`whatsapp-axi daemon uninstall ${name} --confirm\` to remove it`,
    ]);
  const s = svc(ctx);
  const unit = unitName(name);
  const state = await s.show(unit);
  if (!installedAccounts(ctx).includes(name) && state.active !== "active") {
    return { action: "unchanged", reason: `${name} is not installed (no-op)` };
  }
  await systemctl(s, ["disable", "--now", unit]);
  let template = "kept: other accounts use it";
  if (installedAccounts(ctx).length === 0) {
    rmSync(join(unitDir(ctx.roots), TEMPLATE), { force: true });
    await systemctl(s, ["daemon-reload"]);
    template = "removed";
  }
  return {
    action: "uninstalled",
    template_unit: template,
    note: "the account's files and the installed binary are left in place",
    help: [`Run \`whatsapp-axi daemon install ${name}\` to undo`, `Run \`whatsapp-axi daemon run ${name}\` to run it in the foreground instead`],
  };
}

// ---- start, stop, restart ----------------------------------------------------

function controlSpec(verb: string, summary: string, mutation: boolean): CommandSpec {
  return {
    name: `daemon ${verb}`,
    summary,
    positionals: [NAME],
    flags: {},
    examples: [`whatsapp-axi daemon ${verb} example`],
    mutation,
    account: "positional",
  };
}

export const daemonStartSpec = controlSpec("start", "Start the account's service", true);
export const daemonStopSpec = controlSpec("stop", "Stop the account's service", true);
export const daemonRestartSpec = controlSpec("restart", "Restart the account's service", true);

const PAST: Record<string, string> = { start: "started", stop: "stopped", restart: "restarted" };

export async function daemonControl(ctx: Ctx, args: string[], verb: "start" | "stop" | "restart"): Promise<unknown> {
  const spec = { start: daemonStartSpec, stop: daemonStopSpec, restart: daemonRestartSpec }[verb];
  const p = parse(spec, args);
  const name = account(ctx, { positional: p.pos[0] });
  const s = svc(ctx);
  if (!isInstalled(ctx, name)) throw notInstalled(name);
  const unit = unitName(name);
  const before = await s.show(unit);
  if (verb === "start" && before.active === "active") {
    await waitReady(ctx, s, name, verb);
    return { action: "unchanged", reason: `${name} is already running (no-op)` };
  }
  if (verb === "stop" && before.active !== "active" && before.active !== "activating")
    return { action: "unchanged", reason: `${name} is already stopped (no-op)` };
  await systemctl(s, [verb, unit]);
  const after = verb === "stop" ? await waitStopped(s, name) : await waitReady(ctx, s, name, verb);
  return {
    action: PAST[verb],
    service: `${after.active} (${after.sub})`,
    help: verb === "stop" ? [`Run \`whatsapp-axi daemon start ${name}\` to undo`] : [`Run \`whatsapp-axi daemon status ${name}\` to see the daemon's state`],
  };
}

// ---- status ------------------------------------------------------------------

export const daemonStatusSpec: CommandSpec = { ...controlSpec("status", "The service's state and the daemon's state together", false), jsonOut: true };

export async function daemonStatus(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(daemonStatusSpec, args);
  const name = account(ctx, { positional: p.pos[0] });
  const s = svc(ctx);
  const unit = unitName(name);
  const installed = isInstalled(ctx, name);
  const st = await s.show(unit);
  const out: Obj = {
    service: {
      unit,
      installed,
      enabled: st.enabled || "unknown",
      active: st.active,
      sub: st.sub,
      ...(st.since ? { since: st.since } : {}),
      ...(st.pid ? { pid: st.pid } : {}),
    },
  };
  try {
    const ds = await ctx.daemon(name).status();
    const d = { state: ds.state, ...(ds.reason ? { reason: ds.reason } : {}), version: ds.daemon_version };
    out.daemon = { ...d, since: time(ctx, ds.since) };
    // The file keeps the daemon's instant.
    ctx.exportDoc = { account: name, service: out.service, daemon: { ...d, since: ds.since } };
  } catch (err) {
    if (!(err instanceof AxiError)) throw err;
    out.daemon = { state: `unavailable (${reasonOf(err)})` };
  }
  if (!installed) out.help = [`Run \`whatsapp-axi daemon install ${name}\` to run it as a service`];
  else if (st.active !== "active")
    out.help = [`Run \`whatsapp-axi daemon start ${name}\` to start it`, `Run \`whatsapp-axi daemon logs ${name}\` to see why it stopped`];
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
  account: "positional",
};

export async function daemonLogs(ctx: Ctx, args: string[], write: (s: string) => void, signal?: AbortSignal): Promise<unknown> {
  const p = parse(daemonLogsSpec, args);
  const lines = (p.flags.lines as number | undefined) ?? 50;
  if (lines < 1 || lines > 10000) throw invalid(`--lines must be from 1 to 10000, got ${lines}`);
  const name = account(ctx, { positional: p.pos[0] });
  const s = svc(ctx);
  const unit = unitName(name);
  const got: string[] = [];
  const follow = p.flags.follow === true;
  const r = await s.logs(
    unit,
    lines,
    follow,
    (l) => {
      if (!l.trim()) return;
      if (follow) write(line({ log: [{ line: l }] }));
      else got.push(l);
    },
    signal,
  );
  const unreadable = ["Run `journalctl --user` to check the user's journal can be read; some systems keep no per-user journal"];
  if (r.code !== 0 && !signal?.aborted) {
    throw failure(`journalctl failed: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`, "LOGS_FAILED", unreadable);
  }
  if (follow) return { action: "stopped", note: "the follow was interrupted" };
  const real = got.filter((l) => !l.startsWith("-- "));
  // journalctl can exit 0 having read nothing at all (no journal files, no permission). Only
  // "-- No entries --" with nothing else on stderr is an empty log; any other stderr line, or no
  // output at all, is a failure to read it, never "0 lines" (specs/conventions.md "Reads fail closed").
  const unexpected = unexpectedStderr(r.stderr);
  if (unexpected) throw failure(`journalctl did not read the log in full: ${unexpected}`, "LOGS_FAILED", unreadable);
  if (got.length === 0) throw failure("journalctl printed nothing, not even `-- No entries --`", "LOGS_FAILED", unreadable);
  if (real.length === 0)
    return {
      log: `0 lines for ${unit}`,
      ...(isInstalled(ctx, name)
        ? {}
        : { help: [`Run \`whatsapp-axi daemon install ${name}\` to log to the journal; a foreground daemon logs to its terminal`] }),
    };
  return { unit, count: `${real.length} of the last ${lines} asked for`, log: real.map((l) => ({ line: l })) };
}

/**
 * The first stderr line of journalctl that is not its known notice ("Hint: ..." and the indented
 * lines that continue it), or undefined when there is none.
 */
export function unexpectedStderr(stderr: string): string | undefined {
  let inHint = false;
  for (const l of stderr.split("\n")) {
    if (!l.trim()) continue;
    if (l.startsWith("Hint:")) {
      inHint = true;
      continue;
    }
    if (inHint && /^\s/.test(l)) continue;
    inHint = false;
    return l.trim();
  }
  return undefined;
}

// ---- upgrade -----------------------------------------------------------------

export const daemonUpgradeSpec: CommandSpec = {
  name: "daemon upgrade",
  summary: "Replace the installed daemon binary with this CLI's and restart every installed account, waiting for each to answer",
  positionals: [],
  flags: {},
  examples: ["whatsapp-axi daemon upgrade"],
  mutation: true,
  account: "none",
  jsonOut: true,
};

/** The version an installed binary reports, or undefined. */
export async function binaryVersion(path: string, env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const r = await runDaemon(path, ["version"], env);
    if (r.code !== 0) return undefined;
    return /^whatsapp-axid (\S+)/m.exec(r.stdout)?.[1];
  } catch {
    return undefined;
  }
}

export async function daemonUpgrade(ctx: Ctx, args: string[]): Promise<unknown> {
  parse(daemonUpgradeSpec, args);
  if (ctx.accountFlag !== undefined) {
    throw invalid("`daemon upgrade` replaces the one binary every installed account runs, so it acts on all of them; --account cannot narrow it", [
      `Run \`whatsapp-axi daemon restart ${ctx.accountFlag}\` to restart one account`,
    ]);
  }
  const s = svc(ctx);
  const src = findDaemon(ctx.io.env);
  const dest = installedBinary(ctx.roots);
  const accounts = installedAccounts(ctx);
  const pin = pinOf(ctx.io.env);
  const pinNote = pin !== undefined ? { note: `acts on every installed account; ${PIN_VAR}=${pin} does not apply` } : {};
  if (!existsSync(dest) && accounts.length === 0) {
    return {
      action: "unchanged",
      reason: "no installed binary and 0 installed accounts (no-op)",
      ...pinNote,
      help: ["Run `whatsapp-axi daemon install <name>` to install one"],
    };
  }
  const replaced = placeBinary(src, dest);
  const version = await binaryVersion(dest, ctx.io.env);
  if (!replaced)
    return { action: "unchanged", reason: "the installed binary is already this CLI's (no-op)", binary: dest, ...(version ? { version } : {}), ...pinNote };
  // Each account is restarted and waited for in turn; a failure is that account's row, and the
  // rest still go on.
  const rows: Obj[] = [];
  let failed = 0;
  for (const a of accounts) {
    try {
      await systemctl(s, ["restart", unitName(a)]);
      await waitReady(ctx, s, a, "upgrade");
      const st = await ctx.daemon(a, 2_000).status();
      rows.push({ account: a, action: "restarted", detail: `answering, daemon ${st.daemon_version}` });
    } catch (err) {
      failed++;
      rows.push({ account: a, action: "unchanged", detail: `failed (${reasonOf(err)})` });
    }
  }
  const out: Obj = {
    action: "upgraded",
    binary: dest,
    ...(version ? { version } : {}),
    ...pinNote,
    count: `${rows.length} of ${accounts.length}`,
    accounts: rows.length ? rows : "0 installed accounts",
  };
  if (failed) {
    ctx.exitCode = 1;
    const bad = rows.find((r) => String(r.detail).startsWith("failed"));
    out.error = `${failed} of ${accounts.length} accounts did not come back after the upgrade`;
    out.code = "SERVICE_NOT_READY";
    out.help = [`Run \`whatsapp-axi daemon logs ${bad?.account as string}\` to see why`, "Run `whatsapp-axi doctor` to check every account"];
  } else out.help = ["Run `whatsapp-axi doctor` to check that the versions now match"];
  return out;
}

export type { ToolError };
export { daemonMessage, isInstalled };
