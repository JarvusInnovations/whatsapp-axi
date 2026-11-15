// Shared command plumbing: choosing the account (specs/cli.md "Choosing the account"), the daemon
// client, and small output helpers.
import { Daemon } from "./client.js";
import { failure, usage } from "./errors.js";
import { accountExists, listAccounts, roots, validAccount, accountPaths, type Roots } from "./paths.js";

export interface Ctx {
  roots: Roots;
  daemon(account: string): Daemon;
}

export function defaultCtx(): Ctx {
  const r = roots();
  return { roots: r, daemon: (a) => new Daemon(a, accountPaths(a, r).socket) };
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
