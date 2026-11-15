// chats, chat view, events, read, message view, forget. Everything printed comes from the daemon's
// answer, picked field by field; message text is printed as data and never interpreted.
import { encode } from "@toon-format/toon";
import { parse, parseFields, type CommandSpec } from "../args.js";
import { expect, type Daemon } from "../client.js";
import { usage } from "../errors.js";
import { cell, chooseAccount, longText, pick, plural, type Ctx } from "../context.js";
import { listAccounts } from "../paths.js";

type Obj = Record<string, unknown>;
const ACCOUNT = { type: "string" as const, value: "<name>", desc: "the account (required when there are several)" };

function enc(s: string): string {
  return encodeURIComponent(s);
}

function q(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Carries --account into suggested commands when the user has more than one account. */
export function acctFlag(ctx: Ctx, account: string): string {
  return listAccounts(ctx.roots).length > 1 ? ` --account ${account}` : "";
}

function user(u: unknown): Obj {
  const o = (u ?? {}) as Obj;
  return { id: o.id, lid: o.lid, pn: o.pn, name: o.name, me: o.me, operator: o.operator };
}

function who(u: unknown): string {
  const o = (u ?? {}) as Obj;
  const name = typeof o.name === "string" && o.name ? o.name : String(o.id ?? "");
  return o.me ? `${name} (me)` : name;
}

// ---- chats -----------------------------------------------------------------

export const chatsSpec: CommandSpec = {
  name: "chats",
  summary: "Chats with kept content: id, name, type, effective scope",
  positionals: [],
  flags: { account: ACCOUNT, fields: { type: "string", value: "<list>", desc: "add columns: last_kept, discarded, messages, override" } },
  examples: ["whatsapp-axi chats", "whatsapp-axi chats --fields last_kept,discarded"],
};

export async function chats(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(chatsSpec, args);
  const fields = parseFields(chatsSpec, p.flags.fields, ["last_kept", "discarded", "messages", "override"]);
  const account = chooseAccount(ctx, p.flags.account, "chats");
  const d = ctx.daemon(account);
  const res = await d.call("GET", "/v1/chats");
  expect(d, Array.isArray(res.chats), "chats is not a list");
  const list = res.chats as Obj[];
  const af = acctFlag(ctx, account);
  if (list.length === 0) {
    return { chats: "0 chats with kept content", help: [`Run \`whatsapp-axi scope show${af}\` to see what this account keeps`] };
  }
  return {
    count: list.length,
    chats: pick(list, ["id", "name", "type", "scope", ...fields]),
    help: [`Run \`whatsapp-axi read <chat>${af}\` to read a chat`, `Run \`whatsapp-axi chat view <chat>${af}\` for participants`],
  };
}

// ---- groups ----------------------------------------------------------------

export const groupsSpec: CommandSpec = {
  name: "groups",
  summary: "Every group the account is a member of, kept content or not: id, name, effective scope, member count",
  positionals: [],
  flags: { account: ACCOUNT, fields: { type: "string", value: "<list>", desc: "add columns: discarded, override" } },
  examples: ["whatsapp-axi groups", "whatsapp-axi groups --fields discarded"],
};

export async function groups(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(groupsSpec, args);
  const fields = parseFields(groupsSpec, p.flags.fields, ["discarded", "override"]);
  const account = chooseAccount(ctx, p.flags.account, "groups");
  const d = ctx.daemon(account);
  const res = await d.call("GET", "/v1/groups");
  expect(d, Array.isArray(res.groups), "groups is not a list");
  const list = (res.groups as Obj[]).map((g) => ({ ...g, override: g.override ?? null }));
  const af = acctFlag(ctx, account);
  if (list.length === 0) return { groups: "0 groups: the account is not a member of any group" };
  return {
    count: list.length,
    groups: pick(list, ["id", "name", "scope", "members", ...fields]),
    help: [`Run \`whatsapp-axi chat view <group>${af}\` for its participants`, `Run \`whatsapp-axi scope set --chat <group> <scope>${af}\` to change what is kept from it`],
  };
}

// ---- chat view -------------------------------------------------------------

export const chatViewSpec: CommandSpec = {
  name: "chat view",
  summary: "One chat, with participants marked me, operator, contact",
  positionals: [{ name: "chat", required: true, desc: "group id, hidden id, phone-number id or +phone" }],
  flags: { account: ACCOUNT, fields: { type: "string", value: "<list>", desc: "add participant columns: lid, pn" } },
  examples: ["whatsapp-axi chat view 120363000000000001@g.us", "whatsapp-axi chat view +15550100001"],
};

export async function chatView(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(chatViewSpec, args);
  const fields = parseFields(chatViewSpec, p.flags.fields, ["lid", "pn"]);
  const account = chooseAccount(ctx, p.flags.account, "chat view");
  const d = ctx.daemon(account);
  const res = await d.call("GET", `/v1/chats/${enc(p.pos[0])}`);
  const c = res.chat as Obj | undefined;
  expect(d, c && typeof c.id === "string" && Array.isArray(c.participants), "chat is missing fields");
  const parts = (c.participants as Obj[]).map((u) => {
    const marks = [u.me ? "me" : "", u.operator ? "operator" : "", u.contact ? "contact" : ""].filter(Boolean).join(" ") || "-";
    return { id: u.id, name: u.name, marks, lid: u.lid ?? null, pn: u.pn ?? null };
  });
  return {
    chat: {
      id: c.id,
      name: c.name,
      type: c.type,
      scope: c.scope,
      override: c.override ?? null,
      last_kept: c.last_kept ?? null,
      messages: c.messages,
      discarded: c.discarded,
      ...(Array.isArray(c.aliases) && c.aliases.length ? { aliases: c.aliases } : {}),
    },
    participants: parts.length ? pick(parts, ["id", "name", "marks", ...fields]) : "0 participants known",
  };
}

// ---- events ----------------------------------------------------------------

const KINDS = ["message", "edit", "revoke", "reaction", "state", "chat_rekeyed"];

export const eventsSpec: CommandSpec = {
  name: "events",
  summary: "Events after a seq; the last line states the highest seq returned, for the next call",
  positionals: [],
  flags: {
    account: ACCOUNT,
    after: { type: "int", value: "<seq>", desc: "events with a higher seq (default: the most recent)" },
    limit: { type: "int", value: "<n>", desc: "at most this many (default 100, max 1000)" },
    chat: { type: "string", value: "<chat>", desc: "only this chat" },
    kind: { type: "string", value: "<kind>", desc: `only this kind: ${KINDS.join(", ")}` },
    follow: { type: "bool", desc: "keep printing new events as they are kept" },
    "mark-read": { type: "bool", desc: "send read receipts for the incoming messages returned" },
    fields: { type: "string", value: "<list>", desc: "add columns: t, id, from, kept_by, mentions_me" },
  },
  examples: ["whatsapp-axi events --after 412", "whatsapp-axi events --kind message --limit 20", "whatsapp-axi events --after 412 --follow --mark-read"],
};

function eventRow(e: Obj): Obj {
  const m = e.message as Obj | undefined;
  const chat = (e.chat as Obj | undefined)?.id ?? null;
  let detail = "";
  switch (e.kind) {
    case "message":
    case "edit":
      detail = m ? `${who(m.from)}: ${cell(m.text || (m.media ? `[${(m.media as Obj).type}]` : ""), 100)}` : "";
      break;
    case "revoke":
      detail = m ? `${who(m.from)} deleted ${m.id}` : "";
      break;
    case "reaction":
      detail = `${who(e.from)} ${e.emoji ? `reacted ${e.emoji}` : "removed a reaction"} on ${e.target}`;
      break;
    case "state":
      detail = `${e.state}${e.reason ? ` (${e.reason})` : ""}`;
      break;
    case "chat_rekeyed":
      detail = `${e.old} -> ${e.new}`;
      break;
  }
  return {
    seq: e.seq,
    kind: e.kind,
    chat,
    detail,
    t: e.t ?? null,
    id: m?.id ?? e.target ?? null,
    from: m ? ((m.from as Obj)?.id ?? null) : ((e.from as Obj | undefined)?.id ?? null),
    kept_by: m?.kept_by ?? null,
    mentions_me: m?.mentions_me ?? null,
  };
}

export async function events(ctx: Ctx, args: string[], write: (s: string) => void, signal?: AbortSignal): Promise<unknown> {
  const p = parse(eventsSpec, args);
  const fields = parseFields(eventsSpec, p.flags.fields, ["t", "id", "from", "kept_by", "mentions_me"]);
  if (p.flags.kind !== undefined && !KINDS.includes(String(p.flags.kind))) throw usage(`--kind must be one of ${KINDS.join(", ")}`);
  const limit = p.flags.limit as number | undefined;
  if (limit !== undefined && (limit < 1 || limit > 1000)) throw usage("--limit must be from 1 to 1000");
  const account = chooseAccount(ctx, p.flags.account, "events");
  const d = ctx.daemon(account);
  const keys = ["seq", "kind", "chat", "detail", ...fields];
  const after = p.flags.after as number | undefined;
  const query = { after, limit, chat: p.flags.chat as string | undefined, kind: p.flags.kind as string | undefined, mark_read: p.flags["mark-read"] ? 1 : undefined };

  if (p.flags.follow) {
    let last = after ?? null;
    for await (const e of d.stream(`/v1/events${q({ ...query, follow: 1 })}`, signal)) {
      expect(d, typeof e.seq === "number" && typeof e.kind === "string", "event is missing fields");
      write(`${encode({ events: pick([eventRow(e)], keys) })}\n`);
      last = e.seq as number;
    }
    return { last_seq: last };
  }

  const res = await d.call("GET", `/v1/events${q(query)}`);
  expect(d, Array.isArray(res.events) && typeof res.latest_seq === "number", "events is missing fields");
  const list = res.events as Obj[];
  for (const e of list) expect(d, typeof e.seq === "number" && typeof e.kind === "string", "event is missing fields");
  const lastSeq = list.length ? (list[list.length - 1].seq as number) : (after ?? (res.latest_seq as number));
  const af = acctFlag(ctx, account);
  const out: Obj = {};
  if (list.length === 0) {
    out.events = after !== undefined ? `0 events after seq ${after}` : "0 events";
  } else {
    if (after === undefined) out.note = `showing the ${plural(list.length, "most recent event")}; pass --after <seq> to read forward`;
    out.events = pick(list.map(eventRow), keys);
    out.help = [`Run \`whatsapp-axi events --after ${lastSeq}${af}\` for what comes next`, `Run \`whatsapp-axi message view <chat>/<id>${af}\` for a message in full`];
  }
  if (list.length === 0) out.help = [`Run \`whatsapp-axi events --after ${lastSeq} --follow${af}\` to wait for new events`];
  if (typeof res.marked_read === "number") out.marked_read = res.marked_read;
  out.last_seq = lastSeq;
  return out;
}

// ---- read ------------------------------------------------------------------

export const readSpec: CommandSpec = {
  name: "read",
  summary: "Kept messages of a chat, oldest first",
  positionals: [{ name: "chat", required: true, desc: "group id, hidden id, phone-number id or +phone" }],
  flags: {
    account: ACCOUNT,
    limit: { type: "int", value: "<n>", desc: "at most this many (default 50, max 500)" },
    before: { type: "string", value: "<id>", desc: "messages older than this message id" },
    "mark-read": { type: "bool", desc: "send read receipts for the incoming messages returned" },
    fields: { type: "string", value: "<list>", desc: "add columns: kept_by, mentions_me, reply_to, media, operator" },
  },
  examples: ["whatsapp-axi read 120363000000000001@g.us", "whatsapp-axi read +15550100001 --limit 10"],
};

export async function read(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(readSpec, args);
  const fields = parseFields(readSpec, p.flags.fields, ["kept_by", "mentions_me", "reply_to", "media", "operator"]);
  const limit = p.flags.limit as number | undefined;
  if (limit !== undefined && (limit < 1 || limit > 500)) throw usage("--limit must be from 1 to 500");
  const account = chooseAccount(ctx, p.flags.account, "read");
  const d = ctx.daemon(account);
  const res = await d.call("GET", `/v1/messages${q({ chat: p.pos[0], before: p.flags.before as string | undefined, limit, mark_read: p.flags["mark-read"] ? 1 : undefined })}`);
  const chat = res.chat as Obj | undefined;
  expect(d, chat && typeof chat.id === "string" && Array.isArray(res.messages), "messages is missing fields");
  const list = res.messages as Obj[];
  const af = acctFlag(ctx, account);
  if (list.length === 0) return { chat: chat.id, messages: `0 kept messages in ${chat.id}${p.flags.before ? ` before ${p.flags.before}` : ""}` };
  const rows = list.map((m) => ({
    id: m.id,
    t: m.t ?? null,
    from: who(m.from),
    text: m.deleted ? "[deleted]" : cell(m.text || (m.media ? `[${(m.media as Obj).type}]` : ""), 200),
    kept_by: m.kept_by ?? null,
    mentions_me: m.mentions_me ?? null,
    reply_to: (m.reply_to as Obj | undefined)?.id ?? null,
    media: m.media ? (m.media as Obj).type : null,
    operator: (m.from as Obj | undefined)?.operator ?? null,
  }));
  const out: Obj = { chat: chat.id, count: list.length, messages: pick(rows, ["id", "t", "from", "text", ...fields]) };
  if (typeof res.marked_read === "number") out.marked_read = res.marked_read;
  const help = [`Run \`whatsapp-axi message view ${chat.id}/<id>${af}\` for one message in full`];
  if (res.more) help.unshift(`Run \`whatsapp-axi read ${chat.id} --before ${list[0].id}${af}\` for older messages`);
  out.help = help;
  return out;
}

// ---- message view ----------------------------------------------------------

export const messageViewSpec: CommandSpec = {
  name: "message view",
  summary: "One kept message in full, with its reply context and media descriptor",
  positionals: [{ name: "ref", required: true, desc: "<message id> or <chat>/<message id>" }],
  flags: { account: ACCOUNT, full: { type: "bool", desc: "print long text in full" } },
  examples: ["whatsapp-axi message view 3EB0AAAA0000000001", "whatsapp-axi message view 120363000000000001@g.us/3EB0AAAA0000000001"],
};

export function splitRef(ref: string): { chat: string; id: string } {
  const i = ref.lastIndexOf("/");
  return i >= 0 ? { chat: ref.slice(0, i), id: ref.slice(i + 1) } : { chat: "", id: ref };
}

function messagePath(ref: string): string {
  const { chat, id } = splitRef(ref);
  if (!id) throw usage(`${JSON.stringify(ref)} is not a message ref: use <id> or <chat>/<id>`);
  return chat ? `/v1/messages/${enc(chat)}/${enc(id)}` : `/v1/messages/${enc(id)}`;
}

export async function messageView(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(messageViewSpec, args);
  const account = chooseAccount(ctx, p.flags.account, "message view");
  const d = ctx.daemon(account);
  const res = await d.call("GET", messagePath(p.pos[0]));
  const m = res.message as Obj | undefined;
  const chat = res.chat as Obj | undefined;
  expect(d, m && chat && typeof m.id === "string", "message is missing fields");
  const full = Boolean(p.flags.full);
  const body = longText(String(m.text ?? ""), full);
  const msg: Obj = {
    id: m.id,
    chat: chat.id,
    t: m.t ?? null,
    from: user(m.from),
    text: body.text,
    kept_by: m.kept_by ?? null,
    mentions_me: m.mentions_me ?? false,
  };
  if (m.partial) msg.partial = true;
  if (m.edited) msg.edited = true;
  if (m.deleted) msg.deleted = true;
  if (Array.isArray(m.mentions) && m.mentions.length) msg.mentions = (m.mentions as Obj[]).map((u) => who(u));
  const r = m.reply_to as Obj | undefined;
  if (r) {
    const rt = longText(String(r.text ?? ""), full);
    msg.reply_to = { id: r.id, from: r.from ? who(r.from) : null, text: rt.text, kept: r.kept ?? false };
    body.truncated ||= rt.truncated;
  }
  const md = m.media as Obj | undefined;
  if (md) msg.media = { type: md.type, mime: md.mime, name: md.name, size: md.size, ...(md.view_once ? { view_once: true } : {}) };
  if (typeof m.ephemeral === "number") msg.ephemeral = m.ephemeral;
  if (Array.isArray(m.reactions) && m.reactions.length) msg.reactions = (m.reactions as Obj[]).map((x) => ({ from: who(x.from), emoji: x.emoji }));
  const out: Obj = { message: msg };
  if (body.truncated) out.help = [`Run \`whatsapp-axi message view ${chat.id}/${m.id} --full${acctFlag(ctx, account)}\` for the complete text`];
  return out;
}

// ---- forget ----------------------------------------------------------------

export const forgetSpec: CommandSpec = {
  name: "forget",
  summary: "Delete kept content for a chat, or for one message with --message",
  positionals: [{ name: "chat", required: true, desc: "group id, hidden id, phone-number id or +phone" }],
  flags: {
    account: ACCOUNT,
    message: { type: "string", value: "<ref>", desc: "only this message (<id> or <chat>/<id>)" },
    confirm: { type: "bool", desc: "required: forgetting cannot be undone" },
  },
  examples: ["whatsapp-axi forget 120363000000000001@g.us --confirm", "whatsapp-axi forget 120363000000000001@g.us --message 3EB0AAAA0000000001 --confirm"],
};

export async function forget(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(forgetSpec, args);
  const chatArg = p.pos[0];
  if (!p.flags.confirm) {
    throw usage("--confirm is required: forgetting deletes kept content and cannot be undone", [
      `Run \`whatsapp-axi forget ${chatArg}${p.flags.message ? ` --message ${p.flags.message}` : ""} --confirm\``,
    ]);
  }
  const account = chooseAccount(ctx, p.flags.account, "forget");
  const d: Daemon = ctx.daemon(account);
  const body: Obj = { chat: chatArg };
  if (p.flags.message !== undefined) {
    const { chat, id } = splitRef(String(p.flags.message));
    if (!id) throw usage("--message needs <id> or <chat>/<id>");
    if (chat && chat !== chatArg) throw usage(`--message ${p.flags.message} names a different chat than ${chatArg}`);
    body.id = id;
  }
  const res = await d.call("POST", "/v1/forget", body);
  const f = res.forgotten as Obj | undefined;
  expect(d, f && typeof f.messages === "number", "forget is missing fields");
  return {
    forgotten: {
      chat: f.chat,
      ...(f.message ? { message: f.message } : {}),
      messages: f.messages,
      events: f.events,
    },
  };
}
