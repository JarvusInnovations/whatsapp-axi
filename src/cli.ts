import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { renderHelp, type CommandSpec } from "./args.js";
import { accountAdd, accountAddSpec, accountRemove, accountRemoveSpec, accounts, accountsSpec, daemonRun, daemonRunSpec, home } from "./commands/accounts.js";
import { download, downloadSpec, markRead, markReadSpec, react, reactSpec, send, sendFile, sendFileSpec, sendSpec, typing, typingSpec } from "./commands/act.js";
import { authLink, authLinkSpec, authLogout, authLogoutSpec } from "./commands/auth.js";
import {
  daemonControl,
  daemonInstall,
  daemonInstallSpec,
  daemonLogs,
  daemonLogsSpec,
  daemonRestartSpec,
  daemonStartSpec,
  daemonStatus,
  daemonStatusSpec,
  daemonStopSpec,
  daemonUninstall,
  daemonUninstallSpec,
  daemonUpgrade,
  daemonUpgradeSpec,
} from "./commands/daemon.js";
import { doctor, doctorSpec } from "./commands/doctor.js";
import { chatView, chatViewSpec, chats, chatsSpec, events, eventsSpec, forget, forgetSpec, messageView, messageViewSpec, groups, groupsSpec, read, readSpec } from "./commands/read.js";
import {
  operatorsAddSpec,
  operatorsChange,
  operatorsList,
  operatorsListSpec,
  operatorsRemoveSpec,
  scopeDMFrom,
  scopeDMFromSpec,
  scopeSet,
  scopeSetSpec,
  scopeShow,
  scopeShowSpec,
  settingsSet,
  settingsSetSpec,
  settingsShow,
  settingsShowSpec,
} from "./commands/settings.js";
import { defaultCtx, type Ctx } from "./context.js";
import { exitCodeFor, usage } from "./errors.js";
import { output } from "./output.js";
import { VERSION } from "./version.js";

export const DESCRIPTION = "Agent-ergonomic CLI for WhatsApp accounts, each served by a local daemon";

export const TOP_HELP = `usage: whatsapp-axi [command] [args] [flags]
commands[20]:
  (none)=home: accounts with state and scope
  accounts, account add <name>, account remove <name> --confirm <name>
  auth link --phone <number> | --qr, auth logout --confirm
  daemon install <name> [--dry-run] [--no-linger-check], daemon uninstall <name> --confirm
  daemon start|stop|restart|status <name>, daemon logs <name> [--lines N] [--follow], daemon upgrade
  daemon run <name> (foreground)
  doctor [--account <name>]
  chats, groups, chat view <chat>
  events [--after <seq>] [--limit N] [--chat <chat>] [--kind <kind>] [--follow] [--mark-read]
  read <chat> [--limit N] [--before <id>] [--mark-read]
  message view <ref> [--full]
  send <chat> <text|-> [--reply <ref>] [--mention <user>]... [--first-contact]
  send-file <chat> <path> [--caption <text>] [--as <type>] [--reply <ref>] [--first-contact]
  mark-read <ref> | mark-read --chat <chat>
  typing <chat> [--stop]
  react <ref> <emoji> | react <ref> --remove
  download <ref>
  forget <chat> [--message <ref>] --confirm
  scope show, scope set <scope> [--chat <chat>] [--confirm], scope dm-from <who>
  operators list, operators add <user>, operators remove <user>
  settings show, settings set <key> <value>
flags:
  --account <name> on every command that acts on an account (optional with exactly one account)
  --json on every command: one JSON document instead of TOON (the daemon's answer unchanged; streams one object per line)
  --help on every command; -v/--version
`;

type Handler = (ctx: Ctx, args: string[]) => Promise<unknown>;

interface Sub {
  spec: CommandSpec;
  run: Handler;
}

/** Streaming handlers: with --json their lines are the output, and the final summary is not printed. */
const STREAMS = new Set<Handler>();

function writeOut(s: string): void {
  process.stdout.write(s);
}

/** Runs a streaming command that Ctrl-C stops. */
function streaming(fn: (ctx: Ctx, args: string[], write: (s: string) => void, signal: AbortSignal) => Promise<unknown>): Handler {
  const h: Handler = async (ctx, args) => {
    const ac = new AbortController();
    const stop = () => ac.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      return await fn(ctx, args, writeOut, ac.signal);
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  };
  STREAMS.add(h);
  return h;
}

const runEvents = streaming(events);

