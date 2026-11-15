// scope, operators and settings. Every change goes through PATCH /v1/settings and is reported as
// done only after the daemon confirmed it; a value already in place is a no-op that says so.
import { parse, type CommandSpec } from "../args.js";
import { expect, type Daemon } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { failure, usage } from "../errors.js";
import { chooseAccount, type Ctx } from "../context.js";
import { acctFlag } from "./read.js";

type Obj = Record<string, unknown>;
const ACCOUNT = { type: "string" as const, value: "<name>", desc: "the account (required when there are several)" };

interface Settings {
  scope: string;
  dm_from: string;
  chats: Record<string, string>;
  operators: string[];
  parent_buffer: boolean;
  wake_file: string | null;
  retain_days: number | null;
  presence: boolean;
  read_receipts: string;
  send: Record<string, string | number>;
}

interface SettingsResult {
  settings: Settings;
  effective: number;
  changed: boolean | undefined;
}

function readResult(d: Daemon, res: Obj): SettingsResult {
  const s = res.settings as Settings | undefined;
  expect(
    d,
    s && typeof s.scope === "string" && typeof s.dm_from === "string" && typeof s.chats === "object" && Array.isArray(s.operators) && typeof s.send === "object",
    "settings are missing fields",
  );
  expect(d, typeof res.effective_retain_days === "number", "settings are missing effective_retain_days");
  return { settings: s, effective: res.effective_retain_days as number, changed: res.changed as boolean | undefined };
}

async function getSettings(d: Daemon): Promise<SettingsResult> {
  return readResult(d, await d.call("GET", "/v1/settings"));
}

/**
 * Sends a settings change. confirm says the caller passed --confirm; retry is the command with
 * --confirm, named when the daemon refuses a loosening change without it (confirm_required).
 */
async function patchSettings(d: Daemon, patch: Obj, confirm = false, retry?: string): Promise<SettingsResult> {
  let res: Obj;
  try {
    res = await d.call("PATCH", "/v1/settings", confirm ? { ...patch, confirm: true } : patch);
  } catch (err) {
    if (err instanceof AxiError && err.code === "confirm_required" && retry) {
      throw failure(err.message, err.code, [`Run \`${retry}\` if you mean to loosen it`]);
    }
    throw err;
  }
  const r = readResult(d, res);
  expect(d, typeof r.changed === "boolean", "the settings change was not confirmed");
  return r;
}

// ---- scope -----------------------------------------------------------------

export const scopeShowSpec: CommandSpec = {
  name: "scope show",
  summary: "Account scope, dm_from, and every per-chat override",
  positionals: [],
  flags: { account: ACCOUNT },
  examples: ["whatsapp-axi scope show"],
};

export async function scopeShow(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(scopeShowSpec, args);
  const account = chooseAccount(ctx, p.flags.account, "scope show");
  const { settings: s } = await getSettings(ctx.daemon(account));
  const overrides = Object.entries(s.chats).map(([chat, scope]) => ({ chat, scope }));
  return {
    scope: s.scope,
    dm_from: s.dm_from,
    parent_buffer: s.parent_buffer,
    overrides: overrides.length ? overrides : "0 per-chat overrides",
  };
}

export const scopeSetSpec: CommandSpec = {
  name: "scope set",
  summary: "Set the account scope (full, tagged, dm-only), or with --chat a chat's override (full, tagged, none, default). Setting full needs --confirm",
  positionals: [{ name: "scope", required: true, desc: "full, tagged or dm-only; with --chat: full, tagged, none or default" }],
  flags: {
    account: ACCOUNT,
    chat: { type: "string", value: "<chat>", desc: "set this chat's override instead of the account scope" },
    confirm: { type: "bool", desc: "required to set full" },
  },
  examples: ["whatsapp-axi scope set tagged", "whatsapp-axi scope set --chat 120363000000000001@g.us none", "whatsapp-axi scope set full --confirm"],
};

