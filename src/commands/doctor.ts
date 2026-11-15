// doctor: the checks that need neither a service nor a link (plans/cli-core.md). Files and modes,
// the daemon on its socket, protocol and versions, the account's state, last phone activity, and
// the wake file.
import { accessSync, constants, statSync } from "node:fs";
import { dirname } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parse, type CommandSpec } from "../args.js";
import { startCommand, type Status } from "../client.js";
import { usage } from "../errors.js";
import { listAccounts, accountPaths, validAccount } from "../paths.js";
import { VERSION } from "../version.js";
import type { Ctx } from "../context.js";

interface Check {
  check: string;
  result: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export const doctorSpec: CommandSpec = {
  name: "doctor",
  summary: "Check every account, or one, and name the fix for anything wrong",
  positionals: [],
  flags: { account: { type: "string", value: "<name>", desc: "check only this account" } },
  examples: ["whatsapp-axi doctor", "whatsapp-axi doctor --account example"],
};

const STOPPED: Record<string, string> = {
  logged_out: "WhatsApp ended the session (removed on the phone, the phone unused too long, or the account was banned); the account must be linked again",
  outdated: "WhatsApp rejected the client as too old; only a release built on a newer library fixes this",
  suspended: "WhatsApp applied a temporary ban; the daemon waits for its expiry",
};

const DAY = 24 * 60 * 60 * 1000;

function modeCheck(path: string, dir: boolean): Check | undefined {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { check: "files", result: "fail", detail: `${path} is missing`, fix: "Recreate the account with `whatsapp-axi account add <name>`" };
  }
  if ((st.mode & 0o077) !== 0) {
    return { check: "files", result: "fail", detail: `${path} has mode ${(st.mode & 0o777).toString(8)}`, fix: `chmod ${dir ? 700 : 600} ${path}` };
  }
  if (process.getuid && st.uid !== process.getuid()) return { check: "files", result: "fail", detail: `${path} is owned by another user` };
  return undefined;
}

async function checkAccount(ctx: Ctx, name: string, now: number): Promise<{ account: string; checks: Check[] }> {
  const checks: Check[] = [];
  const p = accountPaths(name, ctx.roots);
  const fileProblems = [modeCheck(p.configDir, true), modeCheck(p.settings, false), modeCheck(p.stateDir, true)].filter(Boolean) as Check[];
  checks.push(...(fileProblems.length ? fileProblems : [{ check: "files", result: "ok" as const, detail: "present and owner-only" }]));

  const d = ctx.daemon(name);
  let st: Status;
  try {
    st = await d.status();
  } catch (err) {
    if (err instanceof AxiError && err.code === "daemon_not_running") {
      checks.push({ check: "daemon", result: "fail", detail: "not running", fix: startCommand(name) });
    } else if (err instanceof AxiError) {
      checks.push({ check: "daemon", result: "fail", detail: `${err.code}: ${err.message}`, ...(err.suggestions[0] ? { fix: err.suggestions[0] } : {}) });
    } else throw err;
    return { account: name, checks };
  }
  checks.push({ check: "daemon", result: "ok", detail: `answering, protocol ${st.protocol}` });
  checks.push(
    st.daemon_version === VERSION
      ? { check: "versions", result: "ok", detail: `cli ${VERSION}, daemon ${st.daemon_version}, library ${st.library_version}` }
      : {
          check: "versions",
          result: "warn",
          detail: `cli ${VERSION}, running daemon ${st.daemon_version} (library ${st.library_version})`,
          fix: "Restart the daemon with the binary that came with this CLI",
        },
  );
  const stopped = STOPPED[st.state];
  checks.push({
    check: "state",
    result: stopped ? "fail" : st.state === "connected" ? "ok" : "warn",
    detail: `${st.state} since ${st.since}${st.reason ? ` (${st.reason})` : ""}${stopped ? `: ${stopped}` : ""}`,
  });
  if (st.last_phone_activity) {
    const age = now - Date.parse(st.last_phone_activity);
    const days = Math.floor(age / DAY);
    checks.push(
      age > 12 * DAY
        ? {
            check: "phone",
            result: "warn",
            detail: `last phone activity (approximate) ${st.last_phone_activity}, ${days} days ago; WhatsApp logs out linked devices whose phone has been away about two weeks`,
            fix: "Open WhatsApp on the account's phone",
          }
        : { check: "phone", result: "ok", detail: `last phone activity (approximate) ${st.last_phone_activity}` },
    );
  } else if (st.state !== "unlinked") {
    checks.push({ check: "phone", result: "ok", detail: "no phone activity seen yet (approximate)" });
  }
  const s = await d.call("GET", "/v1/settings");
  const wake = (s.settings as { wake_file?: unknown } | undefined)?.wake_file;
  if (typeof wake === "string") {
    let ok = false;
    try {
      accessSync(wake, constants.W_OK);
      ok = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          accessSync(dirname(wake), constants.W_OK);
          ok = true;
        } catch {
          ok = false;
        }
      }
    }
    checks.push(ok ? { check: "wake_file", result: "ok", detail: `${wake} is writable` } : { check: "wake_file", result: "fail", detail: `${wake} is not writable`, fix: `Make ${wake} writable, or run \`whatsapp-axi settings set wake_file none\`` });
  }
  return { account: name, checks };
}

export async function doctor(ctx: Ctx, args: string[], now = Date.now()): Promise<unknown> {
  const p = parse(doctorSpec, args);
  let names = listAccounts(ctx.roots);
  if (p.flags.account !== undefined) {
    const a = String(p.flags.account);
    if (!validAccount(a)) throw usage(`bad account name ${JSON.stringify(a)}`);
    if (!names.includes(a)) {
      process.exitCode = 1;
      return {
        doctor: [{ account: a, check: "files", result: "fail", detail: "no such account" }],
        result: "1 problem",
        help: [`Run \`whatsapp-axi account add ${a}\` to create it`],
      };
    }
    names = [a];
  }
  if (names.length === 0) return { doctor: "0 accounts to check", help: ["Run `whatsapp-axi account add <name>` to create one"] };
  const results = [];
  for (const n of names) results.push(await checkAccount(ctx, n, now));
  const rows = results.flatMap((r) => r.checks.map((c) => ({ account: r.account, check: c.check, result: c.result, detail: c.detail })));
  const fixes = results.flatMap((r) => r.checks.filter((c) => c.fix).map((c) => `${r.account} ${c.check}: ${c.fix}`));
  const fails = rows.filter((r) => r.result === "fail").length;
  const warns = rows.filter((r) => r.result === "warn").length;
  if (fails) process.exitCode = 1;
  return {
    doctor: rows,
    result: fails || warns ? `${fails} failed, ${warns} warnings` : "all checks passed",
    ...(fixes.length ? { help: fixes } : {}),
  };
}
