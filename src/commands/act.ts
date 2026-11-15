// send, send-file, react, download, mark-read and typing (specs/cli.md "Acting", specs/sending.md).
// The daemon enforces the send limits; the CLI validates its flags, passes the request on, and
// renders the answer or the daemon's error with its fix. Every result says `action:` from the
// closed set (specs/conventions.md "Mutations").
import { resolve } from "node:path";
import { contradiction, parse, type CommandSpec } from "../flags.js";
import { expect, type Daemon } from "../client.js";
import { invalid, usage } from "../errors.js";
import { commandLine } from "../config.js";
import { account, acctFlag, asMarkOutcome, markError, time, type Ctx } from "../context.js";
import { refOf, splitRef } from "./read.js";

type Obj = Record<string, unknown>;
const FIRST = { type: "bool" as const, desc: "allow a send to a chat with nothing received or sent yet" };
const REPLY = { type: "string" as const, value: "<ref>", desc: "quote a kept message of the same chat: <id> or <chat>/<id>" };
const ID = {
  type: "string" as const,
  value: "<id>",
  desc: "the message id to send under, 16 to 48 characters of 0-9 and A-F; the same --id again sends nothing and answers already_sent",
};
const ID_RE = /^[0-9A-F]{16,48}$/;

function replyID(chat: string, ref: unknown): string | undefined {
  if (ref === undefined) return undefined;
  const { chat: c, id } = splitRef(String(ref));
  if (!id) throw invalid(`--reply needs <id> or <chat>/<id>, got ${JSON.stringify(ref)}`);
  if (c && c !== chat) throw contradiction(`--reply ${String(ref)}`, `the chat ${chat}`, ["A reply quotes a message of the same chat"]);
  return id;
}

function checkID(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const id = String(v);
  if (!ID_RE.test(id)) throw invalid(`--id must be 16 to 48 characters of 0-9 and A-F (uppercase hex), as WhatsApp message ids are; got ${JSON.stringify(id)}`);
  return id;
}

/** The command as typed, with --id <id> in place of any given, for a safe retry. */
function retryLine(ctx: Ctx, id: string, af: string): string {
  const words = [...(ctx.spec?.name.split(" ") ?? []), ...ctx.argv];
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--id") {
      i++;
      continue;
    }
    if (words[i].startsWith("--id=")) continue;
    out.push(words[i]);
  }
  return `${commandLine(out)} --id ${id}${af}`;
}

function sentOut(ctx: Ctx, d: Daemon, res: Obj, af: string, given: string | undefined, extra: Obj = {}): unknown {
  expect(d, typeof res.id === "string" && typeof res.chat === "string", "send answer is missing fields");
  const already = res.already_sent === true;
  return {
    action: already ? "already_sent" : "sent",
    id: res.id,
    chat: res.chat,
    t: time(ctx, res.t),
    ...extra,
    ...(typeof res.warning === "string" && res.warning ? { warning: res.warning } : {}),
    note: already
      ? "a message with this id was already sent to this chat; nothing was sent again"
      : given
        ? "running this again with the same --id sends nothing more"
        : `running this again without --id sends a second message; add --id ${res.id as string} to make a retry safe`,
    help: [`Run \`whatsapp-axi read ${res.chat as string}${af}\` to see the chat`, `Run \`whatsapp-axi events --follow${af}\` to wait for replies`],
  };
}

// ---- send ------------------------------------------------------------------