export async function scopeSet(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(scopeSetSpec, args);
  const scope = p.pos[0];
  const chat = p.flags.chat as string | undefined;
  const allowed = chat ? ["full", "tagged", "none", "default"] : ["full", "tagged", "dm-only"];
  if (!allowed.includes(scope)) throw usage(`scope must be one of ${allowed.join(", ")}${chat ? " with --chat" : ""}`);
  if (scope === "full" && !p.flags.confirm) {
    throw usage(`setting full needs --confirm: full keeps every message${chat ? " in that chat" : " of every chat"}`, [
      `Run \`whatsapp-axi scope set full${chat ? ` --chat ${chat}` : ""} --confirm\``,
    ]);
  }
  const account = chooseAccount(ctx, p.flags.account, "scope set");
  const d = ctx.daemon(account);
  if (chat) {
    const r = await patchSettings(d, { chats: { [chat]: scope === "default" ? null : scope } }, p.flags.confirm === true);
    const label = scope === "default" ? "default (no override)" : scope;
    return { chat, scope: r.changed ? `${label} (set)` : `${label} (already set, no-op)` };
  }
  const r = await patchSettings(d, { scope }, p.flags.confirm === true);
  return { scope: r.changed ? `${scope} (set)` : `${scope} (already set, no-op)` };
}

export const scopeDMFromSpec: CommandSpec = {
  name: "scope dm-from",
  summary: "Set whose direct messages are kept: operators or anyone. Setting anyone needs --confirm",
  positionals: [{ name: "who", required: true, desc: "operators or anyone" }],
  flags: { account: ACCOUNT, confirm: { type: "bool", desc: "required to set anyone" } },
  examples: ["whatsapp-axi scope dm-from operators", "whatsapp-axi scope dm-from anyone --confirm"],
};

export async function scopeDMFrom(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(scopeDMFromSpec, args);
  const who = p.pos[0];
  if (who !== "operators" && who !== "anyone") throw usage("dm-from must be operators or anyone");
  if (who === "anyone" && !p.flags.confirm) {
    throw usage("setting anyone needs --confirm: the account then keeps direct messages from anyone, not only operators", ["Run `whatsapp-axi scope dm-from anyone --confirm`"]);
  }
  const account = chooseAccount(ctx, p.flags.account, "scope dm-from");
  const r = await patchSettings(ctx.daemon(account), { dm_from: who }, p.flags.confirm === true, `whatsapp-axi scope dm-from ${who} --confirm${acctFlag(ctx, account)}`);
  return { dm_from: r.changed ? `${who} (set)` : `${who} (already set, no-op)` };
}

// ---- operators -------------------------------------------------------------

const OPERATOR_RE = /^(\+[1-9][0-9]{1,14}|[0-9]+@lid)$/;

export const operatorsListSpec: CommandSpec = {
  name: "operators list",
  summary: "The account's operators",
  positionals: [],
  flags: { account: ACCOUNT },
  examples: ["whatsapp-axi operators list"],
};

export async function operatorsList(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(operatorsListSpec, args);
  const account = chooseAccount(ctx, p.flags.account, "operators list");
  const { settings: s } = await getSettings(ctx.daemon(account));
  if (s.operators.length === 0) {
    return { operators: "0 operators", help: [`Run \`whatsapp-axi operators add <+phone or hidden id>${acctFlag(ctx, account)}\` to add one`] };
  }
  return { count: s.operators.length, operators: s.operators.map((o) => ({ operator: o })) };
}

export const operatorsAddSpec: CommandSpec = {
  name: "operators add",
  summary: "Add an operator, by phone number in E.164 form or by hidden id",
  positionals: [{ name: "user", required: true, desc: "+15550100001 or 100000000000001@lid" }],
  flags: { account: ACCOUNT },
  examples: ["whatsapp-axi operators add +15550100001", "whatsapp-axi operators add 100000000000001@lid"],
};

export const operatorsRemoveSpec: CommandSpec = {
  name: "operators remove",
  summary: "Remove an operator",
  positionals: [{ name: "user", required: true, desc: "+15550100001 or 100000000000001@lid" }],
  flags: { account: ACCOUNT },
  examples: ["whatsapp-axi operators remove +15550100001"],
};

export async function operatorsChange(ctx: Ctx, args: string[], add: boolean): Promise<unknown> {
  const spec = add ? operatorsAddSpec : operatorsRemoveSpec;
  const p = parse(spec, args);
  const op = p.pos[0];
  if (!OPERATOR_RE.test(op)) throw usage(`${JSON.stringify(op)} is not an operator: use a phone number in E.164 form (+15550100001) or a hidden id (100000000000001@lid)`);
  const account = chooseAccount(ctx, p.flags.account, spec.name);
  const d = ctx.daemon(account);
  const { settings: s } = await getSettings(d);
  const has = s.operators.includes(op);
  if (add === has) return { operator: `${op} ${add ? "is already an operator" : "is not an operator"} (no-op)` };
  const next = add ? [...s.operators, op] : s.operators.filter((o) => o !== op);
  const r = await patchSettings(d, { operators: next });
  const confirmed = r.settings.operators.includes(op) === add;
  expect(d, confirmed, "the operator change was not applied");
  return { operator: `${op} ${add ? "added" : "removed"}`, operators: r.settings.operators.length };
}

