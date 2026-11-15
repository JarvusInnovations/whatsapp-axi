// send, send-file, react and download (specs/cli.md "Acting", specs/sending.md). The daemon
// enforces the send limits; the CLI validates its flags, passes the request on, and renders the
// answer or the daemon's error with its fix.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, type CommandSpec } from "../args.js";
import { expect } from "../client.js";
import { usage } from "../errors.js";
import { chooseAccount, type Ctx } from "../context.js";
import { acctFlag, splitRef } from "./read.js";

type Obj = Record<string, unknown>;
const ACCOUNT = { type: "string" as const, value: "<name>", desc: "the account (required when there are several)" };
const FIRST = { type: "bool" as const, desc: "allow a send to a chat with nothing received or sent yet" };
const REPLY = { type: "string" as const, value: "<ref>", desc: "quote a kept message of the same chat: <id> or <chat>/<id>" };

function replyID(chat: string, ref: unknown): string | undefined {
  if (ref === undefined) return undefined;
  const { chat: c, id } = splitRef(String(ref));
  if (!id) throw usage(`--reply needs <id> or <chat>/<id>, got ${JSON.stringify(ref)}`);
  if (c && c !== chat) throw usage(`--reply ${String(ref)} names a different chat than ${chat}; a reply quotes a message of the same chat`);
  return id;
}

function sentOut(d: { account: string }, res: Obj, af: string, extra: Obj = {}): unknown {
  expect(d as never, typeof res.id === "string" && typeof res.chat === "string", "send answer is missing fields");
  return {
    sent: { id: res.id, chat: res.chat, t: res.t ?? null, ...extra },
    help: [`Run \`whatsapp-axi read ${res.chat as string}${af}\` to see the chat`, `Run \`whatsapp-axi events --follow${af}\` to wait for replies`],
  };
}

// ---- send ------------------------------------------------------------------

export const sendSpec: CommandSpec = {
  name: "send",
  summary: "Send a text to a chat; `-` as the text reads it from standard input",
  positionals: [
    { name: "chat", required: true, desc: "group id, hidden id, phone-number id or +phone" },
    { name: "text", required: true, desc: "the text, or - to read standard input" },
  ],
  flags: {
    account: ACCOUNT,
    reply: REPLY,
    mention: { type: "string", value: "<user>", desc: "mention a member (hidden id, phone-number id or +phone); repeatable", repeat: true },
    "first-contact": FIRST,
  },
  examples: [
    'whatsapp-axi send 120363000000000001@g.us "On it"',
    'whatsapp-axi send 120363000000000001@g.us "Done" --reply 3EB0AAAA0000000001 --mention +15550100001',
    "echo hello | whatsapp-axi send +15550100001 - --first-contact",
  ],
};

export async function send(ctx: Ctx, args: string[], stdin: () => string = () => readFileSync(0, "utf-8")): Promise<unknown> {
  const p = parse(sendSpec, args);
  const [chat, textArg] = p.pos;
  const text = textArg === "-" ? stdin() : textArg;
  if (!text.trim()) throw usage("the text is empty");
  const reply = replyID(chat, p.flags.reply);
  const account = chooseAccount(ctx, p.flags.account, "send");
  const d = ctx.daemon(account);
  const body: Obj = { chat, text };
  if (reply) body.reply_to = reply;
  if (p.flags.mention) body.mentions = p.flags.mention;
  if (p.flags["first-contact"]) body.first_contact = true;
  const res = await d.call("POST", "/v1/send", body);
  return sentOut(d, res, acctFlag(ctx, account));
}

// ---- send-file -------------------------------------------------------------

const AS = ["image", "video", "audio", "document"];

export const sendFileSpec: CommandSpec = {
  name: "send-file",
  summary: "Send a file; the type is picked from its MIME type unless --as forces one",
  positionals: [
    { name: "chat", required: true, desc: "group id, hidden id, phone-number id or +phone" },
    { name: "path", required: true, desc: "the file to send" },
  ],
  flags: {
    account: ACCOUNT,
    caption: { type: "string", value: "<text>", desc: "caption (not for audio)" },
    as: { type: "string", value: "<type>", desc: "image, video, audio or document" },
    reply: REPLY,
    "first-contact": FIRST,
  },
  examples: ["whatsapp-axi send-file 120363000000000001@g.us ./report.pdf --caption \"The report\"", "whatsapp-axi send-file +15550100001 ./photo.png --as document"],
};

