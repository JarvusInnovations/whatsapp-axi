import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { renderHelp, type CommandSpec } from "./args.js";
import { accountAdd, accountAddSpec, accountRemove, accountRemoveSpec, accounts, accountsSpec, daemonRun, daemonRunSpec, home } from "./commands/accounts.js";
import { authLink, authLinkSpec, authLogout, authLogoutSpec } from "./commands/auth.js";
import { doctor, doctorSpec } from "./commands/doctor.js";
import { chatView, chatViewSpec, chats, chatsSpec, events, eventsSpec, forget, forgetSpec, messageView, messageViewSpec, read, readSpec } from "./commands/read.js";
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
import { VERSION } from "./version.js";

export const DESCRIPTION = "Agent-ergonomic CLI for WhatsApp accounts, each served by a local daemon";

export const TOP_HELP = `usage: whatsapp-axi [command] [args] [flags]
commands[14]:
  (none)=home: accounts with state and scope
  accounts, account add <name>, account remove <name> --confirm <name>
  auth link --phone <number> | --qr, auth logout --confirm
  daemon run <name>
  doctor [--account <name>]
  chats, chat view <chat>
  events [--after <seq>] [--limit N] [--chat <chat>] [--kind <kind>] [--follow]
  read <chat> [--limit N] [--before <id>]
  message view <ref> [--full]
  forget <chat> [--message <ref>] --confirm
  scope show, scope set <scope> [--chat <chat>] [--confirm], scope dm-from <who>
  operators list, operators add <user>, operators remove <user>
  settings show, settings set <key> <value>
flags:
  --account <name> on every command that acts on an account (optional with exactly one account)
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
  return async (ctx, args) => {
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
}

const runEvents = streaming(events);

const SINGLE: Record<string, Sub> = {
  accounts: { spec: accountsSpec, run: accounts },
  doctor: { spec: doctorSpec, run: (c, a) => doctor(c, a) },
  chats: { spec: chatsSpec, run: chats },
  events: { spec: eventsSpec, run: runEvents },
  read: { spec: readSpec, run: read },
  forget: { spec: forgetSpec, run: forget },
};

const GROUPS: Record<string, Record<string, Sub>> = {
  account: { add: { spec: accountAddSpec, run: accountAdd }, remove: { spec: accountRemoveSpec, run: accountRemove } },
  auth: { link: { spec: authLinkSpec, run: streaming(authLink) }, logout: { spec: authLogoutSpec, run: authLogout } },
  daemon: { run: { spec: daemonRunSpec, run: daemonRun } },
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

export async function main(argv?: string[], ctxFactory: () => Ctx = defaultCtx): Promise<void> {
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
  const args = argv ?? process.argv.slice(2);
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
