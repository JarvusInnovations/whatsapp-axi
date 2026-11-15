import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_ROW } from "../src/commands/setup.js";
import { addAccount, FakeDaemon, makeEnv, run, socketPath, STATUS, type Env } from "./helpers.js";

// Every path here is under the test's temporary HOME and project; no hook is ever installed for
// the real user.
let env: Env;
let project: string;
let argv1: string;
let cwd: string;
const EXE = "/opt/example/whatsapp-axi/dist/bin/whatsapp-axi.js";

beforeEach(() => {
  env = makeEnv();
  project = join(env.home, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  argv1 = process.argv[1];
  process.argv[1] = EXE;
  cwd = process.cwd();
});

afterEach(async () => {
  process.chdir(cwd);
  process.argv[1] = argv1;
  await env.cleanup();
});

/** Runs with hook writes enabled (the helpers disable them for every other test). */
const hrun = (argv: string[]) => run(argv, { env: { WHATSAPP_AXI_DISABLE_HOOKS: undefined } });

const json = (p: string) => JSON.parse(readFileSync(p, "utf-8"));
const commands = (p: string): string[] => (json(p).hooks?.SessionStart ?? []).flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));

describe("setup hooks", () => {
  it("installs at user scope by default for Claude Code, Codex and OpenCode, verified by status", async () => {
    // The redirect took effect before anything writes: every target is under the test's HOME.
    let r = await hrun(["setup", "hooks", "status"]);
    expect(r.out).toContain(`claude,absent,${join(env.home, ".claude", "settings.json")}`);
    expect(r.out).toContain(`opencode,absent,${join(env.home, ".config")}`);
    r = await hrun(["setup", "hooks"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("action: installed");
    expect(r.out).toContain("claude,installed,");
    expect(r.out).toContain("codex,installed,");
    expect(r.out).toContain("opencode,installed,");
    expect(r.out).toContain("Restart your agent session to load the hook");
    expect(commands(join(env.home, ".claude", "settings.json"))).toEqual([`${EXE} session-start`]);
    expect(commands(join(env.home, ".codex", "hooks.json"))).toEqual([`${EXE} session-start`]);
    expect(readFileSync(join(env.home, ".codex", "config.toml"), "utf-8")).toContain("hooks = true");
    const plugin = readFileSync(join(env.home, ".config", "opencode", "plugins", "axi-whatsapp-axi.js"), "utf-8");
    expect(plugin).toContain(JSON.stringify(EXE));
    expect(plugin).toContain('["session-start"]');
    r = await hrun(["setup", "hooks"]);
    expect(r.out).toContain("already installed and current at user scope (no-op)");
    // The test-only guard: with it set, nothing is written.
    r = await run(["setup", "hooks", "uninstall"]);
    expect(r.out).toContain("WHATSAPP_AXI_DISABLE_HOOKS is set");
    expect(commands(join(env.home, ".claude", "settings.json"))).toEqual([`${EXE} session-start`]);
  });

  it("project scope goes to --dir or the git root, never the bare working directory, and keeps other hooks", async () => {
    const loose = join(env.home, "loose");
    mkdirSync(loose);
    process.chdir(loose);
    let r = await hrun(["setup", "hooks", "--scope", "project"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: NO_PROJECT");
    expect(existsSync(join(loose, ".claude"))).toBe(false);

    const sub = join(project, "src");
    mkdirSync(sub);
    process.chdir(sub);
    const claude = join(project, ".claude", "settings.json");
    mkdirSync(join(project, ".claude"));
    writeFileSync(claude, JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "other-tool home" }] }] }, permissions: { allow: ["x"] } }));
    r = await hrun(["setup", "hooks", "--scope", "project"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(".whatsapp-axi.json");
    expect(commands(claude)).toEqual(["other-tool home", `${EXE} session-start`]);
    expect(json(claude).permissions).toEqual({ allow: ["x"] });
    expect(existsSync(join(project, ".opencode", "plugins", "axi-whatsapp-axi.js"))).toBe(true);
    expect(existsSync(join(sub, ".claude"))).toBe(false);
    expect(existsSync(join(env.home, ".claude", "settings.json"))).toBe(false);

    r = await hrun(["setup", "hooks", "status", "--scope", "project"]);
    expect(r.out).toContain("claude,installed,");
    expect(r.out).toContain("the hook prints nothing here");

    r = await hrun(["setup", "hooks", "uninstall", "--scope", "project"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("action: uninstalled");
    expect(commands(claude)).toEqual(["other-tool home"]);
    expect(existsSync(join(project, ".opencode", "plugins", "axi-whatsapp-axi.js"))).toBe(false);
    r = await hrun(["setup", "hooks", "uninstall", "--scope", "project"]);
    expect(r.out).toContain("not installed at project scope (no-op)");
    expect((await hrun(["setup", "hooks", "--scope", "everywhere"])).code).toBe(2);
  });

  it("repairs a hook whose executable moved", async () => {
    await hrun(["setup", "hooks", "--scope", "project", "--dir", project]);
    const claude = join(project, ".claude", "settings.json");
    process.argv[1] = "/srv/moved/whatsapp-axi/dist/bin/whatsapp-axi.js";
    let r = await hrun(["setup", "hooks", "status", "--scope", "project", "--dir", project]);
    expect(r.out).toContain("claude,stale,");
    expect(r.out).toContain("repair");
    r = await hrun(["setup", "hooks", "--scope", "project", "--dir", project]);
    expect(r.out).toContain("action: installed");
    expect(commands(claude)).toEqual(["/srv/moved/whatsapp-axi/dist/bin/whatsapp-axi.js session-start"]);
  });

  it("any error writing a hook is a failure", async () => {
    const plugin = join(project, ".opencode", "plugins", "axi-whatsapp-axi.js");
    mkdirSync(join(project, ".opencode", "plugins"), { recursive: true });
    writeFileSync(plugin, "// mine\n");
    let r = await hrun(["setup", "hooks", "--scope", "project", "--dir", project]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("SETUP_FAILED");
    expect(r.out).toContain("partly installed (see errors)");
    expect(r.out).toContain("opencode,error,");
    expect(readFileSync(plugin, "utf-8")).toBe("// mine\n");
    const other = join(env.home, "other");
    mkdirSync(join(other, ".claude"), { recursive: true });
    writeFileSync(join(other, ".claude", "settings.json"), "{not json");
    r = await hrun(["setup", "hooks", "--scope", "project", "--dir", other]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("SETUP_FAILED");
    expect(readFileSync(join(other, ".claude", "settings.json"), "utf-8")).toBe("{not json");
    // An unreadable target is error with a problem, never "absent".
    r = await hrun(["setup", "hooks", "status", "--scope", "project", "--dir", other]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("claude,error,");
    expect(r.out).toContain("problems[");
    if (process.geteuid?.() !== 0) {
      const ro = join(env.home, "ro");
      mkdirSync(ro);
      chmodSync(ro, 0o500);
      r = await hrun(["setup", "hooks", "--scope", "project", "--dir", ro]);
      chmodSync(ro, 0o700);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("SETUP_FAILED");
    }
  });
});

describe("session-start", () => {
  it("prints nothing at all, and exits 0, in a directory with no .whatsapp-axi.json", async () => {
    addAccount(env, "example");
    const r = await run(["session-start", "--dir", project]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    // Even with a bad flag.
    expect((await run(["session-start", "--bogus"])).out).toBe("");
  });

  it("prints one row per listed account: events kept in the last 24 hours, counts only, writing nothing", async () => {
    addAccount(env, "example");
    const fake = new FakeDaemon();
    const sinces: string[] = [];
    fake.route("GET /v1/events", ({ query }) => {
      sinces.push(query.get("since") ?? "");
      return { body: { events: [{ seq: 7, kind: "message", chat: { id: "120363000000000001@g.us", name: "Secret group" }, message: { id: "3EB0X", text: "SECRET-MARKER", from: { id: "100000000000001@lid", pn: "+15550100001", name: "Sam" } } }], latest_seq: 7, total: 7 } };
    });
    await fake.listen(socketPath(env, "example"));
    try {
      writeFileSync(join(project, ".whatsapp-axi.json"), JSON.stringify({ accounts: ["example", "missing"] }));
      const { readdirSync } = await import("node:fs");
      const before = readdirSync(join(env.home, "state", "whatsapp-axi"));
      const now = Date.parse("2030-01-06T12:00:00Z");
      let r = await run(["session-start", "--dir", project], { now });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("whatsapp_axi[2]{account,state,scope,events_24h}:");
      expect(r.out).toContain("example,connected,tagged,7");
      expect(r.out).toContain("missing,\"unknown (NO_ACCOUNT: no such account)\",?,?");
      for (const leak of ["SECRET-MARKER", "Secret group", "Sam", "+1555", "@lid", "@g.us", "null"]) expect(r.out).not.toContain(leak);
      expect(sinces).toEqual(["2030-01-05T12:00:00Z"]);
      r = await run(["session-start", "--dir", project], { now });
      expect(r.out).toContain("example,connected,tagged,7");
      // It writes nothing: no cursor, no record.
      expect(readdirSync(join(env.home, "state", "whatsapp-axi"))).toEqual(before);
    } finally {
      await fake.close();
    }
  });

  it("a hung, stopped or failing daemon is its own row; the hook never fails", async () => {
    addAccount(env, "example");
    addAccount(env, "stopped");
    addAccount(env, "broken");
    const hung = new FakeDaemon();
    hung.route("GET /v1/status", () => ({ hang: true }));
    await hung.listen(socketPath(env, "example"));
    const broken = new FakeDaemon();
    broken.route("GET /v1/status", () => ({ body: { ...STATUS, protocol: 99 } }));
    await broken.listen(socketPath(env, "broken"));
    const saved = HOOK_ROW.ms;
    HOOK_ROW.ms = 200;
    try {
      writeFileSync(join(project, ".whatsapp-axi.json"), JSON.stringify({ accounts: ["example", "stopped", "broken"] }));
      const t0 = Date.now();
      const r = await run(["session-start", "--dir", project]);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("example,\"unavailable (TIMEOUT:");
      expect(r.out).toContain("stopped,\"unavailable (DAEMON_NOT_RUNNING:");
      expect(r.out).toContain("broken,\"unavailable (PROTOCOL_MISMATCH:");
      expect(r.out).not.toContain("null");
    } finally {
      HOOK_ROW.ms = saved;
      await hung.close();
      await broken.close();
    }
  });

  it("an invalid project file is one line, exit 0", async () => {
    writeFileSync(join(project, ".whatsapp-axi.json"), "{nope");
    const r = await run(["session-start", "--dir", project]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(".whatsapp-axi.json is invalid");
  });
});
