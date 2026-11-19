// The home view, accounts, account add|remove|use|migrate and daemon run.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { parse, type CommandSpec } from "../flags.js";
import { daemonMessage, findDaemon, runDaemon } from "../binary.js";
import { startCommand, type Status } from "../client.js";
import { confirmRequired, failure, invalid, reasonOf } from "../errors.js";
import { accountEntries, pinOf, PIN_VAR, readDefault, writeDefault } from "../config.js";
import { accountExists, accountPaths, legacyAccounts, validAccount, type AccountEntry } from "../paths.js";
import { account, acctFlag, envChoices, type Ctx } from "../context.js";
import { installedAccounts } from "./daemon.js";
import { line } from "../output/toon.js";

type Obj = Record<string, unknown>;

interface AccountRow {
  name: string;
  state: string;
  scope: string;
  phone?: string;
}

/** How long the home view and `accounts` wait for each account's daemon. */
export const ROW_TIMEOUT = { ms: 2_000 };

/** The house discovery line, always the last hint of the home view. */
export const DISCOVERY = "Run `whatsapp-axi --help` to see the full command list, or `whatsapp-axi <command> --help` for usage on any command";

/**
 * One account's state, asked with a short limit. It never fails: an account whose files cannot be
 * read is `unknown (CONFIG_INVALID: …)`, a daemon that is not running, errors or does not answer in
 * time is `unavailable (<CODE>: …)` (specs/conventions.md "Home, hook and doctor").
 */
export async function accountRow(ctx: Ctx, e: AccountEntry, ms = ROW_TIMEOUT.ms): Promise<AccountRow> {
  if (e.problem) return { name: e.name, state: `unknown (CONFIG_INVALID: ${e.problem})`, scope: "?" };
  const d = ctx.daemon(e.name, ms);
  const ask = async (): Promise<AccountRow> => {
    const st: Status = await d.status();
    const s = await d.call("GET", "/v1/settings");
    const settings = s.settings as { scope?: unknown } | undefined;
    const phone = st.me?.pn ? { phone: st.me.pn } : {};
    if (!settings || typeof settings.scope !== "string")
      return { name: e.name, state: st.state, scope: "unknown (UNEXPECTED_RESPONSE: settings without a scope)", ...phone };
    return { name: e.name, state: st.state, scope: settings.scope, ...phone };
  };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<AccountRow>((resolve) => {
    timer = setTimeout(() => resolve({ name: e.name, state: `unavailable (TIMEOUT: no answer in ${ms / 1000} s)`, scope: "?" }), ms + 100);
  });
  try {
    return await Promise.race([ask().catch((err: unknown): AccountRow => ({ name: e.name, state: `unavailable (${reasonOf(err)})`, scope: "?" })), late]);
  } finally {
    clearTimeout(timer);
  }
}

function stateHelp(ctx: Ctx, rows: AccountRow[]): string[] {
  const help: string[] = [];
  const down = rows.find((r) => r.state.startsWith("unavailable (DAEMON_NOT_RUNNING"));
  if (down) {
    let installed: string[] = [];
    try {
      installed = installedAccounts(ctx);
    } catch {
      // the doctor hint below covers an unreadable service directory
    }
    if (installed.includes(down.name)) help.push(`Run \`${startCommand(down.name)}\` to start the daemon of ${down.name}`);
    else help.push(`Run \`whatsapp-axi daemon install ${down.name}\` to run the daemon of ${down.name} as a service`);
  }
  if (rows.some((r) => r.state.startsWith("unavailable") || r.state.startsWith("unknown") || r.scope.startsWith("unknown"))) {
    help.push("Run `whatsapp-axi doctor` to see what is wrong and the fix");
  }
  return help;
}

/** Whether writes need --account now, in words. */
function writesLine(ctx: Ctx, names: string[]): string {
  const pin = pinOf(ctx.io.env);
  if (pin !== undefined) return `go to ${pin} (pinned by ${PIN_VAR})`;
  if (names.length === 1) return `go to ${names[0]} (the only account)`;
  return `need --account (${names.length} accounts)`;
}

