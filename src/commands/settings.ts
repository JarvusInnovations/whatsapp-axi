// scope, operators and settings. Every change goes through PATCH /v1/settings and is reported from
// the values the daemon returns after it, with the prior value and the command that restores it
// (specs/conventions.md "Mutations"). A value already in place is `action: unchanged`.
import { AxiError } from "axi-sdk-js";
import { oneOf, parse, type CommandSpec } from "../flags.js";
import { expect, type Daemon } from "../client.js";
import { confirmRequired, invalid } from "../errors.js";
import { account, acctFlag, type Ctx } from "../context.js";

type Obj = Record<string, unknown>;

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
    s &&
      typeof s.scope === "string" &&
      typeof s.dm_from === "string" &&
      s.chats !== null &&
      typeof s.chats === "object" &&
      Array.isArray(s.operators) &&
      s.send !== null &&
      typeof s.send === "object" &&
      typeof s.read_receipts === "string" &&
      typeof s.presence === "boolean",
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
 * --confirm, named when the daemon refuses a loosening change without it (CONFIRM_REQUIRED).
 */
async function patchSettings(d: Daemon, patch: Obj, confirm: boolean, retry: string): Promise<SettingsResult> {
  let res: Obj;
  try {
    res = await d.call("PATCH", "/v1/settings", confirm ? { ...patch, confirm: true } : patch);
  } catch (err) {
    if (err instanceof AxiError && err.code === "CONFIRM_REQUIRED") {
      throw confirmRequired(err.message, [`Run \`${retry}\` if you mean to loosen it`]);
    }
    throw err;
  }
  const r = readResult(d, res);
  expect(d, typeof r.changed === "boolean", "the settings change was not confirmed");
  return r;
}

/** The result of a setting or scope change: what the daemon now holds, what it was, and the undo. */
function changed(key: string, nowIn: string, was: string, undo: string | undefined, isChanged: boolean): Obj {
  const now: string | number = /^[0-9]+$/.test(nowIn) ? Number(nowIn) : nowIn;
  if (!isChanged) return { action: "unchanged", [key]: now, reason: `already ${now} (no-op)` };
  return { action: "set", [key]: now, note: `was ${was}`, ...(undo ? { help: [`Run \`${undo}\` to undo`] } : {}) };
}

// ---- scope -----------------------------------------------------------------

export const scopeShowSpec: CommandSpec = {
  name: "scope show",
  summary: "Account scope, dm_from, and every per-chat override",
  positionals: [],
  flags: {},
  examples: ["whatsapp-axi scope show"],
  jsonOut: true,
};

export async function scopeShow(ctx: Ctx, args: string[]): Promise<unknown> {
  parse(scopeShowSpec, args);
  const { settings: s } = await getSettings(ctx.daemon(account(ctx)));
  const overrides = Object.entries(s.chats).map(([chat, scope]) => ({ chat, scope }));
  return {
    scope: s.scope,
    dm_from: s.dm_from,
    parent_buffer: s.parent_buffer,
    ...(overrides.length ? { count: `${overrides.length} of ${overrides.length}`, overrides } : { overrides: "0 per-chat overrides" }),
  };
}

const ACCOUNT_SCOPES = ["full", "tagged", "dm-only"];
const CHAT_SCOPES = ["full", "tagged", "none", "default"];

export const scopeSetSpec: CommandSpec = {
  name: "scope set",
  summary: "Set the account scope (full, tagged, dm-only), or with --chat a chat's override (full, tagged, none, default). Setting full needs --confirm",
  positionals: [{ name: "scope", required: true, desc: "full, tagged or dm-only; with --chat: full, tagged, none or default" }],
  flags: {
    chat: { type: "string", value: "<chat>", desc: "set this chat's override instead of the account scope" },
    confirm: { type: "bool", desc: "required to set full" },
  },
  examples: ["whatsapp-axi scope set tagged", "whatsapp-axi scope set none --chat 120363000000000001@g.us", "whatsapp-axi scope set full --confirm"],
  mutation: true,
  jsonOut: true,
};

