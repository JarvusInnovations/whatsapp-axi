// The home view, accounts, account add|remove and daemon run.
import { spawn } from "node:child_process";
import { encode } from "@toon-format/toon";
import { parse, type CommandSpec } from "../args.js";
import { daemonMessage, findDaemon, runDaemon } from "../binary.js";
import { startCommand, type Status } from "../client.js";
import { failure, usage } from "../errors.js";
import { accountExists, listAccounts, accountPaths } from "../paths.js";
import { requireAccountName, type Ctx } from "../context.js";
import { AxiError } from "axi-sdk-js";
import { installedAccounts } from "./daemon.js";

interface AccountRow {
  name: string;
  state: string;
  scope: string | null;
  phone: string | null;
}

/** How long the home view and `accounts` wait for each account's daemon. */
export const ROW_TIMEOUT = { ms: 2_000 };

/**
 * One account's state, asked with a short limit. It never fails: a stopped daemon is `stopped`, one
 * that does not answer in time is `not answering`, and one that errors is `error (<code>)`
 * (specs/cli.md "Agent integrations").
 */
async function accountRow(ctx: Ctx, name: string): Promise<AccountRow> {
  const d = ctx.daemon(name, ROW_TIMEOUT.ms);
  const ask = async (): Promise<AccountRow> => {
    const st: Status = await d.status();
    const s = await d.call("GET", "/v1/settings");
    const settings = s.settings as { scope?: unknown } | undefined;
    if (!settings || typeof settings.scope !== "string") return { name, state: "error (bad_response)", scope: null, phone: st.me?.pn ?? null };
    return { name, state: st.state, scope: settings.scope, phone: st.me?.pn ?? null };
  };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<AccountRow>((resolve) => {
    timer = setTimeout(() => resolve({ name, state: "not answering", scope: null, phone: null }), ROW_TIMEOUT.ms + 100);
  });
  try {
    return await Promise.race([
      ask().catch((err: unknown): AccountRow => {
        const code = err instanceof AxiError ? err.code : "internal";
        if (code === "daemon_not_running") return { name, state: "stopped", scope: null, phone: null };
        if (code === "daemon_timeout") return { name, state: "not answering", scope: null, phone: null };
        return { name, state: `error (${code})`, scope: null, phone: null };
      }),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const accountsSpec: CommandSpec = {
  name: "accounts",
  summary: "List accounts with each daemon's state and scope",
  positionals: [],
  flags: { fields: { type: "string", value: "<list>", desc: "add columns: phone" } },
  examples: ["whatsapp-axi accounts", "whatsapp-axi accounts --fields phone"],
};

export async function accounts(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(accountsSpec, args);
  const extra = p.flags.fields === undefined ? [] : String(p.flags.fields).split(",").map((s) => s.trim());
  for (const f of extra) if (f !== "phone") throw usage(`unknown field ${JSON.stringify(f)} for \`accounts\``, ["fields available: phone"]);
  const names = listAccounts(ctx.roots);
  if (names.length === 0) return { accounts: "0 accounts for this user", help: ["Run `whatsapp-axi account add <name>` to create one"] };
  const rows = await Promise.all(names.map((n) => accountRow(ctx, n)));
  const keys = ["name", "state", "scope", ...extra];
  return {
    count: names.length,
    accounts: rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k as keyof AccountRow]]))),
    help: helpForRows(ctx, rows),
  };
}

function helpForRows(ctx: Ctx, rows: AccountRow[]): string[] {
  const help: string[] = [];
  const stopped = rows.find((r) => r.state === "stopped");
  if (stopped) {
    // The fix depends on whether the account is installed as a service.
    if (installedAccounts(ctx).includes(stopped.name)) help.push(`Run \`${startCommand(stopped.name)}\` to start a stopped daemon`);
    else help.push(`Run \`whatsapp-axi daemon install ${stopped.name}\` to run it as a service, or \`whatsapp-axi daemon run ${stopped.name}\` in the foreground`);
  }
  const bad = rows.find((r) => r.state === "not answering" || r.state.startsWith("error"));
  if (bad) help.push(`Run \`whatsapp-axi daemon status ${bad.name}\` to see why ${bad.name} is ${bad.state}`);
  const flag = rows.length > 1 ? " --account <name>" : "";
  help.push(`Run \`whatsapp-axi chats${flag}\` to see kept chats`, `Run \`whatsapp-axi doctor${flag}\` to check an account`);
  return help;
}

export async function home(ctx: Ctx): Promise<unknown> {
  const names = listAccounts(ctx.roots);
  if (names.length === 0) return { accounts: "0 accounts for this user", help: ["Run `whatsapp-axi account add <name>` to create one"] };
  const rows = await Promise.all(names.map((n) => accountRow(ctx, n)));
  return { accounts: rows.map((r) => ({ name: r.name, state: r.state, scope: r.scope })), help: helpForRows(ctx, rows) };
}

