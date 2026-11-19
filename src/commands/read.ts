// chats, chat view, events, read, message view, forget. Everything printed comes from the daemon's
// answer, picked field by field; message text is printed as data and never interpreted. Ids are
// printed whole (specs/conventions.md "Message and chat ids").
import { parse, parseFields, contradiction, type CommandSpec } from "../flags.js";
import { expect, type Daemon } from "../client.js";
import { ToolError, confirmRequired, invalid, usage } from "../errors.js";
import { account, acctFlag, asMarkOutcome, cell, countOf, longText, markError, pick, plural, time, type Ctx, type MarkOutcome } from "../context.js";
import { line } from "../output/toon.js";

type Obj = Record<string, unknown>;

function enc(s: string): string {
  return encodeURIComponent(s);
}

function q(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export { acctFlag };

function user(u: unknown): Obj {
  const o = (u ?? {}) as Obj;
  return { id: o.id, lid: o.lid, pn: o.pn, name: o.name || undefined, ...(o.me ? { me: true } : {}), ...(o.operator ? { operator: true } : {}) };
}

function who(u: unknown): string {
  const o = (u ?? {}) as Obj;
  const name = typeof o.name === "string" && o.name ? o.name : String(o.id ?? "");
  return o.me ? `${name} (me)` : name;
}

/** The printed form of a mark's outcome. */
function markRow(m: MarkOutcome): Obj {
  return { marked: m.marked, already_marked: m.already_marked, failed: m.failed, ...(m.reason ? { reason: m.reason } : {}) };
}

function cut(n: number, total: unknown): boolean {
  return typeof total === "number" && total > n;
}

function limitFlag(max: number, def: string) {
  return { type: "int" as const, value: "<n>", desc: `at most this many (${def}, max ${max})` };
}

function checkLimit(v: unknown, max: number): number | undefined {
  const n = v as number | undefined;
  if (n !== undefined && (n < 1 || n > max)) throw invalid(`--limit must be from 1 to ${max}, got ${n}`);
  return n;
}

// ---- chats -----------------------------------------------------------------

export const chatsSpec: CommandSpec = {
  name: "chats",
  summary: "Chats with kept content: id, name, type, effective scope",
  positionals: [],
  flags: {
    limit: limitFlag(10000, "default: all"),
    fields: { type: "string", value: "<list>", desc: "add columns: last_kept, discarded, messages, override" },
  },
  examples: ["whatsapp-axi chats", "whatsapp-axi chats --limit 10 --fields last_kept,discarded"],
  jsonOut: true,
};

export async function chats(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(chatsSpec, args);
  const fields = parseFields(chatsSpec, p.flags.fields, ["last_kept", "discarded", "messages", "override"]);
  const limit = checkLimit(p.flags.limit, 10000);
  const name = account(ctx);
  const d = ctx.daemon(name);
  const res = await d.call("GET", `/v1/chats${q({ limit })}`);
  expect(d, Array.isArray(res.chats), "chats is not a list");
  const list = (res.chats as Obj[]).map((c) => ({ ...c, last_kept: fields.includes("last_kept") ? time(ctx, c.last_kept) : undefined }));
  const count = countOf(d, list.length, res.total);
  const af = acctFlag(ctx, name);
  if (list.length === 0) {
    return { chats: "0 chats with kept content", help: [`Run \`whatsapp-axi scope show${af}\` to see what this account keeps`] };
  }
  const help = [`Run \`whatsapp-axi read <chat>${af}\` to read a chat`, `Run \`whatsapp-axi chat view <chat>${af}\` for its participants`];
  if (cut(list.length, res.total)) help.unshift(`Run \`whatsapp-axi chats --limit ${res.total as number}${af}\` to see all ${res.total as number}`);
  return { count, chats: pick(list, ["id", "name", "type", "scope", ...fields]), help };
}

// ---- groups ----------------------------------------------------------------

export const groupsSpec: CommandSpec = {
  name: "groups",
  summary: "Every group the account is a member of, kept content or not: id, name, effective scope, member count",
  positionals: [],
  flags: { limit: limitFlag(10000, "default: all"), fields: { type: "string", value: "<list>", desc: "add columns: discarded, override" } },
  examples: ["whatsapp-axi groups", "whatsapp-axi groups --limit 20 --fields discarded"],
  jsonOut: true,
};

export async function groups(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(groupsSpec, args);
  const fields = parseFields(groupsSpec, p.flags.fields, ["discarded", "override"]);
  const limit = checkLimit(p.flags.limit, 10000);
  const name = account(ctx);
  const d = ctx.daemon(name);
  const res = await d.call("GET", `/v1/groups${q({ limit })}`);
  expect(d, Array.isArray(res.groups), "groups is not a list");
  const list = res.groups as Obj[];
  const count = countOf(d, list.length, res.total);
  const af = acctFlag(ctx, name);
  if (list.length === 0) return { groups: "0 groups: the account is not a member of any group" };
  const help = [
    `Run \`whatsapp-axi chat view <group>${af}\` for its participants`,
    `Run \`whatsapp-axi scope set <scope> --chat <group>${af}\` to change what is kept from it`,
  ];
  if (cut(list.length, res.total)) help.unshift(`Run \`whatsapp-axi groups --limit ${res.total as number}${af}\` to see all ${res.total as number}`);
  return { count, groups: pick(list, ["id", "name", "scope", "members", ...fields]), help };
}

// ---- chat view -------------------------------------------------------------

export const chatViewSpec: CommandSpec = {
  name: "chat view",
  summary: "One chat, with participants marked me, operator, contact",
  positionals: [{ name: "chat", required: true, desc: "group id, hidden id, phone-number id or +phone" }],
  flags: { fields: { type: "string", value: "<list>", desc: "add participant columns: lid, pn" } },
  examples: ["whatsapp-axi chat view 120363000000000001@g.us", "whatsapp-axi chat view +15550100001"],
  jsonOut: true,
};

export async function chatView(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(chatViewSpec, args);
  const fields = parseFields(chatViewSpec, p.flags.fields, ["lid", "pn"]);
  const d = ctx.daemon(account(ctx));
  const res = await d.call("GET", `/v1/chats/${enc(p.pos[0])}`);
  const c = res.chat as Obj | undefined;
  expect(d, c && typeof c.id === "string" && Array.isArray(c.participants), "chat is missing fields");
  const parts = (c.participants as Obj[]).map((u) => {
    const marks = [u.me ? "me" : "", u.operator ? "operator" : "", u.contact ? "contact" : ""].filter(Boolean).join(" ") || "-";
    return { id: u.id, name: u.name || null, marks, lid: u.lid ?? null, pn: u.pn ?? null };
  });
  return {
    chat: {
      id: c.id,
      name: c.name || undefined,
      type: c.type,
      scope: c.scope,
      override: c.override,
      last_kept: time(ctx, c.last_kept),
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
    after: { type: "int", value: "<seq>", desc: "events with a higher seq (default: the most recent)" },
    limit: limitFlag(1000, "default 100"),
    chat: { type: "string", value: "<chat>", desc: "only this chat" },
    kind: { type: "string", value: "<kind>", desc: `only this kind: ${KINDS.join(", ")}`, values: KINDS },
    follow: { type: "bool", desc: "keep printing new events as they are kept, until interrupted" },
    "mark-read": { type: "bool", desc: "send read receipts for the incoming messages returned" },
    fields: { type: "string", value: "<list>", desc: "add columns: t, id, from, kept_by, mentions_me" },
  },
  examples: ["whatsapp-axi events --after 412", "whatsapp-axi events --kind message --limit 20", "whatsapp-axi events --after 412 --follow --mark-read"],
  mutation: "mark-read",
  jsonOut: true,
};

function eventRow(ctx: Ctx, e: Obj, withTime: boolean): Obj {
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
    t: withTime ? (time(ctx, e.t) ?? null) : null,
    id: m?.id ?? e.target ?? null,
    from: m ? ((m.from as Obj)?.id ?? null) : ((e.from as Obj | undefined)?.id ?? null),
    kept_by: m?.kept_by ?? null,
    mentions_me: m?.mentions_me ?? null,
  };
}

/** The filters of an events call, in words, for an empty result. */
function filterWords(after: number | undefined, chat: string | undefined, kind: string | undefined): string {
  return [after !== undefined ? `after seq ${after}` : "", chat ? `in ${chat}` : "", kind ? `of kind ${kind}` : ""].filter(Boolean).join(" ");
}

export async function events(ctx: Ctx, args: string[], write: (s: string) => void, signal?: AbortSignal): Promise<unknown> {
  const p = parse(eventsSpec, args);
  const fields = parseFields(eventsSpec, p.flags.fields, ["t", "id", "from", "kept_by", "mentions_me"]);
  const limit = checkLimit(p.flags.limit, 1000);
  const name = account(ctx, { mutation: p.flags["mark-read"] === true });
  const d = ctx.daemon(name);
  const af = acctFlag(ctx, name);
  const keys = ["seq", "kind", "chat", "detail", ...fields];
  const after = p.flags.after as number | undefined;
  const chatF = p.flags.chat as string | undefined;
  const kindF = p.flags.kind as string | undefined;
  const filters = `${chatF ? ` --chat ${chatF}` : ""}${kindF ? ` --kind ${kindF}` : ""}`;
  const query = { after, limit, chat: chatF, kind: kindF, mark_read: p.flags["mark-read"] ? 1 : undefined };

  if (p.flags.follow) {
    let last = after;
    let unmarked = 0;
    let reason: string | undefined;
    try {
      for await (const e of d.stream(`/v1/events${q({ ...query, follow: 1 })}`, signal)) {
        if (e.error && typeof e.error === "object") {
          // A mark that failed: said on the stream in the error shape, and the stream goes on.
          const err = e.error as Obj;
          const m = asMarkOutcome(d, err);
          unmarked += m.failed;
          reason = m.reason ?? reason;
          write(
            line({
              error: typeof err.message === "string" ? err.message : `${m.failed} not marked read`,
              code: "MARK_FAILED",
              failed: m.failed,
              ...(m.reason ? { reason: m.reason } : {}),
            }),
          );
          continue;
        }
        expect(d, typeof e.seq === "number" && typeof e.kind === "string", "event is missing fields");
        write(line({ events: pick([eventRow(ctx, e, fields.includes("t"))], keys) }));
        last = e.seq as number;
      }
    } catch (err) {
      // A follow that loses the daemon says the last seq it delivered and how to resume from it.
      const e = err as ToolError;
      if (e instanceof ToolError && ["STREAM_CLOSED", "DAEMON_UNREACHABLE", "DAEMON_NOT_RUNNING"].includes(e.code)) {
        if (last !== undefined) e.before = { ...e.before, last_seq: last };
        const markFlag = p.flags["mark-read"] ? " --mark-read" : "";
        e.suggestions.unshift(
          `Run \`whatsapp-axi events${last !== undefined ? ` --after ${last}` : ""} --follow${markFlag}${filters}${af}\` to resume once the daemon is back`,
        );
      }
      throw err;
    }
    const out: Obj = {};
    if (last !== undefined) out.last_seq = last;
    if (unmarked) {
      Object.assign(
        out,
        markError(ctx, { marked: 0, already_marked: 0, failed: unmarked, reason }, af, `whatsapp-axi events --after ${after ?? 0} --mark-read${filters}${af}`),
      );
    }
    return out;
  }

  const res = await d.call("GET", `/v1/events${q(query)}`);
  expect(d, Array.isArray(res.events) && typeof res.latest_seq === "number", "events is missing fields");
  const list = res.events as Obj[];
  for (const e of list) expect(d, typeof e.seq === "number" && typeof e.kind === "string", "event is missing fields");
  const count = countOf(d, list.length, res.total);
  const lastSeq = list.length ? (list[list.length - 1].seq as number) : (after ?? (res.latest_seq as number));
  const out: Obj = {};
  let help: string[];
  if (list.length === 0) {
    const w = filterWords(after, chatF, kindF);
    out.events = `0 events${w ? ` ${w}` : ""}`;
    help = [`Run \`whatsapp-axi events --after ${lastSeq} --follow${filters}${af}\` to wait for new events`];
  } else {
    if (after === undefined) out.note = `showing the ${plural(list.length, "most recent event")}; pass --after <seq> to read forward`;
    out.count = count;
    out.events = pick(
      list.map((e) => eventRow(ctx, e, fields.includes("t"))),
      keys,
    );
    help = [
      `Run \`whatsapp-axi events --after ${lastSeq}${filters}${af}\` for what comes next`,
      `Run \`whatsapp-axi message view <chat>/<id>${af}\` for a message in full`,
    ];
    if (cut(list.length, res.total)) {
      const rest = (res.total as number) - list.length;
      help.unshift(
        after !== undefined
          ? `Run \`whatsapp-axi events --after ${lastSeq}${filters}${af}\` for the ${rest} more after seq ${lastSeq}`
          : `Run \`whatsapp-axi events --after 0 --limit ${Math.min(1000, res.total as number)}${filters}${af}\` to read the ${rest} older events from the start`,
      );
    }
  }
  if (p.flags["mark-read"]) {
    const mark = asMarkOutcome(d, res.mark_read);
    out.mark_read = markRow(mark);
    if (mark.failed > 0) {
      out.last_seq = lastSeq;
      const e = markError(ctx, mark, af, `whatsapp-axi events${after !== undefined ? ` --after ${after}` : ""} --mark-read${filters}${af}`);
      return { ...out, error: e.error, code: e.code, help: [...e.help, ...help] };
    }
  }
  out.help = help;
  out.last_seq = lastSeq;
  return out;
}

// ---- read ------------------------------------------------------------------

export const readSpec: CommandSpec = {
  name: "read",
  summary: "Kept messages of a chat, oldest first",
  positionals: [{ name: "chat", required: true, desc: "group id, hidden id, phone-number id or +phone" }],
  flags: {
    limit: limitFlag(500, "default 50"),
    before: { type: "string", value: "<id>", desc: "messages older than this message id" },
    "mark-read": { type: "bool", desc: "send read receipts for the incoming messages returned" },
    fields: { type: "string", value: "<list>", desc: "add columns: kept_by, mentions_me, reply_to, media, operator" },
  },
  examples: ["whatsapp-axi read 120363000000000001@g.us", "whatsapp-axi read +15550100001 --limit 10"],
  mutation: "mark-read",
  jsonOut: true,
};

export async function read(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(readSpec, args);
  const fields = parseFields(readSpec, p.flags.fields, ["kept_by", "mentions_me", "reply_to", "media", "operator"]);
  const limit = checkLimit(p.flags.limit, 500);
  const name = account(ctx, { mutation: p.flags["mark-read"] === true });
  const d = ctx.daemon(name);
  const res = await d.call(
    "GET",
    `/v1/messages${q({ chat: p.pos[0], before: p.flags.before as string | undefined, limit, mark_read: p.flags["mark-read"] ? 1 : undefined })}`,
  );
  const chat = res.chat as Obj | undefined;
  expect(d, chat && typeof chat.id === "string" && Array.isArray(res.messages), "messages is missing fields");
  const list = res.messages as Obj[];
  const count = countOf(d, list.length, res.total);
  const af = acctFlag(ctx, name);
  const out: Obj = { chat: chat.id };
  if (list.length === 0) {
    out.messages = `0 kept messages in ${chat.id as string}${p.flags.before ? ` before ${p.flags.before}` : ""}`;
  } else {
    const rows = list.map((m) => ({
      id: m.id,
      t: time(ctx, m.t) ?? null,
      from: who(m.from),
      text: m.deleted ? "[deleted]" : cell(m.text || (m.media ? `[${(m.media as Obj).type}]` : ""), 200),
      kept_by: m.kept_by ?? null,
      mentions_me: m.mentions_me ?? null,
      reply_to: (m.reply_to as Obj | undefined)?.id ?? null,
      media: m.media ? (m.media as Obj).type : null,
      operator: (m.from as Obj | undefined)?.operator ?? null,
    }));
    out.count = count;
    out.messages = pick(rows, ["id", "t", "from", "text", ...fields]);
  }
  const help = list.length ? [`Run \`whatsapp-axi message view ${chat.id as string}/<id>${af}\` for one message in full`] : [];
  if (list.length && (res.more === true || cut(list.length, res.total))) {
    help.unshift(`Run \`whatsapp-axi read ${chat.id as string} --before ${list[0].id as string}${af}\` for older messages`);
  }
  if (p.flags["mark-read"]) {
    const mark = asMarkOutcome(d, res.mark_read);
    out.mark_read = markRow(mark);
    if (mark.failed > 0) {
      const e = markError(ctx, mark, af, `whatsapp-axi read ${chat.id as string}${p.flags.before ? ` --before ${p.flags.before}` : ""} --mark-read${af}`);
      return { ...out, error: e.error, code: e.code, help: [...e.help, ...help] };
    }
  }
  if (help.length) out.help = help;
  return out;
}

// ---- message view ----------------------------------------------------------

export const messageViewSpec: CommandSpec = {
  name: "message view",
  summary: "One kept message in full, with its reply context and media descriptor",
  positionals: [{ name: "ref", required: true, desc: "<message id> or <chat>/<message id>" }],
  flags: { full: { type: "bool", desc: "print long text in full" } },
  examples: ["whatsapp-axi message view 3EB0AAAA0000000001", "whatsapp-axi message view 120363000000000001@g.us/3EB0AAAA0000000001"],
  jsonOut: true,
};

export function splitRef(ref: string): { chat: string; id: string } {
  const i = ref.lastIndexOf("/");
  return i >= 0 ? { chat: ref.slice(0, i), id: ref.slice(i + 1) } : { chat: "", id: ref };
}

export function refOf(ref: string): { chat: string; id: string } {
  const r = splitRef(ref);
  if (!r.id) throw invalid(`${JSON.stringify(ref)} is not a message ref: use <id> or <chat>/<id>`);
  return r;
}

export async function messageView(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(messageViewSpec, args);
  const { chat: c0, id: i0 } = refOf(p.pos[0]);
  const name = account(ctx);
  const d = ctx.daemon(name);
  const res = await d.call("GET", c0 ? `/v1/messages/${enc(c0)}/${enc(i0)}` : `/v1/messages/${enc(i0)}`);
  const m = res.message as Obj | undefined;
  const chat = res.chat as Obj | undefined;
  expect(d, m && chat && typeof m.id === "string", "message is missing fields");
  const full = Boolean(p.flags.full);
  const body = longText(String(m.text ?? ""), full);
  const msg: Obj = {
    id: m.id,
    chat: chat.id,
    t: time(ctx, m.t),
    from: user(m.from),
    text: body.text,
    kept_by: m.kept_by,
    ...(typeof m.mentions_me === "boolean" ? { mentions_me: m.mentions_me } : {}),
  };
  if (m.partial) msg.partial = true;
  if (m.edited) msg.edited = true;
  if (m.deleted) msg.deleted = true;
  if (Array.isArray(m.mentions) && m.mentions.length) msg.mentions = (m.mentions as Obj[]).map((u) => who(u));
  const r = m.reply_to as Obj | undefined;
  if (r) {
    expect(d, typeof r.id === "string" && typeof r.kept === "boolean", "reply_to without id and kept");
    const rt = longText(String(r.text ?? ""), full);
    msg.reply_to = { id: r.id, ...(r.from ? { from: who(r.from) } : {}), text: rt.text, kept: r.kept };
    body.truncated ||= rt.truncated;
  }
  const md = m.media as Obj | undefined;
  if (md) msg.media = { type: md.type, mime: md.mime, name: md.name || undefined, size: md.size, ...(md.view_once ? { view_once: true } : {}) };
  if (typeof m.ephemeral === "number") msg.ephemeral = m.ephemeral;
  if (Array.isArray(m.reactions) && m.reactions.length) msg.reactions = (m.reactions as Obj[]).map((x) => ({ from: who(x.from), emoji: x.emoji }));
  const out: Obj = { message: msg };
  if (body.truncated) out.help = [`Run \`whatsapp-axi message view ${chat.id as string}/${m.id} --full${acctFlag(ctx, name)}\` for the complete text`];
  return out;
}

// ---- forget ----------------------------------------------------------------

export const forgetSpec: CommandSpec = {
  name: "forget",
  summary: "Delete kept content for a chat, or for one message with --message",
  positionals: [{ name: "chat", required: true, desc: "group id, hidden id, phone-number id or +phone" }],
  flags: {
    message: { type: "string", value: "<ref>", desc: "only this message (<id> or <chat>/<id>)" },
    confirm: { type: "bool", desc: "required: forgetting cannot be undone" },
  },
  examples: ["whatsapp-axi forget 120363000000000001@g.us --confirm", "whatsapp-axi forget 120363000000000001@g.us --message 3EB0AAAA0000000001 --confirm"],
  mutation: true,
  jsonOut: true,
};

export async function forget(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(forgetSpec, args);
  const chatArg = p.pos[0];
  const body: Obj = { chat: chatArg };
  if (p.flags.message !== undefined) {
    const { chat, id } = splitRef(String(p.flags.message));
    if (!id) throw usage("--message needs <id> or <chat>/<id>");
    if (chat && chat !== chatArg) throw contradiction(`--message ${p.flags.message}`, `the chat ${chatArg}`);
    body.id = id;
  }
  const name = account(ctx);
  if (!p.flags.confirm) {
    throw confirmRequired("forgetting deletes kept content and cannot be undone; add --confirm", [
      `Run \`whatsapp-axi forget ${chatArg}${p.flags.message ? ` --message ${p.flags.message}` : ""} --confirm${acctFlag(ctx, name)}\` to delete it`,
    ]);
  }
  const d: Daemon = ctx.daemon(name);
  const res = await d.call("POST", "/v1/forget", body);
  const f = res.forgotten as Obj | undefined;
  expect(d, f && typeof f.messages === "number" && typeof f.events === "number", "forget is missing fields");
  if (f.messages === 0 && f.events === 0)
    return { action: "unchanged", reason: `nothing kept${f.message ? ` for message ${f.message as string}` : ""} in ${f.chat as string} (no-op)` };
  return { action: "deleted", chat: f.chat, ...(f.message ? { message: f.message } : {}), messages: f.messages, events: f.events };
}
