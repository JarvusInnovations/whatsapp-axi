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

const json = (p: string) => JSON.parse(readFileSync(p, "utf-8"));
const commands = (p: string): string[] => (json(p).hooks?.SessionStart ?? []).flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));

describe("setup hooks", () => {
  it("installs at user scope by default for Claude Code, Codex and OpenCode, verified by status", async () => {
    let r = await run(["setup", "hooks"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("installed or repaired at user scope");
    expect(r.out).toContain("claude,true,true");
    expect(r.out).toContain("codex,true,true");
    expect(r.out).toContain("opencode,true,true");
    expect(commands(join(env.home, ".claude", "settings.json"))).toEqual([`${EXE} session-start`]);
    expect(commands(join(env.home, ".codex", "hooks.json"))).toEqual([`${EXE} session-start`]);
    expect(readFileSync(join(env.home, ".codex", "config.toml"), "utf-8")).toContain("hooks = true");
    const plugin = readFileSync(join(env.home, ".config", "opencode", "plugins", "axi-whatsapp-axi.js"), "utf-8");
    expect(plugin).toContain(JSON.stringify(EXE));
    expect(plugin).toContain('["session-start"]');
    r = await run(["setup", "hooks"]);
    expect(r.out).toContain("already installed and current at user scope (no-op)");
  });

  it("project scope goes to --dir or the git root, never the bare working directory, and keeps other hooks", async () => {
    const loose = join(env.home, "loose");
    mkdirSync(loose);
    process.chdir(loose);
    let r = await run(["setup", "hooks", "--scope", "project"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: no_project");
    expect(existsSync(join(loose, ".claude"))).toBe(false);

    const sub = join(project, "src");
    mkdirSync(sub);
    process.chdir(sub);
    const claude = join(project, ".claude", "settings.json");
    mkdirSync(join(project, ".claude"));
    writeFileSync(claude, JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "other-tool home" }] }] }, permissions: { allow: ["x"] } }));
    r = await run(["setup", "hooks", "--scope", "project"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(".whatsapp-axi.json");
    expect(commands(claude)).toEqual(["other-tool home", `${EXE} session-start`]);
    expect(json(claude).permissions).toEqual({ allow: ["x"] });
    expect(existsSync(join(project, ".opencode", "plugins", "axi-whatsapp-axi.js"))).toBe(true);
    expect(existsSync(join(sub, ".claude"))).toBe(false);
    expect(existsSync(join(env.home, ".claude", "settings.json"))).toBe(false);

    r = await run(["setup", "hooks", "status", "--scope", "project"]);
    expect(r.out).toContain("claude,true,true");
    expect(r.out).toContain("the hook prints nothing here");

    r = await run(["setup", "hooks", "uninstall", "--scope", "project"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("removed at project scope");
    expect(commands(claude)).toEqual(["other-tool home"]);
    expect(existsSync(join(project, ".opencode", "plugins", "axi-whatsapp-axi.js"))).toBe(false);
    r = await run(["setup", "hooks", "uninstall", "--scope", "project"]);
    expect(r.out).toContain("not installed at project scope (no-op)");
    expect((await run(["setup", "hooks", "--scope", "everywhere"])).code).toBe(2);
  });

  it("repairs a hook whose executable moved", async () => {
    await run(["setup", "hooks", "--scope", "project", "--dir", project]);
    const claude = join(project, ".claude", "settings.json");
    process.argv[1] = "/srv/moved/whatsapp-axi/dist/bin/whatsapp-axi.js";
    let r = await run(["setup", "hooks", "status", "--scope", "project", "--dir", project]);
    expect(r.out).toContain("claude,true,false");
    expect(r.out).toContain("repair");
    r = await run(["setup", "hooks", "--scope", "project", "--dir", project]);
    expect(r.out).toContain("installed or repaired at project scope");
    expect(commands(claude)).toEqual(["/srv/moved/whatsapp-axi/dist/bin/whatsapp-axi.js session-start"]);
  });

  it("any error writing a hook is a failure", async () => {
    const plugin = join(project, ".opencode", "plugins", "axi-whatsapp-axi.js");
    mkdirSync(join(project, ".opencode", "plugins"), { recursive: true });
    writeFileSync(plugin, "// mine\n");
    let r = await run(["setup", "hooks", "--scope", "project", "--dir", project]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("setup_failed");
    expect(readFileSync(plugin, "utf-8")).toBe("// mine\n");
    const other = join(env.home, "other");
    mkdirSync(join(other, ".claude"), { recursive: true });
    writeFileSync(join(other, ".claude", "settings.json"), "{not json");
    r = await run(["setup", "hooks", "--scope", "project", "--dir", other]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("setup_failed");
    if (process.geteuid?.() !== 0) {
      const ro = join(env.home, "ro");
      mkdirSync(ro);
      chmodSync(ro, 0o500);
      r = await run(["setup", "hooks", "--scope", "project", "--dir", ro]);
      chmodSync(ro, 0o700);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("setup_failed");
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

  it("prints one row per listed account, counts only, and counts from the last run", async () => {
    addAccount(env, "example");
    const fake = new FakeDaemon();
    const afters: string[] = [];
    fake.route("GET /v1/events", ({ query }) => {
      afters.push(query.get("after") ?? "");
      const after = Number(query.get("after"));
      return { body: { events: [{ seq: after + 1, kind: "message", chat: { id: "120363000000000001@g.us", name: "Secret group" }, message: { id: "3EB0X", text: "SECRET-MARKER", from: { id: "100000000000001@lid", pn: "+15550100001", name: "Sam" } } }], latest_seq: 7, total: 7 - after } };
    });
    await fake.listen(socketPath(env, "example"));
    try {
      writeFileSync(join(project, ".whatsapp-axi.json"), JSON.stringify({ accounts: ["example", "missing"] }));
      let r = await run(["session-start", "--dir", project]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("whatsapp_axi[2]{account,state,scope,new_events}:");
      expect(r.out).toContain("example,connected,tagged,7");
      expect(r.out).toContain("missing,no such account,null,null");
      for (const leak of ["SECRET-MARKER", "Secret group", "Sam", "+1555", "@lid", "@g.us"]) expect(r.out).not.toContain(leak);
      r = await run(["session-start", "--dir", project]);
      expect(r.out).toContain("example,connected,tagged,0");
      expect(afters).toEqual(["0", "7"]);
      // Another project keeps its own record.
      const other = join(env.home, "other");
      mkdirSync(join(other, ".git"), { recursive: true });
      writeFileSync(join(other, ".whatsapp-axi.json"), JSON.stringify({ accounts: ["example"] }));
      r = await run(["session-start", "--dir", other]);
      expect(r.out).toContain("example,connected,tagged,7");
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
      expect(r.out).toContain("example,not answering,null,null");
      expect(r.out).toContain("stopped,stopped,null,null");
      expect(r.out).toContain("broken,error (protocol_mismatch),null,null");
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