export async function scopeSet(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(scopeSetSpec, args);
  const scope = p.pos[0];
  const chat = p.flags.chat as string | undefined;
  const allowed = chat ? CHAT_SCOPES : ACCOUNT_SCOPES;
  if (!allowed.includes(scope)) throw oneOf(chat ? "a chat's scope (with --chat)" : "the account scope", allowed, scope);
  const name = account(ctx);
  const af = acctFlag(ctx, name);
  const chatFlag = chat ? ` --chat ${chat}` : "";
  const retry = `whatsapp-axi scope set full${chatFlag} --confirm${af}`;
  if (scope === "full" && !p.flags.confirm) {
    throw confirmRequired(`setting full needs --confirm: full keeps every message${chat ? " of that chat" : " of every chat"}`, [`Run \`${retry}\` if you mean to widen it`]);
  }
  const d = ctx.daemon(name);
  const before = await getSettings(d);
  if (chat) {
    const r = await patchSettings(d, { chats: { [chat]: scope === "default" ? null : scope } }, p.flags.confirm === true, retry);
    // The daemon stores the chat under its canonical id; find the override that changed.
    const keyOf = (s: Settings) => (chat in s.chats ? chat : (Object.keys(s.chats).find((k) => before.settings.chats[k] !== s.chats[k]) ?? chat));
    const key = keyOf(r.settings);
    const now = r.settings.chats[key] ?? "default";
    const was = before.settings.chats[key] ?? "default";
    const undo = was === "default" ? `whatsapp-axi scope set default --chat ${key}${af}` : `whatsapp-axi scope set ${was} --chat ${key}${was === "full" ? " --confirm" : ""}${af}`;
    return { chat: key, ...changed("scope", now, was, undo, r.changed === true) };
  }
  const r = await patchSettings(d, { scope }, p.flags.confirm === true, retry);
  const was = before.settings.scope;
  return changed("scope", r.settings.scope, was, `whatsapp-axi scope set ${was}${was === "full" ? " --confirm" : ""}${af}`, r.changed === true);
}

export const scopeDMFromSpec: CommandSpec = {
  name: "scope dm-from",
  summary: "Set whose direct messages are kept: operators or anyone. Setting anyone needs --confirm",
  positionals: [{ name: "who", required: true, desc: "operators or anyone" }],
  flags: { confirm: { type: "bool", desc: "required to set anyone" } },
  examples: ["whatsapp-axi scope dm-from operators", "whatsapp-axi scope dm-from anyone --confirm"],
  mutation: true,
  jsonOut: true,
};

export async function scopeDMFrom(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(scopeDMFromSpec, args);
  const who = p.pos[0];
  if (who !== "operators" && who !== "anyone") throw oneOf("dm-from", ["operators", "anyone"], who);
  const name = account(ctx);
  const af = acctFlag(ctx, name);
  const retry = `whatsapp-axi scope dm-from anyone --confirm${af}`;
  if (who === "anyone" && !p.flags.confirm) {
    throw confirmRequired("setting anyone needs --confirm: the account then keeps direct messages from anyone, not only operators", [`Run \`${retry}\` if you mean to widen it`]);
  }
  const d = ctx.daemon(name);
  const before = await getSettings(d);
  const r = await patchSettings(d, { dm_from: who }, p.flags.confirm === true, retry);
  const was = before.settings.dm_from;
  return changed("dm_from", r.settings.dm_from, was, `whatsapp-axi scope dm-from ${was}${was === "anyone" ? " --confirm" : ""}${af}`, r.changed === true);
}

// ---- operators -------------------------------------------------------------

const OPERATOR_RE = /^(\+[1-9][0-9]{1,14}|[0-9]+@lid)$/;

export const operatorsListSpec: CommandSpec = {
  name: "operators list",
  summary: "The account's operators",
  positionals: [],
  flags: {},
  examples: ["whatsapp-axi operators list"],
  jsonOut: true,
};