const SINGLE: Record<string, Sub> = {
  accounts: { spec: accountsSpec, run: accounts },
  doctor: { spec: doctorSpec, run: (c, a) => doctor(c, a) },
  chats: { spec: chatsSpec, run: chats },
  groups: { spec: groupsSpec, run: groups },
  events: { spec: eventsSpec, run: runEvents },
  read: { spec: readSpec, run: read },
  forget: { spec: forgetSpec, run: forget },
  send: { spec: sendSpec, run: (c, a) => send(c, a) },
  "send-file": { spec: sendFileSpec, run: sendFile },
  "mark-read": { spec: markReadSpec, run: markRead },
  typing: { spec: typingSpec, run: typing },
  react: { spec: reactSpec, run: react },
  download: { spec: downloadSpec, run: download },
};

const GROUPS: Record<string, Record<string, Sub>> = {
  account: { add: { spec: accountAddSpec, run: accountAdd }, remove: { spec: accountRemoveSpec, run: accountRemove } },
  auth: { link: { spec: authLinkSpec, run: streaming(authLink) }, logout: { spec: authLogoutSpec, run: authLogout } },
  daemon: {
    install: { spec: daemonInstallSpec, run: daemonInstall },
    uninstall: { spec: daemonUninstallSpec, run: daemonUninstall },
    start: { spec: daemonStartSpec, run: (c, a) => daemonControl(c, a, "start") },
    stop: { spec: daemonStopSpec, run: (c, a) => daemonControl(c, a, "stop") },
    restart: { spec: daemonRestartSpec, run: (c, a) => daemonControl(c, a, "restart") },
    status: { spec: daemonStatusSpec, run: daemonStatus },
    logs: { spec: daemonLogsSpec, run: streaming(daemonLogs) },
    upgrade: { spec: daemonUpgradeSpec, run: daemonUpgrade },
    run: { spec: daemonRunSpec, run: daemonRun },
  },
  chat: { view: { spec: chatViewSpec, run: chatView } },
  message: { view: { spec: messageViewSpec, run: messageView } },
  scope: { show: { spec: scopeShowSpec, run: scopeShow }, set: { spec: scopeSetSpec, run: scopeSet }, "dm-from": { spec: scopeDMFromSpec, run: scopeDMFrom } },
  operators: {
    list: { spec: operatorsListSpec, run: operatorsList },
    add: { spec: operatorsAddSpec, run: (c, a) => operatorsChange(c, a, true) },
    remove: { spec: operatorsRemoveSpec, run: (c, a) => operatorsChange(c, a, false) },
  },
  settings: { show: { spec: settingsShowSpec, run: settingsShow }, set: { spec: settingsSetSpec, run: settingsSet } },
};

/** Every command spec, for help and tests. */
export const SPECS: CommandSpec[] = [...Object.values(SINGLE).map((s) => s.spec), ...Object.values(GROUPS).flatMap((g) => Object.values(g).map((s) => s.spec))];

function groupHelp(name: string): string {
  const subs = GROUPS[name];
  return encode({ command: name, subcommands: Object.values(subs).map((s) => ({ usage: s.spec.name, description: s.spec.summary })) }) + "\n";
}

function subList(name: string): string[] {
  return Object.values(GROUPS[name]).map((s) => `whatsapp-axi ${s.spec.name}`);
}

/** Commands that do not call the daemon for their answer: --json prints the data they would print as TOON. */
const LOCAL = new Set(["accounts", "doctor", "account", "daemon"]);

/** The JSON error document: `{"error": {"code", "message", ...}}`, with the daemon's extra fields. */
function jsonError(err: unknown): { output: string; exitCode: number } {
  const e = err as { message?: string; code?: string; suggestions?: string[]; details?: Record<string, unknown> };
  const body: Record<string, unknown> = { ...e.details, code: e.code ?? "internal", message: e.message ?? String(err) };
  if (e.suggestions?.length) body.help = e.suggestions;
  return { output: `${JSON.stringify({ error: body })}\n`, exitCode: exitCodeFor(err) };
}

/** Finds the handler for a command line: the command, its subcommand and the rest of the arguments. */
function resolve(args: string[]): { sub: Sub; rest: string[]; local: boolean } {
  const [name, ...rest] = args;
  const single = SINGLE[name];
  if (single) return { sub: single, rest, local: LOCAL.has(name) };
  const subs = GROUPS[name];
  if (!subs) throw usage(`Unknown command: ${name}`, ["Run `whatsapp-axi --help` to see the commands"]);
  const [subName, ...more] = rest;
  if (subName === undefined) throw usage(`\`${name}\` needs a subcommand: ${Object.keys(subs).join(", ")}`, subList(name));
  const sub = subs[subName];
  if (!sub) throw usage(`unknown subcommand ${JSON.stringify(subName)} for \`${name}\`; valid: ${Object.keys(subs).join(", ")}`, subList(name));
  return { sub, rest: more, local: LOCAL.has(name) };
}

