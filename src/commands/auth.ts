// auth link and auth logout (specs/cli.md "Accounts and linking", specs/daemon.md "Linking").
// The daemon runs the link; the CLI prints each pairing code or QR code as it arrives, then the
// result.
import QRCode from "qrcode";
import { AxiError } from "axi-sdk-js";
import { contradiction, parse, type CommandSpec } from "../flags.js";
import { expect } from "../client.js";
import { confirmRequired, failure, invalid, knownCode, usage, type Code } from "../errors.js";
import { account, acctFlag, type Ctx } from "../context.js";
import { line } from "../output/toon.js";

type Obj = Record<string, unknown>;
const PHONE_RE = /^\+[1-9][0-9]{6,14}$/;

export const authLinkSpec: CommandSpec = {
  name: "auth link",
  summary: "Link the account to WhatsApp: by pairing code for --phone, or by QR code with --qr",
  positionals: [],
  flags: {
    phone: { type: "string", value: "<number>", desc: "the account's phone number in E.164 form (+15550100001); prints an 8-character pairing code" },
    qr: { type: "bool", desc: "link by QR code instead: prints each QR code and its raw string" },
  },
  examples: ["whatsapp-axi auth link --phone +15550100001", "whatsapp-axi auth link --qr --account example"],
  mutation: true,
  jsonOut: true,
};

export const WHERE_TO_TYPE =
  "On the account's phone: WhatsApp > Linked devices > Link a device > Link with phone number instead, then type the code";
const WHERE_TO_SCAN = "On the account's phone: WhatsApp > Linked devices > Link a device, then scan the code";

/** Renders a QR payload for a terminal. */
export async function renderQR(payload: string): Promise<string> {
  return QRCode.toString(payload, { type: "utf8", errorCorrectionLevel: "L" });
}

function linkFailure(account: string, af: string, err: Obj, phone: string | undefined): AxiError {
  const raw = typeof err.code === "string" ? err.code : "LINK_FAILED";
  const code = (knownCode(raw) ? raw : "LINK_FAILED") as Code;
  const message = typeof err.message === "string" ? err.message : "The link attempt failed.";
  const again = phone ? `whatsapp-axi auth link --phone ${phone}${af}` : `whatsapp-axi auth link --qr${af}`;
  switch (code) {
    case "WRONG_NUMBER":
      return failure(message, code, [`Run \`whatsapp-axi auth link --phone <number>${af}\` with the number of the phone you are linking from`]);
    case "LINK_TIMEOUT":
    case "LINK_CANCELLED":
      return failure(message, code, [`Run \`${again}\` and complete it on the phone within about three minutes`]);
    case "CLIENT_OUTDATED":
      return failure(message, code, ["WhatsApp rejected this client as too old: only a release built on a newer library fixes this", `Run \`whatsapp-axi doctor${af}\` to see the versions`]);
    default:
      return failure(message, code, [`Run \`whatsapp-axi doctor${af}\` to check the account`, `Run \`${again}\` to try again`]);
  }
}

export async function authLink(ctx: Ctx, args: string[], write: (s: string) => void, signal?: AbortSignal): Promise<unknown> {
  const p = parse(authLinkSpec, args);
  const phone = p.flags.phone as string | undefined;
  const qr = p.flags.qr === true;
  if (phone !== undefined && qr) throw contradiction("--phone", "--qr");
  if (phone === undefined && !qr) throw usage("`auth link` needs --phone <number> (pairing code) or --qr", ["usage: whatsapp-axi auth link --phone <number>", "usage: whatsapp-axi auth link --qr"]);
  if (phone !== undefined && !PHONE_RE.test(phone)) throw invalid(`--phone must be a phone number in E.164 form like +15550100001, got ${JSON.stringify(phone)}`);
  const name = account(ctx);
  const af = acctFlag(ctx, name);
  const d = ctx.daemon(name);
  let shown = false;
  for await (const l of d.stream("/v1/link", signal, { method: "POST", body: phone ? { phone } : { qr: true }, endOk: true })) {
    if (typeof l.code === "string") {
      write(line({ code: l.code, help: [WHERE_TO_TYPE, "Waiting for the phone..."] }));
      shown = true;
    } else if (typeof l.qr === "string") {
      write(`${line({ qr: l.qr })}${await renderQR(l.qr)}\n`);
      if (!shown) write(line({ help: [WHERE_TO_SCAN, "Each code is replaced by the next until the window closes"] }));
      shown = true;
    } else if (l.result && typeof l.result === "object") {
      const r = l.result as Obj;
      if (r.linked === true) {
        const me = (r.me ?? {}) as Obj;
        return {
          action: "linked",
          state: r.state,
          ...(typeof me.pn === "string" ? { phone: me.pn } : {}),
          help: [`Run \`whatsapp-axi doctor${af}\` to check the account`, `Run \`whatsapp-axi scope show${af}\` to see what it keeps`],
        };
      }
      expect(d, r.error && typeof r.error === "object", "link result without an error");
      throw linkFailure(name, af, r.error as Obj, phone);
    } else {
      expect(d, false, "unknown link line");
    }
  }
  const again = phone ? `whatsapp-axi auth link --phone ${phone}${af}` : `whatsapp-axi auth link --qr${af}`;
  if (signal?.aborted) {
    // Interrupted (SIGINT or SIGTERM): the account is not linked, so this is not a success.
    throw failure("The link was interrupted before the phone completed it; the daemon abandons the attempt and the account is not linked.", "LINK_INTERRUPTED", [`Run \`${again}\` to try again`]);
  }
  throw failure(`The daemon of account ${name} ended the link stream without a result.`, "STREAM_CLOSED", [`Run \`whatsapp-axi doctor${af}\` to check the daemon`]);
}

export const authLogoutSpec: CommandSpec = {
  name: "auth logout",
  summary: "Unlink this device from WhatsApp and delete the session (kept messages stay)",
  positionals: [],
  flags: { confirm: { type: "bool", desc: "required: confirms the unlink" } },
  examples: ["whatsapp-axi auth logout --confirm", "whatsapp-axi auth logout --confirm --account example"],
  mutation: true,
  jsonOut: true,
};

export async function authLogout(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(authLogoutSpec, args);
  const name = account(ctx);
  const af = acctFlag(ctx, name);
  if (p.flags.confirm !== true) {
    throw confirmRequired("`auth logout` unlinks the device and deletes the session; add --confirm", [`Run \`whatsapp-axi auth logout --confirm${af}\` to unlink it`]);
  }
  const d = ctx.daemon(name);
  try {
    const res = await d.call("POST", "/v1/logout", {});
    expect(d, res.logged_out === true, "logout answer is missing fields");
  } catch (err) {
    if (err instanceof AxiError && err.code === "NOT_LINKED") {
      return { action: "unchanged", reason: "already unlinked (no-op)", help: [`Run \`whatsapp-axi auth link --phone <number>${af}\` to link it`] };
    }
    throw err;
  }
  return { action: "unlinked", state: "unlinked", note: "kept messages are left in place; `forget` deletes them", help: [`Run \`whatsapp-axi auth link --phone <number>${af}\` to link again`] };
}
