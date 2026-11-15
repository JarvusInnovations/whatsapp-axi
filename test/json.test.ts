// --json (specs/cli.md "Conventions"): one JSON document instead of TOON, for every kind of command.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, apiError, FakeDaemon, makeEnv, run, SETTINGS, socketPath, STATUS, type Env } from "./helpers.js";

const GROUP = "120363000000000001@g.us";
const SAM = { id: "100000000000001@lid", pn: "+15550100001", name: "Sam", me: false, operator: true };
const MESSAGE = { id: "3EB0AAAA0000000001", from: SAM, t: "2030-01-05T14:03:11Z", text: "hello", kept_by: "mention", mentions_me: true };
const EVENTS = [
  { seq: 412, kind: "message", t: "2030-01-05T14:03:11Z", chat: { id: GROUP, type: "group", name: "Example group" }, message: MESSAGE },
  { seq: 413, kind: "reaction", t: "2030-01-05T14:04:00Z", chat: { id: GROUP, type: "group", name: "Example group" }, target: MESSAGE.id, from: SAM, emoji: "👍" },
];
const SENT = { id: "3EB0F0000000000001", chat: GROUP, t: "2030-01-05T15:00:00Z" };

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
  env.cleanup();
});

async function json(argv: string[]): Promise<{ doc: Record<string, unknown>; code: number; out: string }> {
  const r = await run(argv);
  const lines = r.out.trim().split("\n");
  expect(lines, r.out).toHaveLength(1);
  return { doc: JSON.parse(lines[0]), code: r.code, out: r.out };
}

describe("--json, commands that call the daemon: the response body unchanged", () => {
  const cases: [string, string[], string, unknown][] = [
    ["chats (list)", ["chats"], "GET /v1/chats", { chats: [{ id: GROUP, name: "Example group", type: "group", scope: "tagged", last_kept: null, discarded: 4, messages: 2 }] }],
    ["groups", ["groups"], "GET /v1/groups", { groups: [{ id: GROUP, name: "Example group", scope: "tagged", override: null, members: 5, discarded: 12 }] }],
    ["chat view (detail)", ["chat", "view", GROUP], "GET /v1/chats/*", { chat: { id: GROUP, name: "Example group", type: "group", scope: "tagged", participants: [SAM] } }],
    ["message view", ["message", "view", `${GROUP}/${MESSAGE.id}`], "GET /v1/messages/*", { chat: { id: GROUP, type: "group", name: "Example group" }, message: MESSAGE }],
    ["events", ["events", "--after", "411"], "GET /v1/events", { events: EVENTS, latest_seq: 413, after: 411 }],
    ["read", ["read", GROUP], "GET /v1/messages", { chat: { id: GROUP, type: "group", name: "Example group" }, messages: [MESSAGE], more: false }],
    ["send (mutation)", ["send", GROUP, "On it"], "POST /v1/send", SENT],
    ["send-file", ["send-file", GROUP, "report.pdf"], "POST /v1/send-file", { ...SENT, media: { type: "document", mime: "application/pdf", name: "report.pdf", size: 10 } }],
    ["react", ["react", `${GROUP}/${MESSAGE.id}`, "👍"], "POST /v1/react", { chat: GROUP, id: MESSAGE.id, emoji: "👍", changed: true }],
    ["mark-read", ["mark-read", `${GROUP}/${MESSAGE.id}`], "POST /v1/mark-read", { chat: GROUP, marked: 1, already_marked: 0, read_receipts: "on-read" }],
    ["typing", ["typing", GROUP], "POST /v1/typing", { chat: GROUP, typing: true, changed: true }],
  ];
  for (const [what, argv, route, body] of cases) {
    it(what, async () => {
      fake.route(route, () => ({ body }));
      const r = await json([...argv, "--json"]);
      expect(r.code, r.out).toBe(0);
      expect(r.doc).toEqual(body);
    });
  }

  it("settings show, scope show and operators list print the settings body", async () => {
    const want = { settings: SETTINGS, effective_retain_days: 90 };
    for (const argv of [["settings", "show"], ["scope", "show"], ["operators", "list"]]) {
      const r = await json([...argv, "--json"]);
      expect(r.code, r.out).toBe(0);
      expect(r.doc).toEqual(want);
    }
  });

  it("--json may come anywhere after the command, but not after --", async () => {
    fake.route("POST /v1/send", ({ body }) => ({ body: { ...SENT, echo: (body as { text: string }).text } }));
    const r = await json(["send", "--json", GROUP, "--", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.doc.echo).toBe("--json");
  });
});

describe("--json, a stream: one object per line as they arrive", () => {
  it("auth link prints each daemon line, and no TOON", async () => {
    const lines = [{ code: "ABCD-EFGH" }, { result: { linked: true, state: "connected", me: { id: "100000000000000@lid", pn: "+15550100000" } } }];
    fake.route("POST /v1/link", () => ({ lines, end: true }));
    const r = await run(["auth", "link", "--phone", "+15550100000", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out.trim().split("\n").map((l) => JSON.parse(l))).toEqual(lines);
  });
});

describe("--json, local commands: the same data as TOON", () => {
  it("accounts", async () => {
    const r = await json(["accounts", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.doc).toHaveProperty("accounts");
    expect(JSON.stringify(r.doc)).toContain("example");
  });

  it("the home view", async () => {
    const r = await json(["--json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.doc).toHaveProperty("accounts");
  });

  it("doctor", async () => {
    const r = await json(["doctor", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(Array.isArray(r.doc.doctor)).toBe(true);
  });

  it("daemon status", async () => {
    const r = await json(["daemon", "status", "example", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.doc).toHaveProperty("service");
  });

  it("--help is a JSON string", async () => {
    const r = await json(["send", "--help", "--json"]);
    expect(r.code).toBe(0);
    expect(r.doc.help).toContain("command: send");
  });
});

describe("--json, failures: {error: {code, message, ...}} with the same exit code", () => {
  it("an error from the daemon, with its extra fields", async () => {
    fake.route("POST /v1/send", () => apiError(429, "rate_limited", "Too many messages.", { retry_after_seconds: 30 }));
    const r = await json(["send", GROUP, "hi", "--json"]);
    expect(r.code).toBe(1);
    expect(Object.keys(r.doc)).toEqual(["error"]);
    expect(r.doc.error).toMatchObject({ code: "rate_limited", message: "Too many messages.", retry_after_seconds: 30 });
    expect((r.doc.error as { help: string[] }).help[0]).toContain("send.per_minute");
  });

  it("the daemon not running", async () => {
    await fake.close();
    const r = await json(["chats", "--json"]);
    expect(r.code).toBe(1);
    expect(r.doc.error).toMatchObject({ code: "daemon_not_running" });
  });

  it("a usage error exits 2", async () => {
    for (const argv of [["chats", "--bogus", "--json"], ["nonsense", "--json"], ["--json", "--limit", "3"]]) {
      const r = await json(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.doc.error).toMatchObject({ code: "usage" });
    }
  });

  it("the daemon's status is checked first: a protocol mismatch is a JSON error", async () => {
    fake.route("GET /v1/status", () => ({ body: { ...STATUS, protocol: 2 } }));
    const r = await json(["chats", "--json"]);
    expect(r.code).toBe(1);
    expect(r.doc.error).toMatchObject({ code: "protocol_mismatch" });
  });
});