/** Runs one command line with --json (already removed from args). */
async function mainJson(args: string[], ctxFactory: () => Ctx): Promise<void> {
  output.json = true;
  output.body = undefined;
  try {
    if (args.length === 0) {
      process.stdout.write(`${JSON.stringify(await home(ctxFactory()))}\n`);
      return;
    }
    if (args[0].startsWith("-")) {
      if (["-v", "-V", "--version"].includes(args[0]) && args.length === 1) {
        process.stdout.write(`${JSON.stringify({ version: VERSION })}\n`);
        return;
      }
      if (args[0] === "--help" && args.length === 1) {
        process.stdout.write(`${JSON.stringify({ help: TOP_HELP })}\n`);
        return;
      }
      throw usage(`flags come after the command; ${JSON.stringify(args[0])} came first`, ["Run `whatsapp-axi <command> [args] [flags]`", "Run `whatsapp-axi --help` to see the commands"]);
    }
    if (GROUPS[args[0]] && args[1] === "--help") {
      process.stdout.write(`${JSON.stringify({ help: groupHelp(args[0]) })}\n`);
      return;
    }
    const { sub, rest, local } = resolve(args);
    if (rest.includes("--help")) {
      process.stdout.write(`${JSON.stringify({ help: renderHelp(sub.spec) })}\n`);
      return;
    }
    const result = await sub.run(ctxFactory(), rest);
    if (STREAMS.has(sub.run) && !local && output.body === undefined) return;
    const doc = !local && output.body !== undefined ? output.body : result;
    process.stdout.write(`${JSON.stringify(doc)}\n`);
  } catch (err) {
    const f = jsonError(err);
    process.stdout.write(f.output);
    process.exitCode = f.exitCode;
  } finally {
    output.json = false;
    output.body = undefined;
  }
}

export async function main(argv?: string[], ctxFactory: () => Ctx = defaultCtx): Promise<void> {
  const all = argv ?? process.argv.slice(2);
  const dashdash = all.indexOf("--");
  const head = dashdash < 0 ? all : all.slice(0, dashdash);
  if (head.includes("--json")) {
    const args = [...head.filter((a) => a !== "--json"), ...(dashdash < 0 ? [] : all.slice(dashdash))];
    return mainJson(args, ctxFactory);
  }
  const commands: Record<string, (args: string[]) => Promise<unknown>> = {};
  for (const [name, sub] of Object.entries(SINGLE)) {
    commands[name] = async (args) => (args.includes("--help") ? renderHelp(sub.spec) : sub.run(ctxFactory(), args));
  }
  for (const [name, subs] of Object.entries(GROUPS)) {
    commands[name] = async (args) => {
      const [subName, ...rest] = args;
      if (subName === "--help") return groupHelp(name);
      if (subName === undefined) throw usage(`\`${name}\` needs a subcommand: ${Object.keys(subs).join(", ")}`, subList(name));
      const sub = subs[subName];
      if (!sub) throw usage(`unknown subcommand ${JSON.stringify(subName)} for \`${name}\`; valid: ${Object.keys(subs).join(", ")}`, subList(name));
      return rest.includes("--help") ? renderHelp(sub.spec) : sub.run(ctxFactory(), rest);
    };
  }
  const args = all;
  const first = args[0];
  if (first?.startsWith("-") && !(args.length === 1 && ["--help", "-v", "-V", "--version"].includes(first))) {
    process.stdout.write(
      encode({ error: `flags come after the command; ${JSON.stringify(first)} came first`, code: "usage", help: ["Run `whatsapp-axi <command> [args] [flags]`", "Run `whatsapp-axi --help` to see the commands"] }) + "\n",
    );
    process.exitCode = 2;
    return;
  }
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv: args,
    topLevelHelp: TOP_HELP,
    home: () => home(ctxFactory()) as never,
    commands: commands as never,
    renderUnknownCommand: (command) =>
      encode({ error: `Unknown command: ${command}`, code: "usage", help: ["Run `whatsapp-axi --help` to see the commands"] }) + "\n",
    formatError: (err) => {
      const e = err as { message?: string; code?: string; suggestions?: string[] };
      const out: Record<string, unknown> = { error: e.message ?? String(err), code: e.code ?? "internal" };
      if (e.suggestions?.length) out.help = e.suggestions;
      return { output: encode(out) + "\n", exitCode: exitCodeFor(err) };
    },
  });
}