export async function operatorsList(ctx: Ctx, args: string[]): Promise<unknown> {
  parse(operatorsListSpec, args);
  const name = account(ctx);
  const { settings: s } = await getSettings(ctx.daemon(name));
  if (s.operators.length === 0) {
    return { operators: "0 operators", help: [`Run \`whatsapp-axi operators add <+phone or hidden id> --confirm${acctFlag(ctx, name)}\` to add one`] };
  }
  return { count: `${s.operators.length} of ${s.operators.length}`, operators: s.operators.map((o) => ({ operator: o })) };
}

export const operatorsAddSpec: CommandSpec = {
  name: "operators add",
  summary: "Add an operator, by phone number in E.164 form or by hidden id. Needs --confirm: under dm_from operators it widens whose direct messages are kept",
  positionals: [{ name: "user", required: true, desc: "+15550100001 or 100000000000001@lid" }],
  flags: { confirm: { type: "bool", desc: "required: an operator's direct messages are kept" } },
  examples: ["whatsapp-axi operators add +15550100001 --confirm", "whatsapp-axi operators add 100000000000001@lid --confirm"],
  mutation: true,
  jsonOut: true,
};

export const operatorsRemoveSpec: CommandSpec = {
  name: "operators remove",
  summary: "Remove an operator",
  positionals: [{ name: "user", required: true, desc: "+15550100001 or 100000000000001@lid" }],
  flags: {},
  examples: ["whatsapp-axi operators remove +15550100001"],
  mutation: true,
  jsonOut: true,
};

export async function operatorsChange(ctx: Ctx, args: string[], add: boolean): Promise<unknown> {
  const spec = add ? operatorsAddSpec : operatorsRemoveSpec;
  const p = parse(spec, args);
  const op = p.pos[0];
  if (!OPERATOR_RE.test(op)) throw invalid(`${JSON.stringify(op)} is not an operator: use a phone number in E.164 form (+15550100001) or a hidden id (100000000000001@lid)`);
  const name = account(ctx);
  const af = acctFlag(ctx, name);
  const retry = `whatsapp-axi operators add ${op} --confirm${af}`;
  const d = ctx.daemon(name);
  const { settings: s } = await getSettings(d);
  const has = s.operators.includes(op);
  if (add === has) return { action: "unchanged", operator: op, reason: `${add ? "already an operator" : "not an operator"} (no-op)` };
  if (add && !p.flags.confirm) {
    throw confirmRequired(`adding an operator needs --confirm: under dm_from operators the account then keeps ${op}'s direct messages`, [`Run \`${retry}\` if you mean to add them`]);
  }
  const next = add ? [...s.operators, op] : s.operators.filter((o) => o !== op);
  const r = await patchSettings(d, { operators: next }, add, retry);
  expect(d, r.settings.operators.includes(op) === add, "the operator change was not applied");
  return {
    action: add ? "added" : "removed",
    operator: op,
    operators: r.settings.operators.length,
    help: [`Run \`whatsapp-axi operators ${add ? `remove ${op}` : `add ${op} --confirm`}${af}\` to undo`],
  };
}

// ---- settings --------------------------------------------------------------

export const settingsShowSpec: CommandSpec = {
  name: "settings show",
  summary: "All settings",
  positionals: [],
  flags: {},
  examples: ["whatsapp-axi settings show"],
  jsonOut: true,
};

function retainShown(s: Settings, effective: number): string {
  const n = s.retain_days ?? effective;
  const v = n === 0 ? "unlimited" : String(n);
  return s.retain_days === null ? `${v} (default)` : v;
}

