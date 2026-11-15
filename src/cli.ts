// The dispatcher: one table of commands from the reference, global flags taken out in one place,
// --json-out handled in one place, the `account:` and `tz:` lines added in one place, and one
// exported formatError (specs/conventions.md "Error codes"). main(argv, io) takes its clock,
// working directory, environment and output from io.
import { AxiError, runAxiCli } from "axi-sdk-js";
import { accountAdd, accountMigrate, accountRemove, accounts, accountUse, daemonRun, home } from "./commands/accounts.js";
import { download, markRead, react, send, sendFile, typing } from "./commands/act.js";
import { authLink, authLogout } from "./commands/auth.js";
import { daemonControl, daemonInstall, daemonLogs, daemonStatus, daemonUninstall, daemonUpgrade } from "./commands/daemon.js";
import { doctor } from "./commands/doctor.js";
import { hookDir, hookOutput, setupHooks, setupHooksStatus, setupHooksUninstall } from "./commands/setup.js";
import { chatView, chats, events, forget, groups, messageView, read } from "./commands/read.js";
import { operatorsChange, operatorsList, scopeDMFrom, scopeSet, scopeShow, settingsSet, settingsShow } from "./commands/settings.js";
import { update } from "./commands/update.js";
import { makeCtx, processIo, type Ctx, type Io } from "./context.js";
import { BIN, ToolError, exitCodeFor, invalid, usage, USAGE_CODES } from "./errors.js";
import { jsonOutCommands, renderHelp, takeGlobals, type CommandSpec } from "./flags.js";
import { closeJsonOut, jqHint, openJsonOut, output, resetOutput, takeJsonOut, writeDoc } from "./output/jsonout.js";
import { checkZone } from "./output/time.js";
import { clean, line, render } from "./output/toon.js";
import { DESCRIPTION, DISCOVERY, renderTopLevelHelp, SPECS } from "./reference.js";
import { VERSION } from "./version.js";

export { DESCRIPTION, SPECS };

type Obj = Record<string, unknown>;
type Write = (s: string) => void;
type Handler = (ctx: Ctx, args: string[], write: Write, signal: AbortSignal) => Promise<unknown>;

/** Each command's handler, by its name in the reference. */
const HANDLERS: Record<string, Handler> = {
  accounts,
  "account add": accountAdd,
  "account use": accountUse,
  "account remove": accountRemove,
  "account migrate": accountMigrate,
  "auth link": authLink,
  "auth logout": authLogout,
  chats,
  groups,
  "chat view": chatView,
  events,
  read,
  "message view": messageView,
  send: (c, a) => send(c, a),
  "send-file": sendFile,
  react,
  "mark-read": markRead,
  typing,
  download,
  forget,
  "scope show": scopeShow,
  "scope set": scopeSet,
  "scope dm-from": scopeDMFrom,
  "operators list": operatorsList,
  "operators add": (c, a) => operatorsChange(c, a, true),
  "operators remove": (c, a) => operatorsChange(c, a, false),
  "settings show": settingsShow,
  "settings set": settingsSet,
  "daemon install": daemonInstall,
  "daemon uninstall": daemonUninstall,
  "daemon start": (c, a) => daemonControl(c, a, "start"),
  "daemon stop": (c, a) => daemonControl(c, a, "stop"),
  "daemon restart": (c, a) => daemonControl(c, a, "restart"),
  "daemon status": daemonStatus,
  "daemon logs": daemonLogs,
  "daemon upgrade": daemonUpgrade,
  "daemon run": daemonRun,
  doctor,
  update,
  "setup hooks": setupHooks,
  "setup hooks status": setupHooksStatus,
  "setup hooks uninstall": setupHooksUninstall,
  // Only its --help reaches the dispatcher; the hook itself is handled first in main.
  "session-start": async () => "",
};

const BY_NAME = new Map(SPECS.map((s) => [s.name, s]));
for (const s of SPECS) if (s.jsonOut) jsonOutCommands.push(s.name);

/** Group words (`chat`, `daemon`, `setup hooks`) and their subcommands. */
function subcommands(prefix: string): string[] {
  const words = prefix.split(" ").length;
  return [...new Set(SPECS.filter((s) => s.name.startsWith(`${prefix} `)).map((s) => s.name.split(" ")[words]))];
}

