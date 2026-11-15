// End to end on one machine with the real daemon from daemon-core, and no WhatsApp: account add,
// daemon run, scope set, operators add, events. Needs the built daemon (daemon/bin/whatsapp-axid)
// and the built CLI (dist/); CI builds both first, and there the test is required to run.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeEnv, run, socketPath, type Env } from "./helpers.js";

const root = join(import.meta.dirname, "..");
const daemonBin = join(root, "daemon", "bin", "whatsapp-axid");
const cliBin = join(root, "dist", "bin", "whatsapp-axi.js");
const ready = existsSync(daemonBin) && existsSync(cliBin);

if (process.env.CI && !ready) throw new Error("CI must build the daemon and the CLI before the end-to-end test");

async function waitFor(cond: () => boolean, ms = 15000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!ready)("end to end with the real daemon", () => {
  let env: Env;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => child?.once("close", r));
    }
    env.cleanup();
  });

  it("account add, daemon run, scope set, operators add, events", async () => {
    let r = await run(["account", "add", "demo"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("created: true");

    let out = "";
    child = spawn(process.execPath, [cliBin, "daemon", "run", "demo"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    const sock = socketPath(env, "demo");
    await waitFor(() => existsSync(sock));

    r = await run([]);
    expect(r.out).toContain("demo,unlinked,tagged");

    r = await run(["scope", "set", "dm-only"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("scope: dm-only (set)");
    r = await run(["scope", "set", "dm-only"]);
    expect(r.out).toContain("no-op");
    r = await run(["scope", "set", "--chat", "120363000000000001@g.us", "tagged"]);
    expect(r.code, r.out).toBe(0);

    r = await run(["operators", "add", "+15550100001"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("added");
    r = await run(["operators", "list"]);
    expect(r.out).toContain("+15550100001");

    r = await run(["scope", "show"]);
    expect(r.out).toContain("scope: dm-only");
    expect(r.out).toContain("120363000000000001@g.us,tagged");

    r = await run(["events", "--after", "0"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("1,state,null,unlinked (no session)");
    expect(r.out.trim().split("\n").pop()).toBe("last_seq: 1");
    r = await run(["events", "--after", "1"]);
    expect(r.out).toContain("0 events after seq 1");

    r = await run(["chats"]);
    expect(r.out).toContain("0 chats with kept content");
    r = await run(["read", "120363000000000001@g.us"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: not_found");

    r = await run(["settings", "set", "retain_days", "30"]);
    expect(r.out).toContain("retain_days: 30 (set)");

    r = await run(["doctor"]);
    expect(r.out).toContain("demo,daemon,ok");

    // A second daemon for the same account refuses.
    const second = spawn(process.execPath, [cliBin, "daemon", "run", "demo"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let secondOut = "";
    second.stdout?.on("data", (c: Buffer) => (secondOut += c.toString()));
    const code = await new Promise<number | null>((res) => second.once("close", res));
    expect(code).toBe(1);
    expect(secondOut).toContain("daemon_exited");

    // account remove refuses while the daemon runs.
    r = await run(["account", "remove", "demo", "--confirm", "demo"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("daemon_running");

    child.kill("SIGTERM");
    const exit = await new Promise<number | null>((res) => child?.once("close", res));
    expect(exit).toBe(0);
    expect(out).toContain("daemon: demo stopped");

    // Settings survived the restart-free stop, and the daemon being down is reported as such.
    r = await run(["scope", "show"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("whatsapp-axi daemon run demo");

    r = await run(["account", "remove", "demo", "--confirm", "demo"]);
    expect(r.code, r.out).toBe(0);
    r = await run(["accounts"]);
    expect(r.out).toContain("0 accounts");
  });
});
