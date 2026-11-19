// doctor (specs/conventions.md "Home, hook and doctor"): rows `{account,check,status,detail}`
// with status ok, fail or skipped. A check that depends on a failed one is skipped, naming what it
// needs; nothing is omitted. Probes have two seconds each and run in parallel, and no failure of
// one probe or one account stops the rest. Any fail exits 1.
import { accessSync, constants, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parse, type CommandSpec } from "../flags.js";
import { type Status } from "../client.js";
import { clip, invalid, reasonOf } from "../errors.js";
import { accountEntries, pinOf, PIN_VAR, readDefault } from "../config.js";
import { accountPaths, configFile, legacyAccounts, legacyPaths, validAccount, type AccountEntry } from "../paths.js";
import { VERSION } from "../version.js";
import { binaryVersion, isInstalled } from "./daemon.js";
import { hookDir, hookStatus } from "./setup.js";
import { installedBinary, unitName } from "../service.js";
import { time, type Ctx } from "../context.js";

type Status3 = "ok" | "fail" | "skipped";

interface Check {
  check: string;
  status: Status3;
  detail: string;
  /** A runnable fix, printed as a hint. */
  fix?: string;
  /** The detail with the daemon's UTC instants, for the --json-out file, when it differs. */
  raw?: string;
}

export const doctorSpec: CommandSpec = {
  name: "doctor",
  summary: "Check every account, or one, and name the fix for anything wrong; --summary prints one line",
  positionals: [],
  flags: { summary: { type: "bool", desc: "print one line: ok, or how many checks failed and which" } },
  examples: ["whatsapp-axi doctor", "whatsapp-axi doctor --account example", "whatsapp-axi doctor --summary"],
  account: "all",
  jsonOut: true,
};

/** The probe budget of each check that asks the daemon or the system. */
export const PROBE = { ms: 2_000 };

const STOPPED: Record<string, string> = {
  logged_out: "WhatsApp ended the session (removed on the phone, the phone unused too long, or the account was banned); the account must be linked again",
  outdated: "WhatsApp rejected the client as too old; only a release built on a newer library fixes this",
  suspended: "WhatsApp applied a temporary ban; the daemon waits for its expiry",
};

const DAY = 24 * 60 * 60 * 1000;

function skipped(check: string, needs: string): Check {
  return { check, status: "skipped", detail: `needs ${needs}` };
}

/** Races a probe against its budget: a probe that hangs is a fail, never a hung doctor. */
async function probe<T>(p: Promise<T>, ms = PROBE.ms): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AxiError(`no answer in ${ms / 1000} s`, "TIMEOUT")), ms + 100);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

function modeProblem(path: string, dir: boolean): string | undefined {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    return `${path} is ${(err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `unreadable (${(err as NodeJS.ErrnoException).code})`}`;
  }
  if (st.isSymbolicLink()) return `${path} is a symbolic link`;
  if ((st.mode & 0o077) !== 0) return `${path} has mode ${(st.mode & 0o777).toString(8)}; fix: chmod ${dir ? 700 : 600} ${path}`;
  if (process.getuid && st.uid !== process.getuid()) return `${path} is owned by another user`;
  return undefined;
}

function wakeCheck(wake: unknown): Check {
  if (typeof wake !== "string") return { check: "wake_file", status: "ok", detail: "not set" };
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
  return ok
    ? { check: "wake_file", status: "ok", detail: `${wake} is writable` }
    : { check: "wake_file", status: "fail", detail: `${wake} is not writable`, fix: "whatsapp-axi settings set wake_file none" };
}

const ALL_ROWS = ["files", "service", "lingering", "binary", "daemon", "versions", "link", "state", "phone", "wake_file"];