export const sendSpec: CommandSpec = {
  name: "send",
  summary: "Send a text to a chat; `-` as the text reads it from standard input. --id makes a retry safe",
  positionals: [
    { name: "chat", required: true, desc: "group id, hidden id, phone-number id or +phone" },
    { name: "text", required: true, desc: "the text, or - to read standard input" },
  ],
  flags: {
    reply: REPLY,
    mention: { type: "string", value: "<user>", desc: "mention a member (hidden id, phone-number id or +phone); repeatable", repeat: true },
    "first-contact": FIRST,
    id: ID,
  },
  examples: [
    'whatsapp-axi send 120363000000000001@g.us "On it"',
    'whatsapp-axi send 120363000000000001@g.us "Done" --reply 3EB0AAAA0000000001 --mention +15550100001',
    'whatsapp-axi send 120363000000000001@g.us "On it" --id 3EB0C0FFEE00000000000001',
    "echo hello | whatsapp-axi send +15550100001 - --first-contact",
  ],
  mutation: true,
  jsonOut: true,
};

export async function send(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(sendSpec, args);
  const [chat, textArg] = p.pos;
  const id = checkID(p.flags.id);
  const reply = replyID(chat, p.flags.reply);
  const name = account(ctx);
  const text = textArg === "-" ? ctx.io.stdin() : textArg;
  if (!text.trim()) throw invalid("the text is empty");
  const d = ctx.daemon(name);
  const af = acctFlag(ctx, name);
  const body: Obj = { chat, text };
  if (id) body.id = id;
  if (reply) body.reply_to = reply;
  if (p.flags.mention) body.mentions = p.flags.mention;
  if (p.flags["first-contact"]) body.first_contact = true;
  const res = await sendWithRetry(ctx, d, "/v1/send", body, chat, id, af);
  return sentOut(ctx, d, res, af, id);
}

/** A send whose OUTCOME_UNKNOWN names the full retry command with the id. */
async function sendWithRetry(ctx: Ctx, d: Daemon, path: string, body: Obj, chat: string, id: string | undefined, af: string): Promise<Obj> {
  try {
    return await d.send(path, body, { chat, id, ...(id ? { retry: retryLine(ctx, id, af) } : {}) });
  } catch (err) {
    const e = err as { code?: string; details?: Obj; suggestions?: string[] };
    const known = typeof e.details?.id === "string" ? (e.details.id as string) : undefined;
    if (e.code === "OUTCOME_UNKNOWN" && !id && known && e.suggestions) {
      e.suggestions.push(`Run \`${retryLine(ctx, known, af)}\` to retry safely: a send with the same --id is never sent twice`);
      (err as Error).message = `${(err as Error).message} (id ${known})`;
    }
    throw err;
  }
}

// ---- send-file -------------------------------------------------------------

const AS = ["image", "video", "audio", "document"];

export const sendFileSpec: CommandSpec = {
  name: "send-file",
  summary: "Send a file; the type is picked from its MIME type unless --as forces one. --id makes a retry safe",
  positionals: [
    { name: "chat", required: true, desc: "group id, hidden id, phone-number id or +phone" },
    { name: "path", required: true, desc: "the file to send" },
  ],
  flags: {
    caption: { type: "string", value: "<text>", desc: "caption (not for audio)" },
    as: { type: "string", value: "<type>", desc: "image, video, audio or document", values: AS },
    reply: REPLY,
    "first-contact": FIRST,
    id: ID,
  },
  examples: ["whatsapp-axi send-file 120363000000000001@g.us ./report.pdf --caption \"The report\"", "whatsapp-axi send-file +15550100001 ./photo.png --as document"],
  mutation: true,
  jsonOut: true,
};

export async function sendFile(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(sendFileSpec, args);
  const [chat, path] = p.pos;
  const id = checkID(p.flags.id);
  const reply = replyID(chat, p.flags.reply);
  const name = account(ctx);
  const d = ctx.daemon(name);
  const af = acctFlag(ctx, name);
  const body: Obj = { chat, path: resolve(ctx.io.cwd, path) };
  if (id) body.id = id;
  if (p.flags.caption !== undefined) body.caption = p.flags.caption;
  if (p.flags.as !== undefined) body.as = p.flags.as;
  if (reply) body.reply_to = reply;
  if (p.flags["first-contact"]) body.first_contact = true;
  const res = await sendWithRetry(ctx, d, "/v1/send-file", body, chat, id, af);
  const media = (res.media ?? {}) as Obj;
  return sentOut(ctx, d, res, af, id, { type: media.type, mime: media.mime });
}

