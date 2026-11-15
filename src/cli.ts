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
import { closeJsonOut, jqHint, openJsonOut, output, resetOutput, takeJsonOut, writeDoc } from "./output.js";
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
  chats [--limit N], groups [--limit N], chat view <chat>
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
  scope show, scope set <scope> [--chat <chat>] [--confirm], scope dm-from <who> [--confirm]
  operators list, operators add <user>, operators remove <user>
  settings show, settings set <key> <value> [--confirm]
flags:
  --account <name> on every command that acts on an account (optional with exactly one account)
  --json-out[=path] on every command that calls the daemon, doctor and daemon status: also write the complete response as JSON to a file (bare: under the temp directory; streams one object per line); standard output stays TOON
  --help on every command; -v/--version
`;

type Handler = (ctx: Ctx, args: string[]) => Promise<unknown>;

interface Sub {
  spec: CommandSpec;
  run: Handler;
}


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

/** Commands that take --json-out: every command that calls the daemon, plus doctor and daemon status. */
function takesJsonOut(name: string, subName?: string): boolean {
  if (name === "accounts" || name === "account") return false;
  if (name === "daemon") return subName === "status";
  return true;
}

/** doctor and daemon status write the rows they print; everything else the daemon's body. */
function isLocal(name: string): boolean {
  return name === "doctor" || name === "daemon";
}

type Obj = Record<string, unknown>;

function withoutHelp(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { help: _help, ...rest } = result as Obj;
  return rest;
}

/** Adds the `wrote:` line and the jq hint to a printed object. */
function annotate(result: unknown, wrote: string, hint: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { result, wrote, help: [hint] };
  const { help, ...rest } = result as Obj;
  const prior = Array.isArray(help) ? help : typeof help === "string" ? [help] : [];
  return { ...rest, wrote, help: [...prior, hint] };
}

/** Runs one subcommand, handling --json-out where the command takes it. */
async function runSub(label: string, sub: Sub, rest: string[], ctxFactory: () => Ctx, eligible: boolean, local: boolean): Promise<unknown> {
  if (rest.includes("--help")) return renderHelp(sub.spec) + (eligible ? JSON_OUT_HELP : "");
  if (!eligible) return sub.run(ctxFactory(), rest);
  const { args, path } = takeJsonOut(rest);
  if (path === undefined) return sub.run(ctxFactory(), args);
  resetOutput();
  const file = openJsonOut(path, label);
  output.file = file;
  try {
    let result: unknown;
    try {
      result = await sub.run(ctxFactory(), args);
    } catch (err) {
      const e = err as { message?: string; code?: string; suggestions?: string[]; jsonOut?: { wrote: string; hint: string } };
      const doc = { error: output.daemonError ?? { code: e.code ?? "internal", message: e.message ?? String(err) } };
      writeDoc(doc);
      e.jsonOut = { wrote: `${file.path} (${file.lines > 0 ? `${file.lines} JSON lines then the error` : "the error"})`, hint: jqHint(file.path, doc, file.lines > 0) };
      throw err;
    }
    if (file.lines > 0) return annotate(result, `${file.path} (${file.lines} JSON ${file.lines === 1 ? "line" : "lines"})`, jqHint(file.path, undefined, true));
    const doc = local || output.body === undefined ? withoutHelp(result) : output.body;
    writeDoc(doc);
    return annotate(result, `${file.path} (${local ? "the rows printed" : "the daemon's response body"})`, jqHint(file.path, doc, false));
  } finally {
    closeJsonOut();
    resetOutput();
  }
}

const JSON_OUT_HELP = "also: --json-out[=path] writes the complete response as JSON to a file (bare: a file in the temp directory); standard output stays TOON\n";

export async function main(argv?: string[], ctxFactory: () => Ctx = defaultCtx): Promise<void> {
  const all = argv ?? process.argv.slice(2);
  const commands: Record<string, (args: string[]) => Promise<unknown>> = {};
  for (const [name, sub] of Object.entries(SINGLE)) {
    commands[name] = async (args) => runSub(name, sub, args, ctxFactory, takesJsonOut(name), isLocal(name));
  }
  for (const [name, subs] of Object.entries(GROUPS)) {
    commands[name] = async (args) => {
      const [subName, ...rest] = args;
      if (subName === "--help") return groupHelp(name);
      if (subName === undefined) throw usage(`\`${name}\` needs a subcommand: ${Object.keys(subs).join(", ")}`, subList(name));
      const sub = subs[subName];
      if (!sub) throw usage(`unknown subcommand ${JSON.stringify(subName)} for \`${name}\`; valid: ${Object.keys(subs).join(", ")}`, subList(name));
      return runSub(`${name}-${subName}`, sub, rest, ctxFactory, takesJsonOut(name, subName), isLocal(name));
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
      const jo = (err as { jsonOut?: { wrote: string; hint: string } }).jsonOut;
      if (jo) {
        const prior = (out.help as string[] | undefined) ?? [];
        delete out.help;
        out.wrote = jo.wrote;
        out.help = [...prior, jo.hint];
      }
      return { output: encode(out) + "\n", exitCode: exitCodeFor(err) };
    },
  });
}