async function checkAccount(ctx: Ctx, e: AccountEntry, now: number): Promise<Check[]> {
  const name = e.name;
  const af = (() => {
    try {
      return accountEntries(ctx.roots).length > 1 ? ` --account ${name}` : "";
    } catch {
      return ` --account ${name}`;
    }
  })();
  const checks: Check[] = [];
  // files
  const p = accountPaths(name, ctx.roots);
  const problems = e.problem
    ? [e.problem]
    : [modeProblem(p.configDir, true), modeProblem(p.settings, false), modeProblem(p.stateDir, true)].filter((x): x is string => !!x);
  checks.push(
    problems.length
      ? { check: "files", status: "fail", detail: clip(problems.join("; "), 300) }
      : { check: "files", status: "ok", detail: "present and owner-only" },
  );

  // The service, lingering and the installed binary, asked in parallel with the daemon.
  const s = ctx.service;
  const daemonP: Promise<{ st?: Status; err?: unknown }> = probe(ctx.daemon(name, PROBE.ms).status()).then(
    (st) => ({ st }),
    (err: unknown) => ({ err }),
  );
  const serviceP = (async (): Promise<{ installed?: boolean; active?: string; sub?: string; err?: unknown }> => {
    if (!s.supported()) return {};
    try {
      const installed = isInstalled(ctx, name);
      if (!installed) return { installed };
      const u = await probe(s.show(unitName(name)));
      return { installed, active: u.active, sub: u.sub };
    } catch (err) {
      return { err };
    }
  })();
  const lingerP = s.supported() ? probe(s.lingering()).catch(() => undefined) : Promise.resolve(undefined);
  const binP = probe(binaryVersion(installedBinary(ctx.roots), ctx.io.env)).catch(() => undefined);
  const [d, sv, linger, bin] = await Promise.all([daemonP, serviceP, lingerP, binP]);

  // service
  let installed = false;
  if (!s.supported()) checks.push({ check: "service", status: "skipped", detail: "needs systemd user services (Linux); run the daemon with `daemon run`" });
  else if (sv.err) checks.push({ check: "service", status: "fail", detail: reasonOf(sv.err), fix: "whatsapp-axi daemon status " + name });
  else if (sv.installed) {
    installed = true;
    checks.push(
      sv.active === "active"
        ? { check: "service", status: "ok", detail: `${unitName(name)} installed, ${sv.active} (${sv.sub})` }
        : { check: "service", status: "fail", detail: `${unitName(name)} installed but ${sv.active} (${sv.sub})`, fix: `whatsapp-axi daemon start ${name}` },
    );
  } else if (d.st) checks.push({ check: "service", status: "ok", detail: "not a service: a foreground daemon answers" });
  else
    checks.push({ check: "service", status: "fail", detail: "not installed as a service, and no daemon answers", fix: `whatsapp-axi daemon install ${name}` });

  // lingering
  if (!s.supported() || !installed) checks.push(skipped("lingering", "an installed service"));
  else if (linger === true) checks.push({ check: "lingering", status: "ok", detail: `on for ${s.user()}` });
  else
    checks.push({
      check: "lingering",
      status: "fail",
      detail: `${linger === false ? "off" : "unknown"} for ${s.user()}: the service stops when the last login session ends`,
      fix: `loginctl enable-linger ${s.user()}`,
    });

  // binary: the installed binary against this CLI
  if (!installed) checks.push(skipped("binary", "an installed service"));
  else if (bin === undefined)
    checks.push({ check: "binary", status: "fail", detail: `${installedBinary(ctx.roots)} is missing or does not run`, fix: "whatsapp-axi daemon upgrade" });
  else if (bin !== VERSION)
    checks.push({ check: "binary", status: "fail", detail: `installed binary ${bin}, cli ${VERSION}`, fix: "whatsapp-axi daemon upgrade" });
  else checks.push({ check: "binary", status: "ok", detail: `installed binary ${bin} matches the cli` });

  // daemon
  if (!d.st) {
    const err = d.err;
    const code = err instanceof AxiError ? err.code : "INTERNAL_ERROR";
    checks.push({
      check: "daemon",
      status: "fail",
      detail: reasonOf(err),
      fix:
        code === "DAEMON_NOT_RUNNING"
          ? installed
            ? `whatsapp-axi daemon start ${name}`
            : `whatsapp-axi daemon install ${name}`
          : `whatsapp-axi daemon status ${name}`,
    });
    for (const c of ["versions", "link", "state", "phone", "wake_file"]) checks.push(skipped(c, "the daemon answering"));
    return checks;
  }
  const st = d.st;
  checks.push({ check: "daemon", status: "ok", detail: `answering, protocol ${st.protocol}` });
  checks.push(
    st.daemon_version === VERSION
      ? { check: "versions", status: "ok", detail: `cli ${VERSION}, daemon ${st.daemon_version}, library ${st.library_version}` }
      : {
          check: "versions",
          status: "fail",
          detail: `cli ${VERSION}, running daemon ${st.daemon_version} (library ${st.library_version})`,
          fix: installed ? (bin === VERSION ? `whatsapp-axi daemon restart ${name}` : "whatsapp-axi daemon upgrade") : `whatsapp-axi daemon run ${name}`,
        },
  );
  const stopped = STOPPED[st.state];
  const linkFix = `whatsapp-axi auth link --phone <number>${af}`;
  if (st.me) checks.push({ check: "link", status: "ok", detail: `linked as ${st.me.pn ?? st.me.id}` });
  else if (st.state === "linking") checks.push({ check: "link", status: "ok", detail: "a link attempt is running" });
  else checks.push({ check: "link", status: "fail", detail: "not linked to WhatsApp", fix: linkFix });
  const sinceOf = (t: string) => `${st.state} since ${t}${st.reason ? ` (${st.reason})` : ""}`;
  const since = sinceOf(time(ctx, st.since) ?? st.since);
  const sinceRaw = sinceOf(st.since);
  if (stopped) {
    const fix =
      st.state === "logged_out"
        ? linkFix
        : st.state === "suspended"
          ? `whatsapp-axi daemon restart ${name}`
          : st.state === "outdated"
            ? "whatsapp-axi update"
            : undefined;
    const after =
      st.state === "suspended"
        ? "; restart after the expiry named in the reason"
        : st.state === "outdated"
          ? "; upgrade the package (`whatsapp-axi update`), then run `whatsapp-axi daemon upgrade`"
          : "";
    const tail = `: ${stopped}${after}`;
    checks.push({ check: "state", status: "fail", detail: `${since}${tail}`, raw: `${sinceRaw}${tail}`, ...(fix ? { fix } : {}) });
  } else checks.push({ check: "state", status: "ok", detail: since, raw: sinceRaw });
  if (!st.me) checks.push(skipped("phone", "a link"));
  else if (st.last_phone_activity) {
    const age = now - Date.parse(st.last_phone_activity);
    const days = Math.floor(age / DAY);
    const shown = time(ctx, st.last_phone_activity) ?? st.last_phone_activity;
    const stale = `, ${days} days ago; WhatsApp unlinks a device whose phone has been away about fourteen days: open WhatsApp on the account's phone`;
    checks.push(
      age >= 12 * DAY
        ? {
            check: "phone",
            status: "fail",
            detail: `last phone activity (approximate) ${shown}${stale}`,
            raw: `last phone activity (approximate) ${st.last_phone_activity}${stale}`,
          }
        : {
            check: "phone",
            status: "ok",
            detail: `last phone activity (approximate) ${shown}, ${days} days ago`,
            raw: `last phone activity (approximate) ${st.last_phone_activity}, ${days} days ago`,
          },
    );
  } else checks.push({ check: "phone", status: "ok", detail: "no phone activity seen yet (approximate)" });
  try {
    const set = await probe(ctx.daemon(name, PROBE.ms).call("GET", "/v1/settings"));
    checks.push(wakeCheck((set.settings as { wake_file?: unknown } | undefined)?.wake_file));
  } catch (err) {
    checks.push({ check: "wake_file", status: "fail", detail: `the settings could not be read (${reasonOf(err)})`, fix: `whatsapp-axi daemon status ${name}` });
  }
  return checks;
}