export async function home(ctx: Ctx): Promise<unknown> {
  try {
    return await homeView(ctx);
  } catch (err) {
    // Home never fails (specs/conventions.md).
    return { accounts: `unavailable (${reasonOf(err)})`, help: ["Run `whatsapp-axi doctor` to see what is wrong and the fix", DISCOVERY] };
  }
}

async function homeView(ctx: Ctx): Promise<unknown> {
  const out: Obj = {};
  let entries: AccountEntry[];
  try {
    entries = accountEntries(ctx.roots);
  } catch (err) {
    return { accounts: `unavailable (${reasonOf(err)})`, help: ["Run `whatsapp-axi doctor` to see what is wrong and the fix", DISCOVERY] };
  }
  const pin = pinOf(ctx.io.env);
  let legacy: string[] = [];
  try {
    legacy = legacyAccounts(ctx.roots);
  } catch {
    legacy = [];
  }
  if (entries.length === 0) {
    const help = legacy.length
      ? [`Run \`whatsapp-axi account migrate\` to move ${legacy.join(", ")} from the old layout`]
      : ["Run `whatsapp-axi account add <name>` to create one"];
    return {
      accounts: "0 accounts for this user",
      ...(legacy.length ? { old_layout: legacy.join(", ") } : {}),
      ...(pin ? { account_lock: `${pin} (${PIN_VAR}), which does not exist` } : {}),
      ...envChoices(ctx),
      help: [...help, DISCOVERY],
    };
  }
  const names = entries.map((e) => e.name);
  try {
    const def = readDefault(ctx.roots);
    if (def !== undefined) out.default = names.includes(def) ? def : `${def} (no such account)`;
  } catch (err) {
    out.default = `unknown (${reasonOf(err)})`;
  }
  if (pin !== undefined)
    out.account_lock = names.includes(pin) ? `${pin} (${PIN_VAR})` : `${pin} (${PIN_VAR}), which does not exist: every command fails with ACCOUNT_LOCK_INVALID`;
  out.writes = writesLine(ctx, names);
  Object.assign(out, envChoices(ctx));
  const rows = await Promise.all(entries.map((e) => accountRow(ctx, e)));
  out.accounts = rows.map((r) => ({ name: r.name, state: r.state, scope: r.scope }));
  if (legacy.length) out.old_layout = legacy.join(", ");
  const af = names.length > 1 ? " --account <name>" : "";
  const help = stateHelp(ctx, rows);
  if (legacy.length) help.unshift(`Run \`whatsapp-axi account migrate\` to move ${legacy.join(", ")} from the old layout`);
  help.push(`Run \`whatsapp-axi chats${af}\` to see kept chats`, `Run \`whatsapp-axi events${af}\` to read what was kept`, DISCOVERY);
  out.help = help;
  return out;
}

// ---- accounts ----------------------------------------------------------------

export const accountsSpec: CommandSpec = {
  name: "accounts",
  summary: "List accounts with each daemon's state and scope, and which is the default",
  positionals: [],
  flags: { fields: { type: "string", value: "<list>", desc: "add columns: phone" } },
  examples: ["whatsapp-axi accounts", "whatsapp-axi accounts --fields phone"],
  account: "all",
};

export async function accounts(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(accountsSpec, args);
  const extra =
    p.flags.fields === undefined
      ? []
      : String(p.flags.fields)
          .split(",")
          .map((s) => s.trim());
  for (const f of extra) if (f !== "phone") throw invalid(`unknown field ${JSON.stringify(f)} for \`accounts\``, ["fields available: phone"]);
  const all = accountEntries(ctx.roots);
  let entries = all;
  if (ctx.accountFlag !== undefined) {
    account(ctx, { mutation: false });
    entries = all.filter((e) => e.name === ctx.acted?.name);
  }
  if (all.length === 0) return { accounts: "0 accounts for this user", help: ["Run `whatsapp-axi account add <name>` to create one"] };
  const out: Obj = {};
  const def = readDefault(ctx.roots);
  if (def !== undefined) out.default = def;
  const pin = pinOf(ctx.io.env);
  if (pin !== undefined) out.account_lock = `${pin} (${PIN_VAR})`;
  const rows = await Promise.all(entries.map((e) => accountRow(ctx, e)));
  const keys = ["name", "state", "scope", ...extra];
  out.count = `${rows.length} of ${all.length}`;
  out.accounts = rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k as keyof AccountRow] ?? null])));
  const help = stateHelp(ctx, rows);
  if (all.length > 1 && def === undefined) help.push("Run `whatsapp-axi account use <name>` to set a default for reads");
  if (help.length) out.help = help;
  return out;
}