export const accountAddSpec: CommandSpec = {
  name: "account add",
  summary: "Create an account's files with default settings (scope tagged). Already existing is a no-op",
  positionals: [{ name: "name", required: true, desc: "local account label matching ^[a-z][a-z0-9-]{0,23}$" }],
  flags: {},
  examples: ["whatsapp-axi account add example"],
};

export async function accountAdd(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(accountAddSpec, args);
  const name = requireAccountName(p.pos[0]);
  if (accountExists(name, ctx.roots)) return { account: `${name} already exists (no-op)` };
  const bin = findDaemon();
  const r = await runDaemon(bin, ["init", "--account", name]);
  if (r.code !== 0) {
    if (accountExists(name, ctx.roots)) return { account: `${name} already exists (no-op)` };
    throw failure(`Could not create account ${name}: ${daemonMessage(r.stderr)}`, "account_add_failed");
  }
  if (!accountExists(name, ctx.roots)) throw failure(`The daemon reported success but account ${name} has no settings file.`, "account_add_failed");
  return {
    account: { name, created: true, scope: "tagged", settings: accountPaths(name, ctx.roots).settings },
    help: [`Run \`whatsapp-axi daemon install ${name}\` to run its daemon as a service (or \`whatsapp-axi daemon run ${name}\` in the foreground)`, `Run \`whatsapp-axi operators add <user> --account ${name}\` to add an operator`],
  };
}

export const accountRemoveSpec: CommandSpec = {
  name: "account remove",
  summary: "Delete an account's config and state. Refuses while its daemon runs. The name must be repeated with --confirm",
  positionals: [{ name: "name", required: true, desc: "the account to delete" }],
  flags: { confirm: { type: "string", value: "<name>", desc: "the account name again (required)" } },
  examples: ["whatsapp-axi account remove example --confirm example"],
};

export async function accountRemove(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(accountRemoveSpec, args);
  const name = requireAccountName(p.pos[0]);
  if (p.flags.confirm === undefined) throw usage(`--confirm ${name} is required to delete account ${name}`, [`Run \`whatsapp-axi account remove ${name} --confirm ${name}\``]);
  if (p.flags.confirm !== name) throw usage(`--confirm ${JSON.stringify(p.flags.confirm)} does not match the account name ${name}`, [`Run \`whatsapp-axi account remove ${name} --confirm ${name}\``]);
  const paths = accountPaths(name, ctx.roots);
  if (!accountExists(name, ctx.roots)) {
    const { existsSync } = await import("node:fs");
    if (!existsSync(paths.configDir) && !existsSync(paths.stateDir)) return { account: `${name} does not exist (no-op)` };
  }
  const bin = findDaemon();
  const r = await runDaemon(bin, ["remove", "--account", name]);
  if (r.code !== 0) {
    const msg = daemonMessage(r.stderr);
    if (msg.includes("daemon is running")) {
      throw failure(`Account ${name}'s daemon is running; it was not removed.`, "daemon_running", ["Stop the daemon first, then run this again"]);
    }
    throw failure(`Could not remove account ${name}: ${msg}`, "account_remove_failed");
  }
  return { account: { name, removed: true } };
}

export const daemonRunSpec: CommandSpec = {
  name: "daemon run",
  summary: "Run an account's daemon in the foreground, for development and debugging",
  positionals: [{ name: "name", required: true, desc: "the account" }],
  flags: { "log-level": { type: "string", value: "<level>", desc: "debug, info (default), warn or error" } },
  examples: ["whatsapp-axi daemon run example", "whatsapp-axi daemon run example --log-level debug"],
};

/** Runs the daemon in the foreground; its exit code becomes ours. */
export async function daemonRun(ctx: Ctx, args: string[]): Promise<string> {
  const p = parse(daemonRunSpec, args);
  const name = requireAccountName(p.pos[0]);
  if (!accountExists(name, ctx.roots)) {
    throw failure(`No account named ${name}.`, "no_account", [`Run \`whatsapp-axi account add ${name}\` to create it`]);
  }
  const level = p.flags["log-level"];
  if (level !== undefined && !["debug", "info", "warn", "error"].includes(String(level))) {
    throw usage("--log-level must be debug, info, warn or error");
  }
  const bin = findDaemon();
  const daemonArgs = ["run", "--account", name, ...(level ? ["--log-level", String(level)] : [])];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(bin, daemonArgs, { stdio: ["ignore", "inherit", "inherit"] });
    const forward = (sig: NodeJS.Signals) => child.kill(sig);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("error", (e) => reject(failure(`Cannot run the daemon binary ${bin}: ${e.message}`, "daemon_binary_failed")));
    child.on("close", (c, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(c ?? (signal ? 0 : 1));
    });
  });
  if (code !== 0) {
    throw failure(`The daemon of account ${name} exited with status ${code}; its message is above, on standard error.`, "daemon_exited");
  }
  return encode({ daemon: `${name} stopped` });
}
