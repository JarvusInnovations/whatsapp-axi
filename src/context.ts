// Shared command plumbing: choosing the account (specs/cli.md "Choosing the account"), the daemon
// client, and small output helpers.
import { Daemon } from "./client.js";
import { SystemdUser, type ServiceManager } from "./service.js";
import { failure, usage } from "./errors.js";
import { accountExists, listAccounts, roots, validAccount, accountPaths, type Roots } from "./paths.js";

export interface Ctx {
  roots: Roots;
  /** The daemon client of an account; timeoutMs shortens its request limit (the home view). */
  daemon(account: string, timeoutMs?: number): Daemon;
  /** The service manager of the daemon commands (systemd user services on Linux). */
  service: ServiceManager;
}

let serviceFactory: () => ServiceManager = () => new SystemdUser();

/** Replaces the service manager (tests use a fake). */
export function setServiceFactory(f: () => ServiceManager): void {
  serviceFactory = f;
}

export function defaultCtx(): Ctx {
  const r = roots();
  return { roots: r, daemon: (a, t) => new Daemon(a, accountPaths(a, r).socket, t), service: serviceFactory() };
}

/** Resolves --account: required with several accounts, optional with exactly one. */
export function chooseAccount(ctx: Ctx, flag: unknown, command: string): string {
  const accounts = listAccounts(ctx.roots);
  if (typeof flag === "string") {
    if (!validAccount(flag)) throw usage(`bad account name ${JSON.stringify(flag)}: names match ^[a-z][a-z0-9-]{0,23}$`);
    if (!accounts.includes(flag)) {
      throw failure(`No account named ${flag}.`, "no_account", [
        accounts.length ? `Accounts: ${accounts.join(", ")}` : "There are no accounts yet",
        `Run \`whatsapp-axi account add ${flag}\` to create it`,
      ]);
    }
    return flag;
  }
  if (accounts.length === 1) return accounts[0];
  if (accounts.length === 0) {
    throw failure("There are no accounts yet.", "no_account", ["Run `whatsapp-axi account add <name>` to create one"]);
  }
  throw usage(`--account is required: there are ${accounts.length} accounts (${accounts.join(", ")})`, [
    `Run \`whatsapp-axi ${command} --account <name>\` with one of: ${accounts.join(", ")}`,
  ]);
}

export function requireAccountName(name: string): string {
  if (!validAccount(name)) throw usage(`bad account name ${JSON.stringify(name)}: names match ^[a-z][a-z0-9-]{0,23}$ (a local label, not a phone number)`);
  return name;
}

export { accountExists };

/** Truncates text for a list cell. */
export function cell(text: unknown, max = 80): string {
  const s = String(text ?? "").replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const DETAIL_LIMIT = 1500;

/** Truncates long text in a detail view, saying how long it was. */
export function longText(text: string, full: boolean): { text: string; truncated: boolean } {
  if (full || text.length <= DETAIL_LIMIT) return { text, truncated: false };
  return { text: `${text.slice(0, DETAIL_LIMIT)}... (truncated, ${text.length} chars total)`, truncated: true };
}

/** Builds list rows from objects, keeping only the chosen keys in order. */
export function pick<T extends Record<string, unknown>>(rows: T[], keys: string[]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null])));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a mark did, as the daemon reports it (specs/daemon.md "Receipts and typing"). */
export interface MarkOutcome {
  marked: number;
  already_marked: number;
  failed: number;
  reason?: string;
}

export function asMarkOutcome(v: unknown): MarkOutcome | undefined {
  const o = v as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== "object" || typeof o.marked !== "number") return undefined;
  return {
    marked: o.marked,
    already_marked: typeof o.already_marked === "number" ? o.already_marked : 0,
    failed: typeof o.failed === "number" ? o.failed : 0,
    ...(typeof o.reason === "string" && o.reason ? { reason: o.reason } : {}),
  };
}

/** The fix for a mark that was not sent, by reason. */
export function markFix(reason: string | undefined, af: string, retry: string): string {
  switch (reason) {
    case "off":
      return `read_receipts is off, so no read receipt is sent; run \`whatsapp-axi settings set read_receipts on-read${af}\` to send them, then \`${retry}\``;
    case "not_connected":
      return `The account is not connected; run \`whatsapp-axi doctor${af}\`, then \`${retry}\` once it is connected`;
    default:
      return `WhatsApp did not take the read receipt; run \`${retry}\` to try again (the daemon's log has the cause)`;
  }
}

/**
 * Sets exit code 1 when a mark that was asked for was not fully sent; the command still prints what
 * it read. Returns the help line naming the fix, or undefined when everything was marked.
 */
export function markFailed(m: MarkOutcome | undefined, af: string, retry: string): string | undefined {
  if (!m || m.failed === 0) return undefined;
  process.exitCode = 1;
  return markFix(m.reason, af, retry);
}