// ---- account add -------------------------------------------------------------

export const accountAddSpec: CommandSpec = {
  name: "account add",
  summary: "Create an account's files with default settings (scope tagged). Already existing is a no-op",
  positionals: [{ name: "name", required: true, desc: "local account label matching ^[a-z][a-z0-9-]{0,23}$, not `accounts`" }],
  flags: {},
  examples: ["whatsapp-axi account add example"],
  mutation: true,
  account: "named",
};

function checkNewName(name: string): string {
  if (!validAccount(name)) {
    throw invalid(
      `bad account name ${JSON.stringify(name)}: names match ^[a-z][a-z0-9-]{0,23}$ and may not be \`accounts\` or \`config.json\` (a local label, not a phone number)`,
    );
  }
  return name;
}

/** The name an account command names: its positional, which --account may repeat but not contradict. */
function namedAccount(ctx: Ctx, positional: string): string {
  const name = checkNewName(positional);
  if (ctx.accountFlag !== undefined && ctx.accountFlag !== name) {
    throw invalid(`the account argument ${name} and --account ${ctx.accountFlag} name different accounts`);
  }
  ctx.acted = { name, source: "flag" };
  return name;
}

export async function accountAdd(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(accountAddSpec, args);
  const name = namedAccount(ctx, p.pos[0]);
  if (accountExists(name, ctx.roots)) return { action: "unchanged", reason: `account ${name} already exists (no-op)` };
  if (legacyAccounts(ctx.roots).includes(name)) {
    throw invalid(`account ${name} exists in the old layout, directly under the config or state directory; it was not created again`, [
      `Run \`whatsapp-axi account migrate ${name}\` to move it into place`,
    ]);
  }
  const bin = findDaemon(ctx.io.env);
  const r = await runDaemon(bin, ["init", "--account", name], ctx.io.env);
  if (r.code !== 0) {
    if (accountExists(name, ctx.roots)) return { action: "unchanged", reason: `account ${name} already exists (no-op)` };
    throw failure(`Could not create account ${name}: ${daemonMessage(r.stderr)}`, "ACCOUNT_ADD_FAILED", ["Run `whatsapp-axi doctor` to check the files"]);
  }
  if (!accountExists(name, ctx.roots))
    throw failure(`The daemon binary reported success but account ${name} has no directory.`, "ACCOUNT_ADD_FAILED", [
      "Run `whatsapp-axi doctor` to check the files",
    ]);
  const af = acctFlag(ctx, name);
  return {
    action: "created",
    scope: "tagged",
    settings: accountPaths(name, ctx.roots).settings,
    help: [
      `Run \`whatsapp-axi daemon install ${name}\` to run its daemon as a service (or \`whatsapp-axi daemon run ${name}\` in the foreground)`,
      `Run \`whatsapp-axi operators add <+phone> --confirm${af}\` to add an operator`,
      `Run \`whatsapp-axi account remove ${name} --confirm ${name}\` to undo`,
    ],
  };
}

// ---- account remove ----------------------------------------------------------

export const accountRemoveSpec: CommandSpec = {
  name: "account remove",
  summary: "Delete an account's config and state. Refuses while its daemon runs. The name must be repeated with --confirm",
  positionals: [{ name: "name", required: true, desc: "the account to delete" }],
  flags: { confirm: { type: "string", value: "<name>", desc: "the account name again (required)" } },
  examples: ["whatsapp-axi account remove example --confirm example"],
  mutation: true,
  account: "named",
};