/** An account still in the old layout: a fail row with the move, and the rest skipped. */
function legacyChecks(ctx: Ctx, name: string): Check[] {
  const old = legacyPaths(name, ctx.roots);
  return [
    {
      check: "files",
      status: "fail",
      detail: `in the old layout (${old.configDir}, ${old.stateDir}); it is not used until moved`,
      fix: `whatsapp-axi account migrate ${name}`,
    },
    ...ALL_ROWS.slice(1).map((c) => skipped(c, "the account in place")),
  ];
}

function hooksCheck(ctx: Ctx): Check {
  try {
    const st = hookStatus(ctx, "user", hookDir(undefined, ctx.io.cwd));
    const broken = st.rows.filter((r) => r.status === "stale" || r.status === "error");
    if (broken.length) {
      return {
        check: "hooks",
        status: "fail",
        detail: broken
          .map((r) => `${r.agent} ${r.status}${r.status === "error" ? ` (${st.problems.find((x) => x.path === r.path)?.problem ?? "unreadable"})` : ""}`)
          .join(", "),
        fix: "whatsapp-axi setup hooks",
      };
    }
    const installed = st.rows.filter((r) => r.status === "installed").map((r) => r.agent);
    if (!installed.length) return { check: "hooks", status: "skipped", detail: "not installed at user scope (optional)" };
    return { check: "hooks", status: "ok", detail: `installed at user scope for ${installed.join(", ")}` };
  } catch (err) {
    return { check: "hooks", status: "fail", detail: reasonOf(err), fix: "whatsapp-axi setup hooks status" };
  }
}

