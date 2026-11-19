// Shared command plumbing: the per-invocation context (accounts, time zone, exit code), the daemon
// client, and small output helpers.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon, expect } from "./client.js";
import { SystemdUser, TEMPLATE, unitDir, unitName, type ServiceManager } from "./service.js";
import { accountEntries, resolveAccount, type AccountSource, type Resolved } from "./config.js";
import { accountPaths, roots, type Env, type Roots } from "./paths.js";
import { localTime, systemZone } from "./output/time.js";
import type { CommandSpec } from "./flags.js";

/** What main(argv, io) takes from its caller: environment, working directory, clock and output. */
export interface Io {
  env: Env;
  cwd: string;
  now: () => number;
  stdout: { write: (chunk: string) => unknown };
  stdin: () => string;
}

export function processIo(): Io {
  return {
    env: process.env,
    cwd: process.cwd(),
    now: () => Date.now(),
    stdout: process.stdout,
    stdin: () => readFileSync(0, "utf-8"),
  };
}

export interface Ctx {
  io: Io;
  roots: Roots;
  /** The daemon client of an account; timeoutMs shortens its request limit (home, hook, doctor). */
  daemon(account: string, timeoutMs?: number): Daemon;
  /** The service manager of the daemon commands (systemd user services on Linux). */
  service: ServiceManager;
  // ---- per invocation, set by the dispatcher ----
  /** The command's own arguments as typed, without the global flags. */
  argv: string[];
  spec?: CommandSpec;
  accountFlag?: string;
  tz: string;
  /** Set when a time was printed, so the output names the zone once. */
  tzUsed: boolean;
  /** The account the command acted on, for the `account:` line. */
  acted?: Resolved;
  /** Raised by a command that prints its result and still fails (a failed mark, a failed export). */
  exitCode: number;
  /**
   * What a local command (doctor, daemon status) writes to its --json-out file, when it differs
   * from what it prints: the file keeps the daemon's UTC instants where the view shows local times.
   */
  exportDoc?: unknown;
}

let serviceFactory: () => ServiceManager = () => new SystemdUser();

/** Replaces the service manager (tests use a fake). */
export function setServiceFactory(f: () => ServiceManager): void {
  serviceFactory = f;
}

/** The timeout of reads: 30 s, or WHATSAPP_AXI_TIMEOUT_MS. */
export function readTimeoutMs(env: Env): number {
  const v = env.WHATSAPP_AXI_TIMEOUT_MS?.trim();
  if (v && /^[0-9]+$/.test(v) && Number(v) > 0) return Number(v);
  return 30_000;
}

export function makeCtx(io: Io): Ctx {
  const r = roots(io.env);
  const ctx: Ctx = {
    io,
    roots: r,
    service: serviceFactory(),
    argv: [],
    tz: systemZone(),
    tzUsed: false,
    exitCode: 0,
    daemon: (a, t) => {
      const d = new Daemon(a, accountPaths(a, r).socket, t ?? readTimeoutMs(io.env), acctFlag(ctx, a), t === undefined);
      // Whether the account is installed as a service, for the DAEMON_NOT_RUNNING hint.
      d.installed = () => existsSync(join(unitDir(r), "default.target.wants", unitName(a))) && existsSync(join(unitDir(r), TEMPLATE));
      return d;
    },
  };
  return ctx;
}

/**
 * The choices WHATSAPP_AXI_CONFIG_DIR and WHATSAPP_AXI_DAEMON made, echoed in home and doctor
 * (specs/conventions.md "Environment variables"). Empty when neither is set.
 */
export function envChoices(ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = {};
  const cfg = ctx.io.env.WHATSAPP_AXI_CONFIG_DIR;
  if (ctx.roots.configFromEnv) out.config_dir = `${ctx.roots.config} (WHATSAPP_AXI_CONFIG_DIR)`;
  else if (cfg) out.config_dir = `${ctx.roots.config} (WHATSAPP_AXI_CONFIG_DIR is ignored: ${cfg} is not an absolute path)`;
  const bin = ctx.io.env.WHATSAPP_AXI_DAEMON;
  if (bin) out.daemon_binary = `${bin} (WHATSAPP_AXI_DAEMON)`;
  return out;
}