export async function accountRemove(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(accountRemoveSpec, args);
  const name = namedAccount(ctx, p.pos[0]);
  const again = `Run \`whatsapp-axi account remove ${name} --confirm ${name}\` to delete it and everything it kept`;
  if (p.flags.confirm === undefined)
    throw confirmRequired(`deleting account ${name} destroys its session and everything it kept; repeat the name with --confirm ${name}`, [again]);
  if (p.flags.confirm !== name) throw confirmRequired(`--confirm ${JSON.stringify(p.flags.confirm)} does not match the account name ${name}`, [again]);
  const paths = accountPaths(name, ctx.roots);
  if (!existsSync(paths.configDir) && !existsSync(paths.stateDir)) return { action: "unchanged", reason: `account ${name} does not exist (no-op)` };
  const bin = findDaemon(ctx.io.env);
  const r = await runDaemon(bin, ["remove", "--account", name], ctx.io.env);
  if (r.code !== 0) {
    const msg = daemonMessage(r.stderr);
    if (msg.includes("daemon is running")) {
      throw failure(`Account ${name}'s daemon is running; it was not removed.`, "DAEMON_RUNNING", [
        `Run \`whatsapp-axi daemon stop ${name}\` to stop it (or stop the foreground \`daemon run\`), then run this again`,
      ]);
    }
    throw failure(`Could not remove account ${name}: ${msg}`, "ACCOUNT_REMOVE_FAILED", ["Run `whatsapp-axi doctor` to check the files"]);
  }
  return { action: "deleted" };
}

// ---- account use -------------------------------------------------------------

export const accountUseSpec: CommandSpec = {
  name: "account use",
  summary: "Set the default account for reads. Changes still need --account once there are several accounts",
  positionals: [{ name: "name", required: true, desc: "the account" }],
  flags: {},
  examples: ["whatsapp-axi account use example"],
  mutation: true,
  account: "named",
};

export async function accountUse(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(accountUseSpec, args);
  const name = namedAccount(ctx, p.pos[0]);
  const names = accountEntries(ctx.roots).map((e) => e.name);
  if (!names.includes(name)) {
    throw failure(`No account named ${name}.`, "NO_ACCOUNT", [
      ...(names.length ? [`Accounts: ${names.join(", ")}`] : []),
      `Run \`whatsapp-axi account add ${name}\` to create it`,
    ]);
  }
  const prev = readDefault(ctx.roots);
  if (prev === name) return { action: "unchanged", reason: `${name} is already the default (no-op)` };
  writeDefault(ctx.roots, name);
  const after = readDefault(ctx.roots);
  if (after !== name)
    throw failure(`The default was written but reads back as ${after ?? "unset"}.`, "CONFIG_INVALID", ["Run `whatsapp-axi doctor` to check the files"]);
  return {
    action: "set",
    default: name,
    note: `was ${prev ?? "unset"}`,
    ...(prev !== undefined && names.includes(prev) ? { help: [`Run \`whatsapp-axi account use ${prev}\` to undo`] } : {}),
  };
}

// ---- account migrate ---------------------------------------------------------

export const accountMigrateSpec: CommandSpec = {
  name: "account migrate",
  summary: "Move an account (or every one) from the old layout, directly under the config and state directories, into accounts/. Refuses while its daemon runs",
  positionals: [{ name: "name", required: false, desc: "the account to move (default: every account in the old layout)" }],
  flags: {},
  examples: ["whatsapp-axi account migrate", "whatsapp-axi account migrate example"],
  mutation: true,
  account: "none",
};