// ---- settings --------------------------------------------------------------

export const settingsShowSpec: CommandSpec = {
  name: "settings show",
  summary: "All settings",
  positionals: [],
  flags: { account: ACCOUNT },
  examples: ["whatsapp-axi settings show"],
};

export async function settingsShow(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(settingsShowSpec, args);
  const account = chooseAccount(ctx, p.flags.account, "settings show");
  const { settings: s, effective } = await getSettings(ctx.daemon(account));
  return {
    settings: {
      scope: s.scope,
      dm_from: s.dm_from,
      overrides: Object.keys(s.chats).length,
      operators: s.operators.length,
      parent_buffer: s.parent_buffer,
      wake_file: s.wake_file,
      retain_days: s.retain_days === null ? `${effective} (default)` : s.retain_days,
      presence: s.presence,
      read_receipts: s.read_receipts,
      send: s.send,
    },
  };
}

const SEND_INTS = ["per_hour", "per_minute", "same_text_chats", "max_file_mb"];
const SETTABLE = ["wake_file", "retain_days", "presence", "read_receipts", "send.first_contact", ...SEND_INTS.map((k) => `send.${k}`)];

export const settingsSetSpec: CommandSpec = {
  name: "settings set",
  summary: `Set one of: ${SETTABLE.join(", ")}`,
  positionals: [
    { name: "key", required: true, desc: SETTABLE.join(", ") },
    { name: "value", required: true, desc: "wake_file: absolute path or none; retain_days: days or default; presence: true/false; read_receipts: on-read/on-keep/off" },
  ],
  flags: {
    account: ACCOUNT,
    confirm: { type: "bool", desc: "required to loosen a send safeguard: send.first_contact allow, or raising a send.* limit above its current value" },
  },
  examples: ["whatsapp-axi settings set wake_file /home/me/.wake/whatsapp", "whatsapp-axi settings set retain_days 30", "whatsapp-axi settings set send.per_hour 20", "whatsapp-axi settings set send.per_hour 120 --confirm"],
};

function settingValue(key: string, raw: string): unknown {
  const int = (min: number) => {
    if (!/^[0-9]+$/.test(raw) || Number(raw) < min) throw usage(`${key} must be a whole number of ${min} or more`);
    return Number(raw);
  };
  switch (key) {
    case "wake_file":
      if (raw === "none") return null;
      if (!raw.startsWith("/")) throw usage("wake_file must be an absolute path, or none to unset it");
      return raw;
    case "retain_days":
      return raw === "default" ? null : int(0);
    case "presence":
      if (raw !== "true" && raw !== "false") throw usage("presence must be true or false");
      return raw === "true";
    case "read_receipts":
      if (raw !== "on-read" && raw !== "on-keep" && raw !== "off") throw usage("read_receipts must be on-read, on-keep or off");
      return raw;
    case "send.first_contact":
      if (raw !== "refuse" && raw !== "allow") throw usage("send.first_contact must be refuse or allow");
      return raw;
    default:
      return int(1);
  }
}

export async function settingsSet(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(settingsSetSpec, args);
  const [key, raw] = p.pos;
  if (!SETTABLE.includes(key)) {
    const hint = ["scope", "dm_from", "chats", "operators"].includes(key) ? [`Use \`whatsapp-axi ${key === "operators" ? "operators add|remove" : key === "dm_from" ? "scope dm-from" : "scope set"}\` instead`] : [];
    throw usage(`${JSON.stringify(key)} cannot be set here; settable keys: ${SETTABLE.join(", ")}`, hint);
  }
  const value = settingValue(key, raw);
  if (key === "send.first_contact" && value === "allow" && !p.flags.confirm) {
    throw usage("setting send.first_contact allow needs --confirm: it lets the account message chats it has never heard from", ["Run `whatsapp-axi settings set send.first_contact allow --confirm`"]);
  }
  const account = chooseAccount(ctx, p.flags.account, "settings set");
  const patch: Obj = key.startsWith("send.") ? { send: { [key.slice(5)]: value } } : { [key]: value };
  const r = await patchSettings(ctx.daemon(account), patch, p.flags.confirm === true, `whatsapp-axi settings set ${key} ${raw} --confirm${acctFlag(ctx, account)}`);
  const shown = value === null ? "default" : String(value);
  return { [key]: r.changed ? `${shown} (set)` : `${shown} (already set, no-op)` };
}