export async function sendFile(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(sendFileSpec, args);
  const [chat, path] = p.pos;
  if (p.flags.as !== undefined && !AS.includes(String(p.flags.as))) throw usage(`--as must be one of ${AS.join(", ")}`);
  const reply = replyID(chat, p.flags.reply);
  const account = chooseAccount(ctx, p.flags.account, "send-file");
  const d = ctx.daemon(account);
  const body: Obj = { chat, path: resolve(path) };
  if (p.flags.caption !== undefined) body.caption = p.flags.caption;
  if (p.flags.as !== undefined) body.as = p.flags.as;
  if (reply) body.reply_to = reply;
  if (p.flags["first-contact"]) body.first_contact = true;
  const res = await d.call("POST", "/v1/send-file", body);
  const media = (res.media ?? {}) as Obj;
  return sentOut(d, res, acctFlag(ctx, account), { type: media.type ?? null, mime: media.mime ?? null });
}

// ---- react -----------------------------------------------------------------

export const reactSpec: CommandSpec = {
  name: "react",
  summary: "React to a kept message, or remove the account's reaction with --remove",
  positionals: [
    { name: "ref", required: true, desc: "<id> or <chat>/<id>" },
    { name: "emoji", required: false, desc: "the emoji (omit with --remove)" },
  ],
  flags: { account: ACCOUNT, remove: { type: "bool", desc: "remove the account's reaction" } },
  examples: ["whatsapp-axi react 3EB0AAAA0000000001 👍", "whatsapp-axi react 120363000000000001@g.us/3EB0AAAA0000000001 --remove"],
};

export async function react(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(reactSpec, args);
  const [ref, emojiArg] = p.pos;
  const remove = p.flags.remove === true;
  if (remove && emojiArg !== undefined) throw usage("give an emoji or --remove, not both");
  if (!remove && !emojiArg) throw usage("<emoji> is required (or --remove)", ["whatsapp-axi react <ref> 👍", "whatsapp-axi react <ref> --remove"]);
  const { chat, id } = splitRef(ref);
  if (!id) throw usage(`${JSON.stringify(ref)} is not a message ref: use <id> or <chat>/<id>`);
  const account = chooseAccount(ctx, p.flags.account, "react");
  const d = ctx.daemon(account);
  const body: Obj = { id, emoji: remove ? "" : emojiArg };
  if (chat) body.chat = chat;
  const res = await d.call("POST", "/v1/react", body);
  expect(d, typeof res.changed === "boolean" && typeof res.chat === "string", "react answer is missing fields");
  const target = `${res.chat as string}/${id}`;
  if (remove) return { reaction: res.changed ? `removed from ${target}` : `none on ${target} (no-op)` };
  return { reaction: res.changed ? `${emojiArg} on ${target}` : `${emojiArg} already on ${target} (no-op)` };
}

// ---- download --------------------------------------------------------------

export const downloadSpec: CommandSpec = {
  name: "download",
  summary: "Fetch a kept message's media and print the local path",
  positionals: [{ name: "ref", required: true, desc: "<id> or <chat>/<id>" }],
  flags: { account: ACCOUNT },
  examples: ["whatsapp-axi download 3EB0AAAA0000000001", "whatsapp-axi download 120363000000000001@g.us/3EB0AAAA0000000001"],
};

export async function download(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(downloadSpec, args);
  const { chat, id } = splitRef(p.pos[0]);
  if (!id) throw usage(`${JSON.stringify(p.pos[0])} is not a message ref: use <id> or <chat>/<id>`);
  const account = chooseAccount(ctx, p.flags.account, "download");
  const d = ctx.daemon(account);
  const body: Obj = { id };
  if (chat) body.chat = chat;
  const res = await d.call("POST", "/v1/download", body);
  expect(d, typeof res.path === "string", "download answer is missing fields");
  return { download: { path: res.path, name: res.name ?? "", mime: res.mime ?? null, size: res.size ?? null, existing: res.existing === true } };
}