export async function accountMigrate(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(accountMigrateSpec, args);
  const named = p.pos[0] ?? ctx.accountFlag;
  if (p.pos[0] !== undefined) namedAccount(ctx, p.pos[0]);
  else if (ctx.accountFlag !== undefined) namedAccount(ctx, ctx.accountFlag);
  const todo = named !== undefined ? [named] : legacyAccounts(ctx.roots);
  if (todo.length === 0) return { action: "unchanged", reason: "no account is in the old layout (no-op)" };
  const bin = findDaemon(ctx.io.env);
  const moved: Obj[] = [];
  for (const name of todo) {
    const r = await runDaemon(bin, ["migrate", "--account", name], ctx.io.env);
    if (r.code !== 0) {
      const msg = daemonMessage(r.stderr);
      const err = msg.includes("daemon is running")
        ? failure(`Account ${name}'s daemon is running; nothing of it was moved.`, "DAEMON_RUNNING", [
            `Stop the daemon of ${name} first (\`whatsapp-axi daemon stop ${name}\`, or Ctrl-C where \`daemon run\` runs), then run \`whatsapp-axi account migrate ${name}\``,
          ])
        : msg.includes("no such account")
          ? failure(`No account named ${name}, in either layout.`, "NO_ACCOUNT", ["Run `whatsapp-axi accounts` to list the accounts"])
          : failure(`Could not move account ${name}: ${msg}`, "CONFIG_INVALID", ["Run `whatsapp-axi doctor` to check the files"]);
      if (moved.length) (err as { before?: Obj }).before = { action: "moved", moved };
      throw err;
    }
    for (const m of r.stdout.matchAll(/^moved (.+) -> (.+)$/gm)) moved.push({ account: name, from: m[1], to: m[2] });
  }
  if (!moved.length) return { action: "unchanged", reason: `${todo.join(", ")} already in place (no-op)` };
  return { action: "moved", moved, help: ["Run `whatsapp-axi doctor` to check the moved accounts"] };
}

// ---- daemon run --------------------------------------------------------------

export const daemonRunSpec: CommandSpec = {
  name: "daemon run",
  summary: "Run an account's daemon in the foreground, for development and debugging",
  positionals: [{ name: "name", required: false, desc: "the account (or --account)" }],
  flags: { "log-level": { type: "string", value: "<level>", desc: "debug, info (default), warn or error", values: ["debug", "info", "warn", "error"] } },
  examples: ["whatsapp-axi daemon run example", "whatsapp-axi daemon run example --log-level debug"],
  mutation: true,
  account: "positional",
};

/** Runs the daemon in the foreground; its exit code becomes ours. */
export async function daemonRun(ctx: Ctx, args: string[]): Promise<string> {
  const p = parse(daemonRunSpec, args);
  const name = account(ctx, { positional: p.pos[0] });
  const level = p.flags["log-level"];
  const bin = findDaemon(ctx.io.env);
  const daemonArgs = ["run", "--account", name, ...(level ? ["--log-level", String(level)] : [])];
  // Only an interrupt or terminate the CLI itself passed on is a clean stop; a daemon killed by any
  // other signal did not stop cleanly (specs/conventions.md "Reads fail closed").
  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn(bin, daemonArgs, { stdio: ["ignore", "inherit", "inherit"], env: ctx.io.env as NodeJS.ProcessEnv });
    const passed = new Set<NodeJS.Signals>();
    const forward = (sig: NodeJS.Signals) => {
      passed.add(sig);
      child.kill(sig);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("error", (e) =>
      reject(failure(`Cannot run the daemon binary ${bin}: ${e.message}`, "DAEMON_BINARY_FAILED", ["Run `whatsapp-axi doctor` to check the binary"])),
    );
    child.on("close", (c, sig) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve({ code: sig && passed.has(sig) ? 0 : c, signal: sig && passed.has(sig) ? null : sig });
    });
  });
  if (signal) {
    throw failure(`The daemon of account ${name} was killed by ${signal}; it did not stop cleanly.`, "DAEMON_EXITED", [
      `Run \`whatsapp-axi daemon run ${name}\` to start it again`,
      "Run `whatsapp-axi doctor` to check the account",
    ]);
  }
  if (code !== 0) {
    throw failure(`The daemon of account ${name} exited with status ${code ?? "unknown"}; its message is above, on standard error.`, "DAEMON_EXITED", [
      "Run `whatsapp-axi doctor` to check the account",
    ]);
  }
  return line({ account: name, action: "stopped" });
}
