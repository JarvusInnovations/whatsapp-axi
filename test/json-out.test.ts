// --json-out[=path] (specs/cli.md "Conventions"): standard output stays TOON; the daemon's complete
// response body is also written to an owner-only file.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, apiError, FakeDaemon, makeEnv, run, socketPath, type Env } from "./helpers.js";

const GROUP = "120363000000000001@g.us";
const SAM = { id: "100000000000001@lid", pn: "+15550100001", name: "Sam", me: false, operator: true };
const MESSAGE = { id: "3EB0AAAA0000000001", from: SAM, t: "2030-01-05T14:03:11Z", text: "hello", kept_by: "mention", mentions_me: true };
const EVENTS = [
  { seq: 412, kind: "message", t: "2030-01-05T14:03:11Z", chat: { id: GROUP, type: "group", name: "Example group" }, message: MESSAGE },
  {
    seq: 413,
    kind: "reaction",
    t: "2030-01-05T14:04:00Z",
    chat: { id: GROUP, type: "group", name: "Example group" },
    target: MESSAGE.id,
    from: SAM,
    emoji: "👍",
  },
];
const SENT = { id: "3EB0F0000000000001", chat: GROUP, t: "2030-01-05T15:00:00Z" };

let env: Env;
let fake: FakeDaemon;
let dir: string;
let savedTmp: string | undefined;

beforeEach(async () => {
  env = makeEnv();
  addAccount(env, "example");
  fake = new FakeDaemon();
  await fake.listen(socketPath(env, "example"));
  dir = mkdtempSync(join(tmpdir(), "wa-json-out-"));
  savedTmp = process.env.TMPDIR;
});

afterEach(async () => {
  await fake.close();
  await env.cleanup();
  rmSync(dir, { recursive: true, force: true });
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
});

const read = (p: string) => JSON.parse(readFileSync(p, "utf-8"));

