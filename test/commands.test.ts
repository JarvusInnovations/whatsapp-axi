import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, apiError, FakeDaemon, makeEnv, run, socketPath, STATUS, type Env } from "./helpers.js";

const GROUP = "120363000000000001@g.us";
const SAM = { id: "100000000000001@lid", pn: "+15550100001", name: "Sam", me: false, operator: true };
const ALEX = { id: "100000000000002@lid", name: "Alex", me: false, operator: false };

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

const MESSAGE = {
  id: "3EB0AAAA0000000001",
  from: SAM,
  t: "2030-01-05T14:03:11Z",
  text: "@Example can you check this?",
  kept_by: "mention",
  mentions_me: true,
  reply_to: { id: "3EB0AAAA0000000000", from: ALEX, text: "the report is attached", kept: true },
  media: { type: "document", mime: "application/pdf", name: "report.pdf", size: 48213 },
};

describe("chats", () => {
  it("lists four columns by default and more with --fields", async () => {
    fake.route("GET /v1/chats", () => ({
      body: { chats: [{ id: GROUP, name: "Example group", type: "group", scope: "tagged", last_kept: "2030-01-05T14:03:11Z", discarded: 4, messages: 2 }] },
    }));
    let r = await run(["chats"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("chats[1]{id,name,type,scope}:");
    expect(r.out).toContain(`${GROUP},Example group,group,tagged`);
    r = await run(["chats", "--fields", "last_kept,discarded"]);
    expect(r.out).toContain("chats[1]{id,name,type,scope,last_kept,discarded}:");
    r = await run(["chats", "--fields", "nope"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("fields available: last_kept, discarded, messages, override");
  });

  it("says so when empty", async () => {
    fake.route("GET /v1/chats", () => ({ body: { chats: [] } }));
    const r = await run(["chats"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("chats: 0 chats with kept content");
  });

  it("fails, never prints an empty list, on errors and unreadable answers", async () => {
    fake.route("GET /v1/chats", () => apiError(500, "internal", "Internal error in the daemon; see its log."));
    let r = await run(["chats"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: internal");
    expect(r.out).not.toContain("0 chats");
    fake.route("GET /v1/chats", () => ({ raw: "not json" }));
    r = await run(["chats"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: bad_response");
    fake.route("GET /v1/chats", () => ({ body: { chats: "oops" } }));
    r = await run(["chats"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: bad_response");
    fake.route("GET /v1/chats", () => ({ status: 500, raw: "{}" }));
    r = await run(["chats"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: bad_response");
  });

  it("stops on a protocol it does not support, naming both versions and the upgrade", async () => {
    fake.route("GET /v1/status", () => ({ body: { ...STATUS, protocol: 2, daemon_version: "9.0.0" } }));
    const r = await run(["chats"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: protocol_mismatch");
    expect(r.out).toContain("protocol 2");
    expect(r.out).toContain("9.0.0");
    expect(r.out).toContain("npm install -g whatsapp-axi@latest");
  });

  it("sends its version in User-Agent", async () => {
    fake.route("GET /v1/chats", () => ({ body: { chats: [] } }));
    await run(["chats"]);
    expect(fake.seen[0].userAgent).toMatch(/^whatsapp-axi\/\d+\.\d+\.\d+/);
  });
});

describe("chat view", () => {
  it("marks participants", async () => {
    fake.route("GET /v1/chats/*", ({ path }) => {
      expect(decodeURIComponent(path.slice("/v1/chats/".length))).toBe(GROUP);
      return {
        body: {
          chat: {
            id: GROUP, name: "Example group", type: "group", scope: "tagged", last_kept: null, discarded: 1, messages: 1,
            participants: [
              { id: "100000000000000@lid", name: "", me: true, operator: false, contact: false },
              { ...SAM, contact: true },
              { ...ALEX, contact: false },
            ],
          },
        },
      };
    });
    const r = await run(["chat", "view", GROUP]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("participants[3]{id,name,marks}:");
    expect(r.out).toContain("100000000000000@lid,\"\",me");
    expect(r.out).toContain("100000000000001@lid,Sam,operator contact");
    expect(r.out).toContain("100000000000002@lid,Alex,\"-\"");
  });

  it("passes daemon errors through with a help line", async () => {
    fake.route("GET /v1/chats/*", () => apiError(404, "not_found", "No kept chat 120363000000000009@g.us."));
    let r = await run(["chat", "view", "120363000000000009@g.us"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: not_found");
    expect(r.out).toContain("whatsapp-axi chats");
    fake.route("GET /v1/chats/*", () => apiError(409, "not_connected", "The participant list needs a live connection.", { state: "connecting" }));
    r = await run(["chat", "view", GROUP]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: not_connected");
    expect(r.out).toContain("whatsapp-axi doctor");
    fake.route("GET /v1/chats/*", () => apiError(400, "bad_request", "\"x\" is not a chat"));
    r = await run(["chat", "view", "x"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: bad_request");
  });
});

describe("events", () => {
  const events = [
    { seq: 411, t: "2030-01-05T14:00:00Z", kind: "state", account: "example", state: "connected", reason: "" },
    { seq: 412, t: "2030-01-05T14:03:11Z", kind: "message", account: "example", chat: { id: GROUP, type: "group", name: "Example group" }, message: MESSAGE },
    { seq: 413, t: "2030-01-05T14:04:00Z", kind: "reaction", account: "example", chat: { id: GROUP, type: "group", name: "x" }, target: MESSAGE.id, from: ALEX, emoji: "👍" },
  ];

  it("reads after a seq and ends with the highest seq", async () => {
    fake.route("GET /v1/events", ({ query }) => {
      expect(query.get("after")).toBe("410");
      expect(query.get("limit")).toBe("3");
      return { body: { events, latest_seq: 413, after: 410 } };
    });
    const r = await run(["events", "--after", "410", "--limit", "3"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("events[3]{seq,kind,chat,detail}:");
    expect(r.out).toContain("412,message,");
    expect(r.out).toContain("Sam: @Example can you check this?");
    expect(r.out.trim().split("\n").pop()).toBe("last_seq: 413");
  });

  it("without --after says it shows the most recent", async () => {
    fake.route("GET /v1/events", ({ query }) => {
      expect(query.has("after")).toBe(false);
      return { body: { events, latest_seq: 413 } };
    });
    const r = await run(["events"]);
    expect(r.out).toContain("showing the 3 most recent events");
    expect(r.out.trim().split("\n").pop()).toBe("last_seq: 413");
  });

  it("says so in words when there is nothing", async () => {
    fake.route("GET /v1/events", () => ({ body: { events: [], latest_seq: 412, after: 412 } }));
    const r = await run(["events", "--after", "412"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("events: 0 events after seq 412");
    expect(r.out.trim().split("\n").pop()).toBe("last_seq: 412");
  });

  it("passes filters and validates them", async () => {
    fake.route("GET /v1/events", ({ query }) => {
      expect(query.get("chat")).toBe(GROUP);
      expect(query.get("kind")).toBe("message");
      return { body: { events: [events[1]], latest_seq: 413 } };
    });
    let r = await run(["events", "--chat", GROUP, "--kind", "message", "--fields", "id,kept_by"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("{seq,kind,chat,detail,id,kept_by}");
    r = await run(["events", "--kind", "bogus"]);
    expect(r.code).toBe(2);
    r = await run(["events", "--limit", "abc"]);
    expect(r.code).toBe(2);
    r = await run(["events", "--limit", "0"]);
    expect(r.code).toBe(2);
    fake.route("GET /v1/events", () => apiError(404, "not_found", "No kept chat x."));
    r = await run(["events", "--chat", "120363000000000009@g.us"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: not_found");
  });

  it("passes --mark-read and shows how many were marked", async () => {
    fake.route("GET /v1/events", ({ query }) => {
      expect(query.get("mark_read")).toBe("1");
      return { body: { events, latest_seq: 413, after: 410, marked_read: 1 } };
    });
    const r = await run(["events", "--after", "410", "--mark-read"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("marked_read: 1");
    expect(r.out.trim().split("\n").pop()).toBe("last_seq: 413");
    fake.route("GET /v1/messages", ({ query }) => {
      expect(query.get("mark_read")).toBe("1");
      return { body: { chat: { id: GROUP, type: "group", name: "x" }, messages: [MESSAGE], more: false, marked_read: 1 } };
    });
    const r2 = await run(["read", GROUP, "--mark-read"]);
    expect(r2.code).toBe(0);
    expect(r2.out).toContain("marked_read: 1");
  });

  it("without --mark-read asks for no marking", async () => {
    fake.route("GET /v1/events", ({ query }) => {
      expect(query.has("mark_read")).toBe(false);
      return { body: { events, latest_seq: 413 } };
    });
    expect((await run(["events"])).code).toBe(0);
  });

  it("follows a stream, line by line", async () => {
    fake.route("GET /v1/events", ({ query }) => {
      expect(query.get("follow")).toBe("1");
      return { lines: events };
    });
    const ac = new AbortController();
    const { events: eventsCmd } = await import("../src/commands/read.js");
    const { defaultCtx } = await import("../src/context.js");
    const lines: string[] = [];
    const done = eventsCmd(defaultCtx(), ["--after", "410", "--follow"], (s) => {
      lines.push(s);
      if (lines.length === 3) ac.abort();
    }, ac.signal);
    const result = (await done) as { last_seq: number };
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("412,message");
    expect(result.last_seq).toBe(413);
  });
});

describe("groups", () => {
  const GROUPS = [
    { id: GROUP, name: "Example group", scope: "tagged", members: 5, discarded: 12 },
    { id: "120363000000000002@g.us", name: "Quiet group", scope: "none", override: "none", members: 3, discarded: 0 },
  ];

  it("lists every group with four columns, discard count on --fields", async () => {
    fake.route("GET /v1/groups", () => ({ body: { groups: GROUPS } }));
    let r = await run(["groups"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("groups[2]{id,name,scope,members}:");
    expect(r.out).toContain("Quiet group,none,3");
    r = await run(["groups", "--fields", "discarded"]);
    expect(r.out).toContain("groups[2]{id,name,scope,members,discarded}:");
    expect(r.out).toContain("tagged,5,12");
  });

  it("says so when there are none, and passes not_connected through", async () => {
    fake.route("GET /v1/groups", () => ({ body: { groups: [] } }));
    let r = await run(["groups"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("0 groups");
    fake.route("GET /v1/groups", () => apiError(409, "not_connected", "Listing groups needs a live connection to WhatsApp; the account is connecting.", { state: "connecting" }));
    r = await run(["groups"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: not_connected");
  });
});

describe("read and message view", () => {
  it("reads a chat oldest first", async () => {
    fake.route("GET /v1/messages", ({ query }) => {
      expect(query.get("chat")).toBe(GROUP);
      return { body: { chat: { id: GROUP, type: "group", name: "x" }, messages: [MESSAGE, { ...MESSAGE, id: "3EB0AAAA0000000002", text: "", deleted: true }], more: true } };
    });
    const r = await run(["read", GROUP]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("messages[2]{id,t,from,text}:");
    expect(r.out).toContain("[deleted]");
    expect(r.out).toContain(`--before ${MESSAGE.id}`);
  });

  it("says so when a chat has nothing", async () => {
    fake.route("GET /v1/messages", () => ({ body: { chat: { id: GROUP, type: "group", name: "x" }, messages: [], more: false } }));
    const r = await run(["read", GROUP]);
    expect(r.out).toContain(`0 kept messages in ${GROUP}`);
  });

  it("passes not_found through", async () => {
    fake.route("GET /v1/messages", () => apiError(404, "not_found", "No kept chat x."));
    const r = await run(["read", "120363000000000009@g.us"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: not_found");
  });

  it("views one message with reply context and descriptor, truncating long text", async () => {
    const long = "x".repeat(2000);
    fake.route("GET /v1/messages/*", ({ path }) => {
      expect(path).toBe(`/v1/messages/${encodeURIComponent(GROUP)}/${MESSAGE.id}`);
      return { body: { chat: { id: GROUP, type: "group", name: "x" }, message: { ...MESSAGE, text: long } } };
    });
    let r = await run(["message", "view", `${GROUP}/${MESSAGE.id}`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("truncated, 2000 chars total");
    expect(r.out).toContain("--full");
    expect(r.out).toContain("report.pdf");
    expect(r.out).toContain("kept: true");
    r = await run(["message", "view", `${GROUP}/${MESSAGE.id}`, "--full"]);
    expect(r.out).toContain(long);
    expect(r.out).not.toContain("truncated");
  });

  it("takes a bare id and passes ambiguous through with the candidates", async () => {
    fake.route("GET /v1/messages/*", ({ path }) => {
      expect(path).toBe(`/v1/messages/${MESSAGE.id}`);
      return apiError(409, "ambiguous", "Message id is kept in 2 chats.", { candidates: [`${GROUP}/${MESSAGE.id}`, `120363000000000002@g.us/${MESSAGE.id}`] });
    });
    const r = await run(["message", "view", MESSAGE.id]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: ambiguous");
    expect(r.out).toContain(`120363000000000002@g.us/${MESSAGE.id}`);
  });

  it("prints only what the daemon returned, never key material", async () => {
    const leaky = { ...MESSAGE, media: { ...MESSAGE.media, media_key: "SECRETKEYMATERIAL", direct_path: "/v/SECRETPATH" }, keys: "SECRETKEYMATERIAL" };
    fake.route("GET /v1/messages/*", () => ({ body: { chat: { id: GROUP, type: "group", name: "x" }, message: leaky } }));
    fake.route("GET /v1/messages", () => ({ body: { chat: { id: GROUP, type: "group", name: "x" }, messages: [leaky], more: false } }));
    fake.route("GET /v1/events", () => ({ body: { events: [{ seq: 1, kind: "message", t: "x", chat: { id: GROUP }, message: leaky }], latest_seq: 1 } }));
    for (const argv of [["message", "view", MESSAGE.id], ["read", GROUP, "--fields", "media,reply_to"], ["events", "--fields", "t,id,from,kept_by,mentions_me"]]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("SECRET");
    }
  });
});

describe("forget", () => {
  it("needs --confirm", async () => {
    const r = await run(["forget", GROUP]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--confirm");
    expect(fake.seen.find((s) => s.path === "/v1/forget")).toBeUndefined();
  });

  it("forgets a chat or one message, after the daemon confirms", async () => {
    fake.route("POST /v1/forget", ({ body }) => {
      const b = body as { chat: string; id?: string };
      return { body: { forgotten: { chat: b.chat, ...(b.id ? { message: b.id } : {}), messages: b.id ? 1 : 5, events: 2 } } };
    });
    let r = await run(["forget", GROUP, "--confirm"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("messages: 5");
    r = await run(["forget", GROUP, "--message", `${GROUP}/${MESSAGE.id}`, "--confirm"]);
    expect(r.out).toContain(`message: ${MESSAGE.id}`);
    expect(fake.seen.at(-1)?.body).toEqual({ chat: GROUP, id: MESSAGE.id });
  });

  it("passes not_found and ambiguous through", async () => {
    fake.route("POST /v1/forget", () => apiError(404, "not_found", "No kept message."));
    let r = await run(["forget", GROUP, "--message", "NOPE", "--confirm"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: not_found");
    fake.route("POST /v1/forget", () => apiError(409, "ambiguous", "Ambiguous.", { candidates: ["a/b"] }));
    r = await run(["forget", GROUP, "--message", "b", "--confirm"]);
    expect(r.out).toContain("code: ambiguous");
  });

  it("refuses a message ref from another chat", async () => {
    const r = await run(["forget", GROUP, "--message", "120363000000000002@g.us/X", "--confirm"]);
    expect(r.code).toBe(2);
  });

  it("does not report success when the daemon's answer is unreadable", async () => {
    fake.route("POST /v1/forget", () => ({ body: { ok: true } }));
    const r = await run(["forget", GROUP, "--confirm"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bad_response");
  });
});

describe("scope, operators and settings", () => {
  it("shows the scope and overrides", async () => {
    fake.settings.chats = { [GROUP]: "none" } as never;
    const r = await run(["scope", "show"]);
    expect(r.out).toContain("scope: tagged");
    expect(r.out).toContain(`${GROUP},none`);
  });

  it("sets the scope; full needs --confirm; a repeat is a no-op", async () => {
    let r = await run(["scope", "set", "full"]);
    expect(r.code).toBe(2);
    r = await run(["scope", "set", "full", "--confirm"]);
    expect(r.out).toContain("scope: full (set)");
    r = await run(["scope", "set", "full", "--confirm"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already set, no-op");
    r = await run(["scope", "set", "everything"]);
    expect(r.code).toBe(2);
  });

  it("sets and clears a chat override", async () => {
    let r = await run(["scope", "set", "--chat", GROUP, "none"]);
    expect(r.out).toContain("none (set)");
    expect(fake.seen.at(-1)?.body).toEqual({ chats: { [GROUP]: "none" } });
    r = await run(["scope", "set", "--chat", GROUP, "default"]);
    expect(fake.seen.at(-1)?.body).toEqual({ chats: { [GROUP]: null } });
    expect(r.out).toContain("default (no override) (set)");
    r = await run(["scope", "set", "--chat", GROUP, "dm-only"]);
    expect(r.code).toBe(2);
  });

  it("sets dm-from", async () => {
    const r = await run(["scope", "dm-from", "anyone"]);
    expect(r.out).toContain("dm_from: anyone (set)");
    expect((await run(["scope", "dm-from", "everyone"])).code).toBe(2);
  });

  it("adds and removes operators idempotently", async () => {
    let r = await run(["operators", "list"]);
    expect(r.out).toContain("operators: 0 operators");
    r = await run(["operators", "add", "+15550100001"]);
    expect(r.out).toContain("+15550100001 added");
    r = await run(["operators", "add", "+15550100001"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already an operator (no-op)");
    r = await run(["operators", "list"]);
    expect(r.out).toContain("+15550100001");
    r = await run(["operators", "remove", "+15550100001"]);
    expect(r.out).toContain("removed");
    r = await run(["operators", "remove", "+15550100001"]);
    expect(r.out).toContain("is not an operator (no-op)");
    r = await run(["operators", "add", "15550100001"]);
    expect(r.code).toBe(2);
  });

  it("shows and sets settings", async () => {
    let r = await run(["settings", "show"]);
    expect(r.out).toContain("retain_days: 90 (default)");
    r = await run(["settings", "set", "retain_days", "30"]);
    expect(r.out).toContain("retain_days: 30 (set)");
    expect(fake.seen.at(-1)?.body).toEqual({ retain_days: 30 });
    r = await run(["settings", "set", "send.per_hour", "20"]);
    expect(fake.seen.at(-1)?.body).toEqual({ send: { per_hour: 20 } });
    r = await run(["settings", "set", "wake_file", "none"]);
    expect(fake.seen.at(-1)?.body).toEqual({ wake_file: null });
    for (const bad of [["retain_days", "x"], ["presence", "yes"], ["wake_file", "rel/path"], ["scope", "full"], ["colour", "blue"]]) {
      r = await run(["settings", "set", ...bad]);
      expect(r.code, bad.join(" ")).toBe(2);
    }
  });

  it("passes a rejected change through and does not report success", async () => {
    fake.route("PATCH /v1/settings", () => apiError(400, "bad_request", "settings: send.per_hour: must be a whole number from 1 to 100000"));
    let r = await run(["settings", "set", "send.per_hour", "1000000"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: bad_request");
    expect(r.out).not.toContain("(set)");
    fake.route("PATCH /v1/settings", () => ({ body: { settings: fake.settings, effective_retain_days: 90 } }));
    r = await run(["scope", "set", "tagged"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bad_response");
  });
});

describe("accounts and the home view", () => {
  it("lists accounts with state and scope; a stopped daemon is a state", async () => {
    addAccount(env, "other");
    let r = await run(["accounts"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("accounts[2]{name,state,scope}:");
    expect(r.out).toContain("example,connected,tagged");
    expect(r.out).toContain("other,stopped,null");
    expect(r.out).toContain("whatsapp-axi daemon start other");
    r = await run(["accounts", "--fields", "phone"]);
    expect(r.out).toContain("{name,state,scope,phone}");
    expect(r.out).toContain("+15550100000");
    r = await run([]);
    expect(r.out).toContain("bin:");
    expect(r.out).toContain("description:");
    expect(r.out).toContain("example,connected,tagged");
  });

  it("fails rather than guessing when a running daemon answers badly", async () => {
    fake.route("GET /v1/settings", () => ({ raw: "garbage" }));
    const r = await run(["accounts"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bad_response");
  });

  it("says so when there are no accounts", async () => {
    env.cleanup();
    env = makeEnv();
    let r = await run([]);
    expect(r.out).toContain("0 accounts");
    expect(r.out).toContain("account add");
    r = await run(["accounts"]);
    expect(r.out).toContain("0 accounts");
    r = await run(["chats"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: no_account");
  });
});

describe("doctor", () => {
  it("reports ok checks and warnings", async () => {
    const wake = join(env.home, "wake");
    fake.settings.wake_file = wake;
    const r = await run(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("example,files,ok");
    expect(r.out).toContain("example,daemon,ok");
    expect(r.out).toContain("example,state,ok");
    expect(r.out).toContain("example,phone,ok");
    expect(r.out).toContain("approximate");
    expect(r.out).toContain("example,wake_file,ok");
  });

  it("names the fix for a stopped daemon, loose modes and a stale phone", async () => {
    addAccount(env, "other");
    chmodSync(join(env.home, "config", "whatsapp-axi", "other", "settings.json"), 0o644);
    fake.route("GET /v1/status", () => ({ body: { ...STATUS, state: "logged_out", reason: "removed on the phone", last_phone_activity: "2020-01-01T00:00:00Z" } }));
    const r = await run(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("other,daemon,fail,not running");
    expect(r.out).toContain("whatsapp-axi daemon start other");
    expect(r.out).toContain("chmod 600");
    expect(r.out).toContain("example,state,fail");
    expect(r.out).toContain("example,phone,warn");
  });

  it("checks one account, and an unknown one fails", async () => {
    let r = await run(["doctor", "--account", "example"]);
    expect(r.code).toBe(0);
    r = await run(["doctor", "--account", "nobody"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no such account");
  });
});

describe("account add, account remove and daemon run", () => {
  function fakeBinary(script: string): void {
    const p = join(env.home, "whatsapp-axid");
    writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.WHATSAPP_AXI_DAEMON = p;
  }

  it("adds an account by running the daemon's init; existing is a no-op", async () => {
    const cfg = join(env.home, "config", "whatsapp-axi");
    fakeBinary(`[ "$1" = init ] && [ "$2" = --account ] && mkdir -p "${cfg}/$3" && echo '{}' > "${cfg}/$3/settings.json" && exit 0; exit 9`);
    let r = await run(["account", "add", "fresh"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("created: true");
    r = await run(["account", "add", "fresh"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already exists (no-op)");
    r = await run(["account", "add", "Not-Valid"]);
    expect(r.code).toBe(2);
    fakeBinary(`echo "whatsapp-axid init: disk full" >&2; exit 1`);
    r = await run(["account", "add", "broken"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("disk full");
  });

  it("removes an account only with the name repeated, and refuses while its daemon runs", async () => {
    let r = await run(["account", "remove", "example"]);
    expect(r.code).toBe(2);
    r = await run(["account", "remove", "example", "--confirm", "other"]);
    expect(r.code).toBe(2);
    fakeBinary(`echo 'whatsapp-axid remove: account "example": its daemon is running; stop it first: already running' >&2; exit 1`);
    r = await run(["account", "remove", "example", "--confirm", "example"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: daemon_running");
    fakeBinary(`[ "$1" = remove ] && exit 0; exit 9`);
    r = await run(["account", "remove", "example", "--confirm", "example"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("removed: true");
    r = await run(["account", "remove", "nobody", "--confirm", "nobody"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("does not exist (no-op)");
  });

  it("runs the daemon in the foreground and passes its failure on", async () => {
    fakeBinary(`[ "$1" = run ] && [ "$3" = example ] && exit 0; exit 3`);
    let r = await run(["daemon", "run", "example"]);
    expect(r.code).toBe(0);
    fakeBinary(`echo "whatsapp-axid run: already running" >&2; exit 1`);
    r = await run(["daemon", "run", "example"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: daemon_exited");
    r = await run(["daemon", "run", "nobody"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no_account");
    r = await run(["daemon", "run", "example", "--log-level", "loud"]);
    expect(r.code).toBe(2);
  });

  it("names the missing platform package when no binary is found", async () => {
    process.env.WHATSAPP_AXI_DAEMON = join(env.home, "missing");
    const r = await run(["account", "add", "fresh"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("daemon_binary_missing");
  });
});