/** Finds the command an argv names: the longest spec name that is a prefix of it. */
function lookup(argv: string[]): { spec: CommandSpec; rest: string[] } {
  let best: CommandSpec | undefined;
  let used = 0;
  for (let n = 1; n <= Math.min(3, argv.length); n++) {
    const s = BY_NAME.get(argv.slice(0, n).join(" "));
    if (s) {
      best = s;
      used = n;
    }
  }
  if (best) return { spec: best, rest: argv.slice(used) };
  // A group named without a subcommand, or with an unknown one.
  const head = argv[0];
  let prefix = head;
  let i = 1;
  // Walk down group words that are themselves only prefixes (none today beyond one level).
  while (i < argv.length && subcommands(`${prefix} ${argv[i]}`).length && !BY_NAME.has(`${prefix} ${argv[i]}`)) prefix = `${prefix} ${argv[i++]}`;
  const subs = subcommands(prefix);
  const next = argv[i];
  if (subs.length && (next === undefined || next.startsWith("-"))) {
    if (next === "--help") throw new HelpRequest(renderGroupHelp(prefix));
    throw usage(
      `\`${prefix}\` needs a subcommand: ${subs.join(", ")}`,
      subs.map((s) => `usage: ${BIN} ${prefix} ${s}`),
    );
  }
  if (subs.length)
    throw invalid(`unknown subcommand ${JSON.stringify(next)} for \`${prefix}\`; valid: ${subs.join(", ")}`, [`Run \`${BIN} ${prefix} --help\` to see them`]);
  throw invalid(`Unknown command: ${head}`, ["Run `whatsapp-axi --help` to see the commands"]);
}

class HelpRequest {
  constructor(readonly text: string) {}
}

function renderGroupHelp(prefix: string): string {
  const specs = SPECS.filter((s) => s.name.startsWith(`${prefix} `));
  const lines = [
    `command: ${prefix}`,
    `subcommands[${specs.length}]:`,
    ...specs.map((s) => `  ${s.name}: ${s.summary}`),
    "help[1]:",
    `  Run \`${BIN} ${prefix} <subcommand> --help\` for usage`,
  ];
  return `${lines.join("\n")}\n`;
}

/** --help anywhere before `--`. */
function wantsHelp(args: string[]): boolean {
  const dd = args.indexOf("--");
  return (dd < 0 ? args : args.slice(0, dd)).some((a) => a === "--help" || a === "-h");
}

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The `account:`, `account_source:` and `tz:` lines, first in the output. */
function header(ctx: Ctx): Obj {
  const h: Obj = {};
  if (ctx.acted) {
    h.account = ctx.acted.name;
    if (ctx.acted.source === "env") h.account_source = "env";
    if (ctx.acted.source === "default") h.account_source = "default";
  }
  if (ctx.tzUsed) h.tz = ctx.tz;
  return h;
}

function decorate(ctx: Ctx, result: unknown): unknown {
  if (!isObj(result)) return result;
  const h = header(ctx);
  for (const k of Object.keys(h)) if (k in result) delete h[k];
  return { ...h, ...result };
}

/** Adds the export lines and the jq hint to a printed object. */
function annotate(result: Obj, lines: Obj, hint: string): Obj {
  const { help, ...rest } = result;
  const prior = Array.isArray(help) ? (help as string[]) : typeof help === "string" ? [help] : [];
  return { ...rest, ...lines, help: [...prior, hint] };
}

function exportLines(f: { path: string; overwrote: boolean; lines: number; columns?: string[] }, what: string): Obj {
  return { [f.overwrote ? "overwrote" : "wrote"]: `${f.path} (${what})`, ...(f.columns?.length ? { columns: f.columns } : {}) };
}

function withoutHelp(result: unknown): unknown {
  if (!isObj(result)) return result;
  const { help: _help, ...rest } = result;
  return rest;
}

/** Commands whose file holds the rows they print, not a daemon body. */
const LOCAL_EXPORT = new Set(["doctor", "daemon status", "daemon upgrade"]);