describe("--json-out=path writes the daemon's body; stdout stays TOON", () => {
  const cases: [string, string[], string, Record<string, unknown>, string][] = [
    [
      "a list (chats)",
      ["chats"],
      "GET /v1/chats",
      { chats: [{ id: GROUP, name: "Example group", type: "group", scope: "tagged", last_kept: null, discarded: 4, messages: 2 }], total: 1 },
      ".chats[]",
    ],
    [
      "a detail (chat view)",
      ["chat", "view", GROUP],
      "GET /v1/chats/*",
      { chat: { id: GROUP, name: "Example group", type: "group", scope: "tagged", participants: [SAM] } },
      "jq .",
    ],
    ["events", ["events", "--after", "411"], "GET /v1/events", { events: EVENTS, latest_seq: 413, after: 411, total: 2 }, ".events[]"],
    ["a mutation (send)", ["send", GROUP, "On it"], "POST /v1/send", SENT, "jq ."],
  ];
  for (const [what, argv, route, body, hint] of cases) {
    it(what, async () => {
      fake.route(route, () => ({ body }));
      const p = join(dir, "out.json");
      const r = await run([...argv, `--json-out=${p}`]);
      expect(r.code, r.out).toBe(0);
      expect(read(p)).toEqual(body);
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(r.out).not.toMatch(/^\{/m);
      expect(r.out).toContain(`wrote: ${p} (the daemon's response body)`);
      expect(r.out).toContain(hint);
      expect(r.out).toContain(p);
    });
  }

  it("an existing file is replaced, and the output says overwrote", async () => {
    const p = join(dir, "out.json");
    writeFileSync(p, "x".repeat(10000), { mode: 0o644 });
    fake.route("POST /v1/send", () => ({ body: SENT }));
    const r = await run(["send", GROUP, "hi", `--json-out=${p}`]);
    expect(r.code, r.out).toBe(0);
    expect(read(p)).toEqual(SENT);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(r.out).toContain(`overwrote: ${p}`);
  });

  it("names the columns of the file's records", async () => {
    fake.route("GET /v1/chats", () => ({ body: { chats: [{ id: GROUP, name: "x", type: "group", scope: "tagged" }] } }));
    const p = join(dir, "c.json");
    const r = await run(["chats", `--json-out=${p}`]);
    expect(r.out).toContain("columns[4]: id,name,type,scope");
  });
});

describe("a stream appends one object per line", () => {
  it("auth link", async () => {
    const lines = [{ code: "ABCD-EFGH" }, { result: { linked: true, state: "connected", me: { id: "100000000000000@lid", pn: "+15550100000" } } }];
    fake.route("POST /v1/link", () => ({ lines, end: true }));
    const p = join(dir, "link.json");
    const r = await run(["auth", "link", "--phone", "+15550100000", `--json-out=${p}`]);
    expect(r.code, r.out).toBe(0);
    expect(
      readFileSync(p, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ).toEqual(lines);
    expect(r.out).toContain("ABCD-EFGH");
    expect(r.out).toContain(`wrote: ${p} (2 JSON lines)`);
    expect(r.out).toContain(`jq -c . ${p}`);
  });
});

describe("doctor and daemon status write the rows they print", () => {
  it("doctor", async () => {
    const p = join(dir, "doctor.json");
    const r = await run(["doctor", `--json-out=${p}`]);
    expect(r.out).toContain(`wrote: ${p} (the rows printed)`);
    const doc = read(p);
    expect(doc).not.toHaveProperty("help");
    expect(JSON.stringify(doc)).toContain("example");
  });

  it("daemon status", async () => {
    const p = join(dir, "status.json");
    const r = await run(["daemon", "status", "example", "--tz", "America/New_York", `--json-out=${p}`]);
    expect(r.code, r.out).toBe(0);
    expect(read(p)).toHaveProperty("service");
    // The view shows local time; the file keeps the daemon's instant.
    expect(r.out).toContain("2030-01-05T09:00:00-05:00");
    expect(read(p).daemon.since).toBe("2030-01-05T14:00:00Z");
  });

  it("doctor's file keeps the daemon's instants where the view shows local times", async () => {
    const p = join(dir, "doctor.json");
    const r = await run(["doctor", "--tz", "America/New_York", `--json-out=${p}`]);
    expect(r.out).toContain("connected since 2030-01-05T09:00:00-05:00");
    const doc = read(p) as { checks: { check: string; status: string; detail: string }[]; summary: string };
    expect(doc.checks.find((c) => c.check === "state")?.detail).toContain("connected since 2030-01-05T14:00:00Z");
    expect(Object.keys(doc.checks[0])).toEqual(["account", "check", "status", "detail"]);
    expect(typeof doc.summary).toBe("string");
  });

  it("other local commands reject it as unknown", async () => {
    for (const argv of [
      ["accounts", "--json-out"],
      ["daemon", "logs", "example", "--json-out"],
      ["account", "add", "x", "--json-out"],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out).toContain("unknown flag --json-out");
      expect(r.out).toContain("--json-out works on");
    }
  });
});

describe("errors", () => {
  it("a daemon error: the file holds it as sent, stdout the usual error, exit code kept", async () => {
    const extra = { retry_after_seconds: 30 };
    fake.route("POST /v1/send", () => apiError(429, "RATE_LIMITED", "Too many messages.", extra));
    const p = join(dir, "err.json");
    const r = await run(["send", GROUP, "hi", `--json-out=${p}`]);
    expect(r.code).toBe(1);
    expect(read(p)).toEqual({ error: { code: "RATE_LIMITED", message: "Too many messages.", ...extra } });
    expect(r.out).toContain("code: RATE_LIMITED");
    expect(r.out).toContain(`wrote: ${p} (the error)`);
    expect(r.out).toContain(`jq .error ${p}`);
  });

  it("the daemon not running: the file holds the error, exit 1", async () => {
    await fake.close();
    const p = join(dir, "err.json");
    const r = await run(["chats", `--json-out=${p}`]);
    expect(r.code).toBe(1);
    expect(read(p).error).toMatchObject({ code: "DAEMON_NOT_RUNNING" });
    expect(r.out).toContain("code: DAEMON_NOT_RUNNING");
  });

  it("a symlink at the path is refused and nothing is sent", async () => {
    const target = join(dir, "target");
    writeFileSync(target, "keep");
    const p = join(dir, "link.json");
    symlinkSync(target, p);
    let sent = false;
    fake.route("POST /v1/send", () => ((sent = true), { body: SENT }));
    const r = await run(["send", GROUP, "hi", `--json-out=${p}`]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("EXPORT_UNWRITABLE");
    expect(sent).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe("keep");
    expect(lstatSync(p).isSymbolicLink()).toBe(true);
  });

  it("an unwritable path fails before the daemon is called", async () => {
    let sent = false;
    fake.route("POST /v1/send", () => ((sent = true), { body: SENT }));
    const r = await run(["send", GROUP, "hi", `--json-out=${join(dir, "missing", "out.json")}`]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("EXPORT_UNWRITABLE");
    expect(sent).toBe(false);
  });
});

describe("the flag itself", () => {
  it("bare: a 0600 file under <tmp>/whatsapp-axi/", async () => {
    process.env.TMPDIR = dir;
    fake.route("GET /v1/events", () => ({ body: { events: EVENTS, latest_seq: 413, after: 411 } }));
    const r = await run(["events", "--after", "411", "--json-out"]);
    expect(r.code, r.out).toBe(0);
    const m = r.out.match(/wrote: (\S+) /);
    expect(m, r.out).not.toBeNull();
    const p = m![1];
    expect(p.startsWith(join(dir, `whatsapp-axi-${process.getuid?.()}`) + "/")).toBe(true);
    expect(statSync(join(dir, `whatsapp-axi-${process.getuid?.()}`)).mode & 0o777).toBe(0o700);
    expect(p).toMatch(/events.*\.json$/);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(read(p).latest_seq).toBe(413);
  });

  it("--json-out in the space form is always a usage error naming the = form", async () => {
    mkdirSync(join(dir, "x"));
    for (const arg of ["out.json", "out.txt", "x"]) {
      const r = await run(["chats", "--json-out", arg]);
      expect(r.code, arg).toBe(2);
      expect(r.out).toContain(`--json-out=${arg}`);
    }
  });

  it("an automatic directory open to others is refused before anything is done", async () => {
    process.env.TMPDIR = dir;
    const auto = join(dir, `whatsapp-axi-${process.getuid?.()}`);
    mkdirSync(auto, { mode: 0o777 });
    const { chmodSync } = await import("node:fs");
    chmodSync(auto, 0o777);
    let sent = false;
    fake.route("POST /v1/send", () => ((sent = true), { body: SENT }));
    const r = await run(["send", GROUP, "hi", "--json-out"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("EXPORT_UNWRITABLE");
    expect(sent).toBe(false);
  });

  it("a failed write after a successful send keeps the result, says export_error and exits 1", async () => {
    fake.route("POST /v1/send", () => ({ body: SENT }));
    const r = await run(["send", GROUP, "hi", "--json-out=/dev/full"]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("action: sent");
    expect(r.out).toContain("export_error:");
  });

  it("--json is an unknown flag", async () => {
    for (const argv of [
      ["chats", "--json"],
      ["accounts", "--json"],
      ["send", GROUP, "hi", "--json"],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out).toContain("unknown flag --json");
    }
  });
});