// ---- react -----------------------------------------------------------------

export const reactSpec: CommandSpec = {
  name: "react",
  summary: "React to a kept message, or remove the account's reaction with --remove",
  positionals: [
    { name: "ref", required: true, desc: "<id> or <chat>/<id>" },
    { name: "emoji", required: false, desc: "the emoji (omit with --remove)" },
  ],
  flags: { remove: { type: "bool", desc: "remove the account's reaction" } },
  examples: ["whatsapp-axi react 3EB0AAAA0000000001 👍", "whatsapp-axi react 120363000000000001@g.us/3EB0AAAA0000000001 --remove"],
  mutation: true,
  jsonOut: true,
};

export async function react(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(reactSpec, args);
  const [ref, emojiArg] = p.pos;
  const remove = p.flags.remove === true;
  if (remove && emojiArg !== undefined) throw contradiction("an emoji", "--remove");
  if (!remove && !emojiArg) throw usage("<emoji> is required (or --remove)", ["usage: whatsapp-axi react <ref> <emoji>", "usage: whatsapp-axi react <ref> --remove"]);
  const { chat, id } = refOf(ref);
  const name = account(ctx);
  const d = ctx.daemon(name);
  const af = acctFlag(ctx, name);
  const body: Obj = { id, emoji: remove ? "" : emojiArg };
  if (chat) body.chat = chat;
  const res = await d.send("/v1/react", body, { chat: chat || undefined });
  expect(d, typeof res.changed === "boolean" && typeof res.chat === "string", "react answer is missing fields");
  const target = `${res.chat as string}/${id}`;
  const warning = typeof res.warning === "string" && res.warning ? { warning: res.warning } : {};
  if (!res.changed) return { action: "unchanged", reason: remove ? `no reaction of this account on ${target} (no-op)` : `${emojiArg} already on ${target} (no-op)`, ...warning };
  if (remove) return { action: "unreacted", message: target, ...warning };
  return { action: "reacted", message: target, emoji: emojiArg, ...warning, help: [`Run \`whatsapp-axi react ${target} --remove${af}\` to undo`] };
}

// ---- download --------------------------------------------------------------

export const downloadSpec: CommandSpec = {
  name: "download",
  summary: "Fetch a kept message's media and print the local path",
  positionals: [{ name: "ref", required: true, desc: "<id> or <chat>/<id>" }],
  flags: {},
  examples: ["whatsapp-axi download 3EB0AAAA0000000001", "whatsapp-axi download 120363000000000001@g.us/3EB0AAAA0000000001"],
  mutation: true,
  jsonOut: true,
};

export async function download(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(downloadSpec, args);
  const { chat, id } = refOf(p.pos[0]);
  const d = ctx.daemon(account(ctx));
  const body: Obj = { id };
  if (chat) body.chat = chat;
  const res = await d.call("POST", "/v1/download", body);
  expect(d, typeof res.path === "string" && typeof res.existing === "boolean", "download answer is missing fields");
  return {
    action: res.existing ? "unchanged" : "created",
    ...(res.existing ? { reason: "already downloaded (no-op)" } : {}),
    path: res.path,
    name: res.name || undefined,
    mime: res.mime || undefined,
    size: res.size,
  };
}

// ---- mark-read -------------------------------------------------------------

export const markReadSpec: CommandSpec = {
  name: "mark-read",
  summary: "Mark one kept message read, or with --chat everything kept in a chat (sends read receipts)",
  positionals: [{ name: "ref", required: false, desc: "<id> or <chat>/<id>" }],
  flags: { chat: { type: "string", value: "<chat>", desc: "mark everything kept in this chat instead of one message" } },
  examples: ["whatsapp-axi mark-read 120363000000000001@g.us/3EB0AAAA0000000001", "whatsapp-axi mark-read --chat 120363000000000001@g.us"],
  mutation: true,
  jsonOut: true,
};