/** The hint line of a fix: `Run \`<fix>\` to fix <check> of <account>`. */
export function fixLine(account: string, check: string, fix: string): string {
  return `Run \`${fix}\` to fix ${check} of ${account}`;
}

export async function doctor(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(doctorSpec, args);
  const now = ctx.io.now();
  const out: Record<string, unknown> = {};
  const rows: { account: string; check: string; status: Status3; detail: string }[] = [];
  const rawRows: { account: string; check: string; status: Status3; detail: string }[] = [];
  const fixes: string[] = [];
  const add = (account: string, checks: Check[]) => {
    for (const c of checks) {
      rows.push({ account, check: c.check, status: c.status, detail: c.detail });
      rawRows.push({ account, check: c.check, status: c.status, detail: c.raw ?? c.detail });
      if (c.status === "fail" && c.fix) fixes.push(fixLine(account, c.check, c.fix));
    }
  };

  let entries: AccountEntry[] = [];
  try {
    entries = accountEntries(ctx.roots);
  } catch (err) {
    add("-", [{ check: "accounts", status: "fail", detail: reasonOf(err) }]);
  }
  let legacy: string[] = [];
  try {
    legacy = legacyAccounts(ctx.roots).filter((n) => !entries.some((e) => e.name === n));
  } catch {
    legacy = [];
  }
  const pin = pinOf(ctx.io.env);
  if (pin !== undefined) out.account_lock = `${pin} (${PIN_VAR}); doctor checks every account regardless`;
  try {
    const def = readDefault(ctx.roots);
    if (def !== undefined && !entries.some((e) => e.name === def))
      add("-", [
        { check: "default", status: "fail", detail: `${configFile(ctx.roots)} names ${def}, which does not exist`, fix: "whatsapp-axi account use <name>" },
      ]);
  } catch (err) {
    add("-", [{ check: "default", status: "fail", detail: reasonOf(err) }]);
  }

  let names = entries;
  if (ctx.accountFlag !== undefined) {
    const a = ctx.accountFlag;
    if (!validAccount(a)) throw invalid(`bad account name ${JSON.stringify(a)}: names match ^[a-z][a-z0-9-]{0,23}$`);
    names = entries.filter((e) => e.name === a);
    legacy = legacy.filter((n) => n === a);
    ctx.acted = { name: a, source: "flag" };
    if (!names.length && !legacy.length) {
      add(a, [
        { check: "files", status: "fail", detail: "no such account", fix: `whatsapp-axi account add ${a}` },
        ...ALL_ROWS.slice(1).map((c) => skipped(c, "the account")),
      ]);
    }
  }
  if (pin !== undefined && !entries.some((e) => e.name === pin)) {
    add(pin, [
      {
        check: "pin",
        status: "fail",
        detail: `${PIN_VAR} names an account that does not exist; every command fails with ACCOUNT_LOCK_INVALID`,
        fix: "whatsapp-axi accounts",
      },
    ]);
  }
  const results = await Promise.all(
    names.map(async (e) => ({
      account: e.name,
      checks: await checkAccount(ctx, e, now).catch((err): Check[] => [{ check: "doctor", status: "fail", detail: reasonOf(err) }]),
    })),
  );
  for (const r of results) add(r.account, r.checks);
  for (const n of legacy) add(n, legacyChecks(ctx, n));
  add("(all)", [hooksCheck(ctx)]);

  const failed = rows.filter((r) => r.status === "fail");
  if (failed.length) ctx.exitCode = 1;
  if (!entries.length && !legacy.length && ctx.accountFlag === undefined) {
    fixes.push("Run `whatsapp-axi account add <name>` to create an account");
  }
  if (p.flags.summary) {
    // One line: no time is shown, so no zone is named.
    ctx.tzUsed = false;
    return {
      doctor: failed.length
        ? `${failed.length} failed of ${rows.length} checks: ${failed.map((r) => `${r.account} ${r.check}`).join(", ")}`
        : `all ${rows.length} checks passed`,
      ...(failed.length ? { help: ["Run `whatsapp-axi doctor` to see each check and its fix"] } : {}),
    };
  }
  const summary = failed.length ? `${failed.length} failed of ${rows.length} checks` : `${rows.length} checks, none failed`;
  ctx.exportDoc = { ...(ctx.acted ? { account: ctx.acted.name } : {}), ...out, summary, checks: rawRows };
  return {
    ...out,
    summary: failed.length ? `${failed.length} failed of ${rows.length} checks` : `${rows.length} checks, none failed`,
    checks: rows,
    ...(fixes.length ? { help: fixes } : {}),
  };
}