async function runCommand(io: Io, argv: string[], ctxOut: { ctx?: Ctx }): Promise<unknown> {
  let found: { spec: CommandSpec; rest: string[] };
  try {
    found = lookup(argv);
  } catch (err) {
    if (err instanceof HelpRequest) return err.text;
    throw err;
  }
  const { spec, rest } = found;
  if (wantsHelp(rest)) return renderHelp(spec);
  const ctx = makeCtx(io);
  ctxOut.ctx = ctx;
  ctx.spec = spec;
  const g = takeGlobals(rest);
  if (g.tz !== undefined) ctx.tz = checkZone(g.tz);
  ctx.accountFlag = g.account;
  const args = g.args;
  ctx.argv = args;
  const handler = HANDLERS[spec.name];
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const write: Write = (s) => {
    io.stdout.write(s);
  };
  try {
    return await runHandler(ctx, spec, handler, args, write, ac.signal, io);
  } catch (err) {
    // Errors name the account too, once it was resolved.
    if (err instanceof ToolError) {
      const h = header(ctx);
      delete h.tz;
      err.before = { ...h, ...err.before };
    }
    throw err;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function runHandler(ctx: Ctx, spec: CommandSpec, handler: Handler, argsIn: string[], write: Write, signal: AbortSignal, io: Io): Promise<unknown> {
  let args = argsIn;
  const ac = { signal };
  {
    if (!spec.jsonOut) return decorate(ctx, await handler(ctx, args, write, ac.signal));
    const jo = takeJsonOut(args);
    args = jo.args;
    if (jo.path === undefined) return decorate(ctx, await handler(ctx, args, write, ac.signal));
    // The path is checked and the file opened before anything is done.
    resetOutput();
    const file = openJsonOut(jo.path, spec.name.replace(/ /g, "-"), io.now());
    output.file = file;
    const local = LOCAL_EXPORT.has(spec.name);
    try {
      let result: unknown;
      try {
        result = await handler(ctx, args, write, ac.signal);
      } catch (err) {
        const e = err as { message?: string; code?: string };
        const doc = { error: output.daemonError ?? { code: e.code ?? "INTERNAL_ERROR", message: e.message ?? String(err) } };
        writeDoc(doc);
        closeJsonOut();
        if (err instanceof ToolError && !file.error) {
          err.after = { ...err.after, ...exportLines(file, file.lines > 0 ? `${file.lines} JSON lines then the error` : "the error") };
          err.suggestions.push(jqHint(file.path, doc, file.lines > 0));
        }
        throw err;
      }
      const shown = decorate(ctx, result);
      if (file.lines > 0) {
        closeJsonOut();
        if (file.error) return exportFailed(ctx, shown, file.path, file.error);
        return isObj(shown)
          ? annotate(shown, exportLines(file, `${file.lines} JSON ${file.lines === 1 ? "line" : "lines"}`), jqHint(file.path, undefined, true))
          : shown;
      }
      const doc = local ? (ctx.exportDoc ?? withoutHelp(shown)) : output.body === undefined ? withoutHelp(shown) : output.body;
      writeDoc(doc);
      closeJsonOut();
      // An export failure never undoes a success: the result, then export_error, and exit 1.
      if (file.error) return exportFailed(ctx, shown, file.path, file.error);
      return isObj(shown)
        ? annotate(shown, exportLines(file, local ? "the rows printed" : "the daemon's response body"), jqHint(file.path, doc, false))
        : shown;
    } finally {
      closeJsonOut();
      resetOutput();
    }
  }
}

function exportFailed(ctx: Ctx, shown: unknown, path: string, why: string): unknown {
  ctx.exitCode = 1;
  const base = isObj(shown) ? shown : { result: shown };
  return { ...base, export_error: `${path} could not be written (${why}); the command itself succeeded` };
}

/**
 * Renders any error. A tool error keeps its code; anything else is INTERNAL_ERROR with a doctor
 * hint and no stack trace. Usage-class codes exit 2, everything else 1. An operating-system error
 * code never becomes the tool's code.
 */
export function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError) {
    const e = error as ToolError;
    const out: Obj = { ...e.before, error: error.message, code: error.code, ...e.after };
    if (error.suggestions.length) out.help = error.suggestions;
    return { output: line(out), exitCode: USAGE_CODES.has(error.code) ? 2 : exitCodeFor(error) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: line({
      error: `unexpected failure: ${message.split("\n")[0]}`,
      code: "INTERNAL_ERROR",
      help: ["Run `whatsapp-axi doctor` to check the accounts, the daemons and the files"],
    }),
    exitCode: 1,
  };
}

/** Runs the CLI. Returns the exit code, and sets process.exitCode. */
export async function main(argv: string[] = process.argv.slice(2), io: Io = processIo()): Promise<number> {
  process.exitCode = undefined;
  // The session-start hook: prints its rows or nothing at all, and always exits 0. It is the one
  // place unknown arguments are ignored, since it must never fail a session.
  if (argv[0] === "session-start" && !wantsHelp(argv.slice(1))) {
    let out = "";
    try {
      const rest = argv.slice(1);
      const di = rest.indexOf("--dir");
      const dir = di >= 0 && rest[di + 1] ? rest[di + 1] : undefined;
      out = await hookOutput(makeCtx(io), hookDir(dir, io.cwd));
    } catch {
      out = "";
    }
    if (out) io.stdout.write(out);
    process.exitCode = 0;
    return 0;
  }
  const first = argv[0];
  if (first?.startsWith("-") && !(argv.length === 1 && ["--help", "-v", "-V", "--version"].includes(first))) {
    io.stdout.write(
      line({
        error: `flags come after the command; ${JSON.stringify(first)} came first`,
        code: "USAGE",
        help: [`Run \`${BIN} <command> [args] [flags]\` with the flags last`, DISCOVERY],
      }),
    );
    process.exitCode = 2;
    return 2;
  }
  const holder: { ctx?: Ctx } = {};
  const commands: Record<string, (args: string[]) => Promise<unknown>> = {};
  for (const name of new Set(SPECS.map((s) => s.name.split(" ")[0]))) {
    commands[name] = async (args) => clean(await runCommand(io, [name, ...args], holder));
  }
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    stdout: io.stdout,
    topLevelHelp: renderTopLevelHelp(),
    home: async () => {
      const ctx = makeCtx(io);
      return clean(await home(ctx)) as never;
    },
    commands: commands as never,
    renderUnknownCommand: (command) => line({ error: `Unknown command: ${command}`, code: "VALIDATION_ERROR", help: [DISCOVERY] }),
    formatError,
  });
  const extra = holder.ctx?.exitCode ?? 0;
  const code = typeof process.exitCode === "number" && process.exitCode !== 0 ? process.exitCode : extra;
  process.exitCode = code;
  return code;
}

export { render };