/** Resolves the account of the running command, and records it for the `account:` line. */
export function account(ctx: Ctx, opts: { positional?: string; mutation?: boolean } = {}): string {
  const spec = ctx.spec;
  const res = resolveAccount({
    roots: ctx.roots,
    env: ctx.io.env,
    flag: ctx.accountFlag,
    positional: opts.positional,
    mutation: opts.mutation ?? spec?.mutation === true,
    argv: [...(spec?.name.split(" ") ?? []), ...ctx.argv],
    command: spec?.name ?? "",
  });
  ctx.acted = res;
  return res.name;
}

export type { AccountSource };

/** Carries --account into suggested commands only when the user has more than one account. */
export function acctFlag(ctx: Ctx, name: string): string {
  try {
    return accountEntries(ctx.roots).length > 1 ? ` --account ${name}` : "";
  } catch {
    return ` --account ${name}`;
  }
}

/** An instant in the output's zone; marks the zone as used so the output names it. */
export function time(ctx: Ctx, iso: unknown): string | undefined {
  if (typeof iso !== "string" || !iso) return undefined;
  ctx.tzUsed = true;
  return localTime(iso, ctx.tz);
}

/** Truncates text for a list cell. */
export function cell(text: unknown, max = 80): string {
  const s = String(text ?? "").replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const DETAIL_LIMIT = 1500;

/** Truncates long text in a detail view, saying how long it was. */
export function longText(text: string, full: boolean): { text: string; truncated: boolean } {
  if (full || text.length <= DETAIL_LIMIT) return { text, truncated: false };
  return { text: `${text.slice(0, DETAIL_LIMIT)}… (truncated, ${text.length} chars total)`, truncated: true };
}

/** Builds list rows from objects, keeping only the chosen keys in order (absent cells print as "-"). */
export function pick<T extends Record<string, unknown>>(rows: T[], keys: string[]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null])));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "N of M", the size of a list against the whole. A missing total is UNEXPECTED_RESPONSE, never invented. */
export function countOf(d: Daemon, n: number, total: unknown): string {
  expect(d, typeof total === "number" && total >= n, "a list without a numeric total");
  return `${n} of ${total}`;
}

/** What a mark did, as the daemon reports it (specs/daemon.md "Receipts and typing"). */
export interface MarkOutcome {
  marked: number;
  already_marked: number;
  failed: number;
  reason?: string;
}

/** A mark answer; every count must be there (fail closed). */
export function asMarkOutcome(d: Daemon, v: unknown): MarkOutcome {
  const o = v as Record<string, unknown> | null | undefined;
  expect(
    d,
    o && typeof o === "object" && typeof o.marked === "number" && typeof o.already_marked === "number" && typeof o.failed === "number",
    "a mark answer without marked, already_marked and failed",
  );
  return {
    marked: o.marked as number,
    already_marked: o.already_marked as number,
    failed: o.failed as number,
    ...(typeof o.reason === "string" && o.reason ? { reason: o.reason } : {}),
  };
}

/** The fix for a mark that was not sent, by reason. */
export function markFix(reason: string | undefined, af: string, retry: string): string {
  switch (reason) {
    case "off":
      return `Run \`whatsapp-axi settings set read_receipts on-read${af}\` to send read receipts, then \`${retry}\``;
    case "not_connected":
      return `Run \`whatsapp-axi doctor${af}\` to see why the account is not connected, then \`${retry}\``;
    default:
      return `Run \`${retry}\` to try the read receipts again (the daemon's log has the cause)`;
  }
}

/** The error part of an output whose mark failed (specs/conventions.md: failed marks use the error shape). */
export function markError(ctx: Ctx, m: MarkOutcome, af: string, retry: string): { error: string; code: string; help: string[] } {
  ctx.exitCode = 1;
  const what = m.marked ? `${m.marked} marked read, ${m.failed} not marked` : `${m.failed} not marked read`;
  return { error: `${what} (${m.reason ?? "unknown reason"})`, code: "MARK_FAILED", help: [markFix(m.reason, af, retry)] };
}
