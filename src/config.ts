// Accounts: the default, the pin and resolution (specs/conventions.md "Accounts"). Resolution,
// highest first: the pin WHATSAPP_AXI_ACCOUNT; --account (or the account positional of the daemon
// commands); the default set by `account use`; the only account. Reads may use the default;
// mutations may not once there are two or more accounts.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { BIN, ToolError, failure, invalid } from "./errors.js";
import { configFile, envVar, listAccountEntries, ListError, validAccount, type AccountEntry, type Env, type Roots } from "./paths.js";

export const PIN_VAR = "WHATSAPP_AXI_ACCOUNT";

export type AccountSource = "flag" | "env" | "default" | "only";

export interface Resolved {
  name: string;
  source: AccountSource;
}

/** The accounts, failing as CONFIG_INVALID when the accounts directory cannot be read. */
export function accountEntries(r: Roots): AccountEntry[] {
  try {
    return listAccountEntries(r);
  } catch (err) {
    if (err instanceof ListError)
      throw failure(`The accounts directory cannot be read: ${err.message}`, "CONFIG_INVALID", [`Run \`${BIN} doctor\` to check the files`]);
    throw err;
  }
}

/** The default account from <config>/config.json; undefined when unset. A file that does not parse is CONFIG_INVALID. */
export function readDefault(r: Roots): string | undefined {
  const path = configFile(r);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw failure(`${path} cannot be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`, "CONFIG_INVALID", [
      `Run \`${BIN} doctor\` to check the files`,
    ]);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw failure(`${path} is not valid JSON; it was left as it is`, "CONFIG_INVALID", [`Fix or delete ${path}, then run \`${BIN} account use <name>\``]);
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw failure(`${path} is not a JSON object; it was left as it is`, "CONFIG_INVALID", [`Fix or delete ${path}`]);
  const d = (v as Record<string, unknown>).default_account;
  if (d === undefined || d === null) return undefined;
  if (typeof d !== "string" || !validAccount(d))
    throw failure(`${path}: default_account is not an account name; it was left as it is`, "CONFIG_INVALID", [`Fix or delete ${path}`]);
  return d;
}

/** Writes the default atomically (0600 in a 0700 directory), keeping the file's other keys. */
export function writeDefault(r: Roots, name: string): void {
  const path = configFile(r);
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // readDefault already refused a file that does not parse; never overwrite one.
      throw failure(`${path} cannot be read; it was left as it is`, "CONFIG_INVALID", [`Fix or delete ${path}`]);
    }
  }
  doc.default_account = name;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.new-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The pin, when set. */
export function pinOf(env: Env): string | undefined {
  return envVar(env, PIN_VAR);
}

/** POSIX-quotes one argument for a runnable hint, only when it needs it. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(argv: string[]): string {
  return [BIN, ...argv.map(shellQuote)].join(" ");
}

export interface ResolveInput {
  roots: Roots;
  env: Env;
  /** --account, when given. */
  flag?: string;
  /** The account positional of the daemon commands, when given. */
  positional?: string;
  mutation: boolean;
  /** The caller's own arguments (without --account), for the per-account help lines. */
  argv: string[];
  command: string;
}

function checkName(name: string, what: string): string {
  if (!validAccount(name)) {
    throw invalid(
      `bad account name ${JSON.stringify(name)} in ${what}: names match ^[a-z][a-z0-9-]{0,23}$ and are not "accounts" (a local label, not a phone number)`,
    );
  }
  return name;
}

/** Resolves the account a command acts on. */
export function resolveAccount(i: ResolveInput): Resolved {
  if (i.flag !== undefined) checkName(i.flag, "--account");
  if (i.positional !== undefined) checkName(i.positional, "the account argument");
  if (i.flag !== undefined && i.positional !== undefined && i.flag !== i.positional) {
    throw invalid(`the account argument ${i.positional} and --account ${i.flag} name different accounts`, [`Run \`${commandLine(i.argv)}\` without --account`]);
  }
  const named = i.positional ?? i.flag;
  const entries = accountEntries(i.roots);
  const names = entries.map((e) => e.name);
  const pin = pinOf(i.env);
  if (pin !== undefined) {
    if (!validAccount(pin) || !names.includes(pin)) {
      throw failure(`${PIN_VAR} pins account ${JSON.stringify(pin)}, which does not exist; nothing falls back to another account`, "ACCOUNT_LOCK_INVALID", [
        names.length
          ? `Accounts: ${names.join(", ")}; set ${PIN_VAR} to one of them, or unset it`
          : `There are no accounts; unset ${PIN_VAR}, or run \`${BIN} account add ${validAccount(pin) ? pin : "<name>"}\``,
      ]);
    }
    if (named !== undefined && named !== pin) {
      throw new ToolError(`${PIN_VAR} pins this session to account ${pin}; ${named} was asked for`, "ACCOUNT_LOCKED", [
        `Run \`${commandLine(i.argv)}\` without naming another account, or change the pin`,
      ]);
    }
    return { name: pin, source: "env" };
  }
  if (named !== undefined) {
    if (!names.includes(named)) {
      throw failure(`No account named ${named}.`, "NO_ACCOUNT", [
        ...(names.length ? [`Accounts: ${names.join(", ")}`] : []),
        `Run \`${BIN} account add ${named}\` to create it`,
      ]);
    }
    return { name: named, source: "flag" };
  }
  if (names.length === 0) throw failure("There are no accounts yet.", "NO_ACCOUNT", [`Run \`${BIN} account add <name>\` to create one`]);
  if (names.length === 1) return { name: names[0], source: "only" };
  const lines = names.map((n) => `Run \`${commandLine([...i.argv, "--account", n])}\` to act as ${n}`);
  if (i.mutation) {
    throw new ToolError(
      `\`${i.command}\` changes an account, and there are ${names.length} accounts (${names.join(", ")}): name one with --account`,
      "ACCOUNT_REQUIRED",
      lines,
    );
  }
  const def = readDefault(i.roots);
  if (def !== undefined) {
    if (!names.includes(def)) {
      throw failure(`The default account ${def} no longer exists.`, "NO_ACCOUNT", [
        `Run \`${BIN} account use <name>\` with one of: ${names.join(", ")}`,
        ...lines,
      ]);
    }
    return { name: def, source: "default" };
  }
  throw new ToolError(`there are ${names.length} accounts (${names.join(", ")}) and no default: name one with --account`, "ACCOUNT_REQUIRED", [
    ...lines,
    `Run \`${BIN} account use <name>\` to set a default for reads`,
  ]);
}