export async function markRead(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(markReadSpec, args);
  const ref = p.pos[0];
  const chatFlag = p.flags.chat as string | undefined;
  if (ref !== undefined && chatFlag !== undefined) throw contradiction("a message <ref>", "--chat <chat>");
  if (ref === undefined && chatFlag === undefined) throw usage("give a message <ref> or --chat <chat>", ["usage: whatsapp-axi mark-read <chat>/<id>", "usage: whatsapp-axi mark-read --chat <chat>"]);
  const body: Obj = {};
  if (ref !== undefined) {
    const { chat, id } = refOf(ref);
    body.id = id;
    if (chat) body.chat = chat;
  }
  const name = account(ctx);
  const d = ctx.daemon(name);
  if (ref === undefined) {
    // Everything kept in the chat: up to and including its newest kept message.
    const page = await d.call("GET", `/v1/messages?chat=${encodeURIComponent(chatFlag as string)}&limit=1`);
    const chat = page.chat as Obj | undefined;
    expect(d, chat && typeof chat.id === "string" && Array.isArray(page.messages), "messages is missing fields");
    const last = (page.messages as Obj[])[0];
    if (!last) return { action: "unchanged", reason: `0 kept messages in ${chat.id as string}; nothing to mark (no-op)` };
    body.chat = chat.id;
    body.through = last.id;
  }
  const res = await d.call("POST", "/v1/mark-read", body);
  const m = asMarkOutcome(d, res);
  expect(d, typeof res.chat === "string", "mark-read answer is missing its chat");
  const af = acctFlag(ctx, name);
  const counts = { chat: res.chat, marked: m.marked, already_marked: m.already_marked, failed: m.failed, ...(m.reason ? { reason: m.reason } : {}) };
  if (m.failed > 0) {
    // Asked for and not sent: never reported as done. A partial mark says how many went out.
    const retry = `whatsapp-axi mark-read ${ref !== undefined ? ref : `--chat ${chatFlag}`}${af}`;
    return { action: m.marked ? "marked" : "unchanged", ...counts, ...markError(ctx, m, af, retry) };
  }
  if (m.marked === 0) return { action: "unchanged", ...counts, reason: `nothing new in ${res.chat as string} (no-op)` };
  return { action: "marked", ...counts };
}

// ---- typing ----------------------------------------------------------------

export const typingSpec: CommandSpec = {
  name: "typing",
  summary: "Show the account as typing in a chat; clears on --stop, on a send to the chat, or after two minutes",
  positionals: [{ name: "chat", required: true, desc: "group id, hidden id, phone-number id or +phone" }],
  flags: { stop: { type: "bool", desc: "clear the typing indicator" } },
  examples: ["whatsapp-axi typing 120363000000000001@g.us", "whatsapp-axi typing 120363000000000001@g.us --stop"],
  mutation: true,
  jsonOut: true,
};

export async function typing(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(typingSpec, args);
  const on = p.flags.stop !== true;
  const name = account(ctx);
  const d = ctx.daemon(name);
  const res = await d.call("POST", "/v1/typing", { chat: p.pos[0], on });
  expect(d, typeof res.chat === "string" && typeof res.typing === "boolean", "typing answer is missing fields");
  const chat = res.chat as string;
  if (on) return { action: "set", chat, typing: true, note: "clears on a send to the chat, on --stop, or after two minutes", help: [`Run \`whatsapp-axi typing ${chat} --stop${acctFlag(ctx, name)}\` to clear it`] };
  if (res.changed === false) return { action: "unchanged", chat, reason: "the account was not typing there (no-op)" };
  return { action: "removed", chat, typing: false };
}