export async function settingsShow(ctx: Ctx, args: string[]): Promise<unknown> {
  parse(settingsShowSpec, args);
  const { settings: s, effective } = await getSettings(ctx.daemon(account(ctx)));
  return {
    settings: {
      scope: s.scope,
      dm_from: s.dm_from,
      overrides: Object.keys(s.chats).length,
      operators: s.operators.length,
      parent_buffer: s.parent_buffer,
      wake_file: s.wake_file ?? "none",
      retain_days: retainShown(s, effective),
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
    { name: "value", required: true, desc: "wake_file: absolute path or none; retain_days: days, 0 for unlimited, or default; presence: true/false; read_receipts: on-read/on-keep/off" },
  ],
  flags: {
    confirm: { type: "bool", desc: "required to loosen a safeguard: send.first_contact allow, raising a send.* limit, or raising retain_days (or making it unlimited)" },
  },
  examples: ["whatsapp-axi settings set wake_file /home/user/.wake/whatsapp", "whatsapp-axi settings set retain_days 30", "whatsapp-axi settings set send.per_hour 20", "whatsapp-axi settings set send.per_hour 120 --confirm"],
  mutation: true,
  jsonOut: true,
};

function settingValue(key: string, raw: string): unknown {
  const int = (min: number) => {
    if (!/^[0-9]+$/.test(raw) || Number(raw) < min) throw invalid(`${key} must be a whole number of ${min} or more, got ${JSON.stringify(raw)}`);
    return Number(raw);
  };
  switch (key) {
    case "wake_file":
      if (raw === "none") return null;
      if (!raw.startsWith("/")) throw invalid("wake_file must be an absolute path, or none to unset it");
      return raw;
    case "retain_days":
      return raw === "default" ? null : int(0);
    case "presence":
      if (raw !== "true" && raw !== "false") throw oneOf("presence", ["true", "false"], raw);
      return raw === "true";
    case "read_receipts":
      if (raw !== "on-read" && raw !== "on-keep" && raw !== "off") throw oneOf("read_receipts", ["on-read", "on-keep", "off"], raw);
      return raw;
    case "send.first_contact":
      if (raw !== "refuse" && raw !== "allow") throw oneOf("send.first_contact", ["refuse", "allow"], raw);
      return raw;
    default:
      return int(1);
  }
}

/** A setting's value as `settings set` takes it. */
function valueOf(s: Settings, key: string): string {
  if (key.startsWith("send.")) return String(s.send[key.slice(5)]);
  if (key === "wake_file") return s.wake_file ?? "none";
  if (key === "retain_days") return s.retain_days === null ? "default" : String(s.retain_days);
  return String((s as unknown as Obj)[key]);
}

export async function settingsSet(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(settingsSetSpec, args);
  const [key, raw] = p.pos;
  if (!SETTABLE.includes(key)) {
    const hint = ["scope", "dm_from", "chats", "operators"].includes(key) ? [`Run \`whatsapp-axi ${key === "operators" ? "operators add <user> --confirm" : key === "dm_from" ? "scope dm-from <who>" : "scope set <scope>"}\` instead`] : [];
    throw invalid(`${JSON.stringify(key)} cannot be set here; settable keys: ${SETTABLE.join(", ")}`, hint);
  }
  const value = settingValue(key, raw);
  const name = account(ctx);
  const af = acctFlag(ctx, name);
  const retry = `whatsapp-axi settings set ${key} ${raw} --confirm${af}`;
  if (key === "send.first_contact" && value === "allow" && !p.flags.confirm) {
    throw confirmRequired("setting send.first_contact allow needs --confirm: it lets the account message chats it has never heard from", [`Run \`${retry}\` if you mean to loosen it`]);
  }
  const d = ctx.daemon(name);
  const before = await getSettings(d);
  const patch: Obj = key.startsWith("send.") ? { send: { [key.slice(5)]: value } } : { [key]: value };
  const r = await patchSettings(d, patch, p.flags.confirm === true, retry);
  const was = valueOf(before.settings, key);
  const now = valueOf(r.settings, key);
  // Undoing a tightening loosens again, so that undo takes --confirm.
  const n = (v: string, eff: number) => (v === "default" ? eff : Number(v));
  const loosens =
    key === "send.first_contact"
      ? was === "allow"
      : key.startsWith("send.")
        ? Number(was) > Number(now)
        : key === "retain_days"
          ? (() => {
              const w = n(was, before.effective);
              const x = n(now, r.effective);
              return x !== 0 && (w === 0 || w > x);
            })()
          : false;
  return changed(key, now, was, `whatsapp-axi settings set ${key} ${was}${loosens ? " --confirm" : ""}${af}`, r.changed === true);
}
