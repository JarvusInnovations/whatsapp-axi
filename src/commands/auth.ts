// auth link and auth logout (specs/cli.md "Accounts and linking", specs/daemon.md "Linking").
// The daemon runs the link; the CLI prints each pairing code or QR code as it arrives, then the
// result.
import { encode } from "@toon-format/toon";
import QRCode from "qrcode";
import { AxiError } from "axi-sdk-js";
import { parse, type CommandSpec } from "../args.js";
import { expect } from "../client.js";
import { failure, usage } from "../errors.js";
import { chooseAccount, type Ctx } from "../context.js";
import { acctFlag } from "./read.js";
import { output } from "../output.js";

type Obj = Record<string, unknown>;
const ACCOUNT = { type: "string" as const, value: "<name>", desc: "the account (required when there are several)" };
const PHONE_RE = /^\+[1-9][0-9]{6,14}$/;

export const authLinkSpec: CommandSpec = {
  name: "auth link",
  summary: "Link the account to WhatsApp: by pairing code for --phone, or by QR code with --qr",
  positionals: [],
  flags: {
    account: ACCOUNT,
    phone: { type: "string", value: "<number>", desc: "the account's phone number in E.164 form (+15550100001); prints an 8-character pairing code" },
    qr: { type: "bool", desc: "link by QR code instead: prints each QR code and its raw string" },
  },
  examples: ["whatsapp-axi auth link --phone +15550100001", "whatsapp-axi auth link --qr --account example"],
};

export const WHERE_TO_TYPE =
  "On the account's phone: WhatsApp > Linked devices > Link a device > Link with phone number instead, then type the code";
const WHERE_TO_SCAN = "On the account's phone: WhatsApp > Linked devices > Link a device, then scan the code";

/** Renders a QR payload for a terminal. */
export async function renderQR(payload: string): Promise<string> {
  return QRCode.toString(payload, { type: "utf8", errorCorrectionLevel: "L" });
}

function linkFailure(account: string, af: string, err: Obj, phone: string | undefined): AxiError {
  const code = typeof err.code === "string" ? err.code : "link_failed";
  const message = typeof err.message === "string" ? err.message : "The link attempt failed.";
  const again = phone ? `whatsapp-axi auth link --phone ${phone}${af}` : `whatsapp-axi auth link --qr${af}`;
  switch (code) {
    case "wrong_number":
      return failure(message, code, ["Run the link with the phone number of the phone you are linking from"]);
    case "link_timeout":
    case "link_cancelled":
      return failure(message, code, [`Run \`${again}\` and complete it on the phone within about three minutes`]);
    case "outdated":
      return failure(message, code, ["Upgrade: npm install -g whatsapp-axi@latest, then run `whatsapp-axi daemon upgrade`"]);
    default:
      return failure(message, code, [`Run \`whatsapp-axi doctor --account ${account}\``, `Then \`${again}\``]);
  }
}

export async function authLink(ctx: Ctx, args: string[], write: (s: string) => void, signal?: AbortSignal): Promise<unknown> {
  const p = parse(authLinkSpec, args);
  const phone = p.flags.phone as string | undefined;
  const qr = p.flags.qr === true;
  if (phone !== undefined && qr) throw usage("give --phone or --qr, not both", ["whatsapp-axi auth link --phone <number>", "whatsapp-axi auth link --qr"]);
  if (phone === undefined && !qr) throw usage("`auth link` needs --phone <number> (pairing code) or --qr", ["whatsapp-axi auth link --phone +15550100001", "whatsapp-axi auth link --qr"]);
  if (phone !== undefined && !PHONE_RE.test(phone)) throw usage(`--phone must be a phone number in E.164 form like +15550100001, got ${JSON.stringify(phone)}`);
  const account = chooseAccount(ctx, p.flags.account, "auth link");
  const af = acctFlag(ctx, account);
  const d = ctx.daemon(account);
  let shown = false;
  for await (const line of d.stream("/v1/link", signal, { method: "POST", body: phone ? { phone } : { qr: true }, endOk: true })) {
    if (output.json) write(`${JSON.stringify(line)}\n`);
    if (output.json && line.result === undefined) {
      shown = true;
    } else if (typeof line.code === "string") {
      write(`${encode({ code: line.code, help: [WHERE_TO_TYPE, "Waiting for the phone..."] })}\n`);
      shown = true;
    } else if (typeof line.qr === "string") {
      write(`${encode({ qr: line.qr })}\n${await renderQR(line.qr)}\n`);
      if (!shown) write(`${encode({ help: [WHERE_TO_SCAN, "Each code is replaced by the next until the window closes"] })}\n`);
      shown = true;
    } else if (line.result && typeof line.result === "object") {
      const r = line.result as Obj;
      if (r.linked === true) {
        const me = (r.me ?? {}) as Obj;
        return {
          linked: true,
          state: r.state,
          phone: me.pn ?? null,
          help: [`Run \`whatsapp-axi doctor${af}\` to check the account`, `Run \`whatsapp-axi scope show${af}\` to see what it keeps`],
        };
      }
      expect(d, r.error && typeof r.error === "object", "link result without an error");
      throw linkFailure(account, af, r.error as Obj, phone);
    } else {
      expect(d, false, "unknown link line");
    }
  }
  if (signal?.aborted) {
    return { linked: false, note: "stopped; the daemon abandons the attempt" };
  }
  throw failure(`The daemon of account ${account} ended the link stream without a result.`, "stream_closed", [`Run \`whatsapp-axi doctor --account ${account}\``]);
}

export const authLogoutSpec: CommandSpec = {
  name: "auth logout",
  summary: "Unlink this device from WhatsApp and delete the session (kept messages stay)",
  positionals: [],
  flags: { account: ACCOUNT, confirm: { type: "bool", desc: "required: confirms the unlink" } },
  examples: ["whatsapp-axi auth logout --confirm", "whatsapp-axi auth logout --confirm --account example"],
};

export async function authLogout(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(authLogoutSpec, args);
  if (p.flags.confirm !== true) throw usage("`auth logout` unlinks the device and deletes the session; add --confirm", ["whatsapp-axi auth logout --confirm"]);
  const account = chooseAccount(ctx, p.flags.account, "auth logout");
  const af = acctFlag(ctx, account);
  const d = ctx.daemon(account);
  try {
    const res = await d.call("POST", "/v1/logout", {});
    expect(d, res.logged_out === true, "logout answer is missing fields");
  } catch (err) {
    if (err instanceof AxiError && err.code === "not_linked") {
      return { logged_out: "already unlinked (no-op)", help: [`Run \`whatsapp-axi auth link --phone <number>${af}\` to link it`] };
    }
    throw err;
  }
  return { logged_out: true, state: "unlinked", note: "kept messages are left in place; `forget` deletes them", help: [`Run \`whatsapp-axi auth link --phone <number>${af}\` to link again`] };
}
