import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { send } from "../src/commands/act.js";
import { defaultCtx } from "../src/context.js";
import { addAccount, apiError, FakeDaemon, makeEnv, run, socketPath, STATUS, type Env } from "./helpers.js";

const GROUP = "120363000000000001@g.us";
let env: Env;
let fake: FakeDaemon;

beforeEach(async () => {
  env = makeEnv();
  addAccount(env, "example");
  fake = new FakeDaemon();
  await fake.listen(socketPath(env, "example"));
});

afterEach(async () => {
  await fake.close();
  await env.cleanup();
});

const SENT = { id: "3EB0F0000000000001", chat: GROUP, t: "2030-01-05T15:00:00Z" };
const body = (path: string) => fake.seen.find((s) => s.path === path)?.body as Record<string, unknown> | undefined;

describe("send", () => {
  it("sends text with a reply, mentions and first contact, and prints the id", async () => {
    fake.route("POST /v1/send", () => ({ body: SENT }));
    const r = await run(["send", GROUP, "On it", "--reply", `${GROUP}/3EB0AAAA0000000001`, "--mention", "+15550100001", "--mention", "100000000000002@lid", "--first-contact"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("id: 3EB0F0000000000001");
    expect(r.out).toContain(`chat: ${GROUP}`);
    expect(body("/v1/send")).toEqual({ chat: GROUP, text: "On it", reply_to: "3EB0AAAA0000000001", mentions: ["+15550100001", "100000000000002@lid"], first_contact: true });
  });

  it("reads the text from standard input with -", async () => {
    fake.route("POST /v1/send", () => ({ body: SENT }));
    const out = (await send(defaultCtx(), [GROUP, "-"], () => "from stdin\n")) as { sent: { id: string } };
    expect(out.sent.id).toBe(SENT.id);
    expect(body("/v1/send")?.text).toBe("from stdin\n");
  });

  it("renders each limit and refusal with its code and fix", async () => {
    const cases: [ReturnType<typeof apiError>, string, string][] = [
      [apiError(409, "first_contact", "Nothing has been received from or sent to 15550100003@s.whatsapp.net."), "first_contact", "--first-contact"],
      [apiError(429, "rate_limited", "The account has reached its limit of sends per minute (send.per_minute).", { retry_after_seconds: 42 }), "rate_limited", "42 seconds"],
      [apiError(429, "duplicate_text", "The same text already went to the most chats allowed in ten minutes."), "duplicate_text", "send.same_text_chats"],
      [apiError(409, "not_connected", "Sending needs a live connection to WhatsApp; the account is suspended.", { state: "suspended" }), "not_connected", "doctor"],
      [apiError(404, "not_found", "No kept message 3EB0X in the chat to reply to."), "not_found", "chats"],
      [apiError(400, "bad_request", "Mention +15550100003 is not in the chat."), "bad_request", "Mention"],
      [apiError(502, "whatsapp_error", "WhatsApp refused or failed this: sending."), "whatsapp_error", "WhatsApp"],
    ];
    for (const [reply, code, help] of cases) {
      fake.route("POST /v1/send", () => reply);
      const r = await run(["send", GROUP, "hello"]);
      expect(r.code, code).toBe(1);
      expect(r.out).toContain(`code: ${code}`);
      expect(r.out).toContain(help);
    }
  });

  it("validates its arguments before calling the daemon", async () => {
    for (const args of [[GROUP], [GROUP, "  "], [GROUP, "x", "--reply", "120363000000000002@g.us/3EB0X"], [GROUP, "x", "--mention"], [GROUP, "x", "--nope"]]) {
      const r = await run(["send", ...args]);
      expect(r.code, args.join(" ")).toBe(2);
    }
    expect(fake.seen.filter((s) => s.path === "/v1/send")).toHaveLength(0);
  });

  it("fails on an answer it cannot read", async () => {
    fake.route("POST /v1/send", () => ({ body: { ok: 1 } }));
    const r = await run(["send", GROUP, "x"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: bad_response");
  });
});

describe("send outcomes", () => {
  it("waits at least the daemon's own send timeout, never a shorter limit of its own", async () => {
    const { Daemon } = await import("../src/client.js");
    const d = new Daemon("example", socketPath(env, "example"));
    expect(d.sendTimeoutMs({ send_timeout_seconds: 600 })).toBeGreaterThanOrEqual(600_000);
    expect(d.sendTimeoutMs({})).toBeGreaterThanOrEqual(600_000);
    expect(d.sendTimeoutMs({ send_timeout_seconds: 1 })).toBeGreaterThanOrEqual(30_000);
  });

  it("is outcome_unknown, with the read-first help, when the client stops waiting or the connection drops", async () => {
    const { Daemon } = await import("../src/client.js");
    fake.route("GET /v1/status", () => ({ body: { ...STATUS, send_timeout_seconds: 0.1 } }));
    for (const reply of [{ hang: true }, { drop: true }]) {
      fake.route("POST /v1/send", () => reply);
      const d = new Daemon("example", socketPath(env, "example"), 50);
      d.sendMarginMs = 0;
      const err = (await d.send("/v1/send", { chat: GROUP, text: "x" }, GROUP).catch((e) => e)) as { code: string; suggestions: string[] };
      expect(err.code, JSON.stringify(reply)).toBe("outcome_unknown");
      expect(err.suggestions[0]).toContain(`whatsapp-axi read ${GROUP}`);
      expect(err.suggestions[0]).toContain("before sending again");
    }
  });

  it("renders the daemon's outcome_unknown and a success with a warning", async () => {
    fake.route("POST /v1/send", () => apiError(504, "outcome_unknown", "Sending: the daemon could not tell whether WhatsApp accepted it; it may have gone out."));
    let r = await run(["send", GROUP, "hello"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: outcome_unknown");
    expect(r.out).toContain(`whatsapp-axi read ${GROUP}`);
    fake.route("POST /v1/send", () => ({ body: { ...SENT, warning: "WhatsApp accepted it, but the daemon could not record it in full." } }));
    r = await run(["send", GROUP, "hello"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("warning:");
    fake.route("POST /v1/react", () => ({ body: { chat: GROUP, id: "3EB0AAAA0000000001", emoji: "👍", changed: true, warning: "not recorded" } }));
    r = await run(["react", `${GROUP}/3EB0AAAA0000000001`, "👍"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("warning: not recorded");
  });
});

describe("send-file", () => {
  it("sends an absolute path with caption, type and reply", async () => {
    fake.route("POST /v1/send-file", () => ({ body: { ...SENT, media: { type: "document", mime: "application/pdf", name: "report.pdf", size: 10 } } }));
    const r = await run(["send-file", GROUP, "report.pdf", "--caption", "The report", "--as", "document", "--reply", "3EB0AAAA0000000001"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("type: document");
    expect(r.out).toContain("mime: application/pdf");
    expect(body("/v1/send-file")).toEqual({ chat: GROUP, path: join(process.cwd(), "report.pdf"), caption: "The report", as: "document", reply_to: "3EB0AAAA0000000001" });
  });

  it("rejects an unknown --as and passes daemon refusals on", async () => {
    let r = await run(["send-file", GROUP, "/tmp/x", "--as", "pdf"]);
    expect(r.code).toBe(2);
    fake.route("POST /v1/send-file", () => apiError(400, "bad_request", "The file is 2000000 bytes, over the limit of 1 MB (send.max_file_mb)."));
    r = await run(["send-file", GROUP, "/tmp/x"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("send.max_file_mb");
  });
});

describe("react", () => {
  it("reacts, says so on a no-op, and removes", async () => {
    fake.route("POST /v1/react", ({ body }) => ({ body: { chat: GROUP, id: "3EB0AAAA0000000001", emoji: (body as { emoji: string }).emoji, changed: true } }));
    let r = await run(["react", "3EB0AAAA0000000001", "👍"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`👍 on ${GROUP}/3EB0AAAA0000000001`);
    expect(body("/v1/react")).toEqual({ id: "3EB0AAAA0000000001", emoji: "👍" });
    fake.route("POST /v1/react", () => ({ body: { chat: GROUP, id: "3EB0AAAA0000000001", emoji: "👍", changed: false } }));
    r = await run(["react", `${GROUP}/3EB0AAAA0000000001`, "👍"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no-op");
    fake.route("POST /v1/react", () => ({ body: { chat: GROUP, id: "3EB0AAAA0000000001", emoji: "", changed: true } }));
    fake.seen = [];
    r = await run(["react", `${GROUP}/3EB0AAAA0000000001`, "--remove"]);
    expect(r.out).toContain("removed from");
    expect(body("/v1/react")).toEqual({ chat: GROUP, id: "3EB0AAAA0000000001", emoji: "" });
  });

  it("needs an emoji or --remove, not both, and passes ambiguity on", async () => {
    expect((await run(["react", "3EB0X"])).code).toBe(2);
    expect((await run(["react", "3EB0X", "👍", "--remove"])).code).toBe(2);
    fake.route("POST /v1/react", () => apiError(409, "ambiguous", "Message id 3EB0X is kept in 2 chats; use <chat>/<id>.", { candidates: [`${GROUP}/3EB0X`, "120363000000000002@g.us/3EB0X"] }));
    const r = await run(["react", "3EB0X", "👍"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: ambiguous");
    expect(r.out).toContain("120363000000000002@g.us/3EB0X");
  });
});

describe("download", () => {
  it("prints the local path", async () => {
    fake.route("POST /v1/download", () => ({ body: { chat: GROUP, id: "3EB0X", path: "/home/u/.local/state/whatsapp-axi/example/media/x.pdf", name: "report.pdf", mime: "application/pdf", size: 9, existing: false } }));
    const r = await run(["download", `${GROUP}/3EB0X`]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("path: /home/u/.local/state/whatsapp-axi/example/media/x.pdf");
    expect(r.out).toContain("name: report.pdf");
    expect(body("/v1/download")).toEqual({ chat: GROUP, id: "3EB0X" });
  });

  it("renders not_downloadable", async () => {
    fake.route("POST /v1/download", () => apiError(422, "not_downloadable", "Message 3EB0X is view-once media, which is never downloaded."));
    const r = await run(["download", "3EB0X"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: not_downloadable");
    expect(r.out).toContain("view-once");
  });

  it("names the start command when the daemon is down", async () => {
    await fake.close();
    for (const args of [["download", "3EB0X"], ["send", GROUP, "x"], ["react", "3EB0X", "👍"], ["send-file", GROUP, "/tmp/x"]]) {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.out).toContain("daemon_not_running");
    }
  });
});

describe("mark-read", () => {
  it("marks one message by ref", async () => {
    fake.route("POST /v1/mark-read", () => ({ body: { chat: GROUP, marked: 1, already_marked: 0, read_receipts: "on-read" } }));
    const r = await run(["mark-read", `${GROUP}/3EB0AAAA0000000001`]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("read: 1");
    expect(body("/v1/mark-read")).toEqual({ chat: GROUP, id: "3EB0AAAA0000000001" });
  });

  it("marks everything kept in a chat through its newest message", async () => {
    fake.route("GET /v1/messages", ({ query }) => {
      expect(query.get("limit")).toBe("1");
      return { body: { chat: { id: GROUP, type: "group", name: "x" }, messages: [{ id: "3EB0AAAA0000000009", from: {} }], more: true } };
    });
    fake.route("POST /v1/mark-read", () => ({ body: { chat: GROUP, marked: 3, already_marked: 2, read_receipts: "on-read" } }));
    const r = await run(["mark-read", "--chat", GROUP]);
    expect(r.code, r.out).toBe(0);
    expect(body("/v1/mark-read")).toEqual({ chat: GROUP, through: "3EB0AAAA0000000009" });
    expect(r.out).toContain("already_marked: 2");
  });

  it("says so for a no-op and for read_receipts off", async () => {
    fake.route("POST /v1/mark-read", () => ({ body: { chat: GROUP, marked: 0, already_marked: 1, read_receipts: "on-read" } }));
    let r = await run(["mark-read", "3EB0AAAA0000000001"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no-op");
    expect(body("/v1/mark-read")).toEqual({ id: "3EB0AAAA0000000001" });
  });

  it("exits 1 with the counts, the reason and the fix when nothing was sent", async () => {
    fake.route("POST /v1/mark-read", () => ({ body: { chat: GROUP, marked: 0, already_marked: 0, failed: 1, reason: "off", read_receipts: "off" } }));
    let r = await run(["mark-read", "3EB0AAAA0000000001"]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("failed: 1");
    expect(r.out).toContain("reason: off");
    expect(r.out).toContain("settings set read_receipts on-read");
    fake.route("POST /v1/mark-read", () => ({ body: { chat: GROUP, marked: 0, already_marked: 0, failed: 1, reason: "not_connected", read_receipts: "on-read" } }));
    r = await run(["mark-read", "3EB0AAAA0000000001"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("doctor");
  });

  it("says how many were sent when a mark is partial", async () => {
    fake.route("POST /v1/mark-read", () => ({ body: { chat: GROUP, marked: 2, already_marked: 1, failed: 3, reason: "whatsapp_error", read_receipts: "on-read" } }));
    const r = await run(["mark-read", `${GROUP}/3EB0AAAA0000000001`]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("2 marked read, 3 not marked");
    expect(r.out).toContain(`whatsapp-axi mark-read ${GROUP}/3EB0AAAA0000000001`);
  });

  it("needs a ref or --chat, not both, and passes errors through", async () => {
    expect((await run(["mark-read"])).code).toBe(2);
    expect((await run(["mark-read", "3EB0AAAA0000000001", "--chat", GROUP])).code).toBe(2);
    fake.route("POST /v1/mark-read", () => apiError(409, "not_connected", "Marking read needs a live connection to WhatsApp; the account is connecting.", { state: "connecting" }));
    const r = await run(["mark-read", "3EB0AAAA0000000001"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: not_connected");
  });
});

describe("typing", () => {
  it("turns typing on and off", async () => {
    fake.route("POST /v1/typing", () => ({ body: { chat: GROUP, typing: true, changed: true } }));
    let r = await run(["typing", GROUP]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("two minutes");
    expect(body("/v1/typing")).toEqual({ chat: GROUP, on: true });
    fake.seen.length = 0;
    fake.route("POST /v1/typing", () => ({ body: { chat: GROUP, typing: false, changed: false } }));
    r = await run(["typing", GROUP, "--stop"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no-op");
    expect(body("/v1/typing")).toEqual({ chat: GROUP, on: false });
  });
});
