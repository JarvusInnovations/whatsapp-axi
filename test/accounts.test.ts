// The multi-account model (specs/conventions.md "Accounts"), the accounts/ layout and its
// migration, fail-closed listing, and formatError.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { formatError } from "../src/cli.js";
import { addAccount, addLegacyAccount, apiError, FakeDaemon, makeEnv, run, socketPath, type Env } from "./helpers.js";

let env: Env;
const fakes: FakeDaemon[] = [];

async function daemonFor(name: string): Promise<FakeDaemon> {
  const f = new FakeDaemon();
  await f.listen(socketPath(env, name));
  fakes.push(f);
  return f;
}

beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  await env.cleanup();
});

const cfgRoot = () => join(env.home, "config", "whatsapp-axi");

describe("resolution", () => {
  it("with one account nothing needs --account, and no account_source is printed", async () => {
    addAccount(env, "alpha");
    await daemonFor("alpha");
    const r = await run(["scope", "show"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out.split("\n")[0]).toBe("account: alpha");
    expect(r.out).not.toContain("account_source");
  });

  it("reads use the default (account_source: default); mutations still need --account", async () => {
    addAccount(env, "alpha");
    addAccount(env, "beta");
    const beta = await daemonFor("beta");
    let r = await run(["account", "use", "beta"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("action: set");
    expect(r.out).toContain("note: was unset");
    expect(JSON.parse(readFileSync(join(cfgRoot(), "config.json"), "utf-8"))).toEqual({ default_account: "beta" });
    expect(statSync(join(cfgRoot(), "config.json")).mode & 0o777).toBe(0o600);
    r = await run(["scope", "show"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("account: beta\naccount_source: default");
    r = await run(["scope", "set", "tagged"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("code: ACCOUNT_REQUIRED");
    // One runnable line per account, carrying the caller's own arguments.
    expect(r.out).toContain("Run `whatsapp-axi scope set tagged --account alpha` to act as alpha");
    expect(r.out).toContain("Run `whatsapp-axi scope set tagged --account beta` to act as beta");
    r = await run(["scope", "set", "tagged", "--account", "beta"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("account_source");
    expect(beta.seen.some((x) => x.method === "PATCH")).toBe(true);
    r = await run(["account", "use", "beta"]);
    expect(r.out).toContain("action: unchanged");
    r = await run(["account", "use", "alpha"]);
    expect(r.out).toContain("note: was beta");
    expect(r.out).toContain("Run `whatsapp-axi account use beta` to undo");
    r = await run(["account", "use", "gamma"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: NO_ACCOUNT");
  });

  it("the pin acts for reads and writes, refuses another account, and a bad pin never falls back", async () => {
    addAccount(env, "alpha");
    addAccount(env, "beta");
    await daemonFor("alpha");
    const pin = { env: { WHATSAPP_AXI_ACCOUNT: "alpha" } };
    let r = await run(["scope", "set", "tagged"], pin);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("account: alpha\naccount_source: env");
    r = await run(["scope", "show", "--account", "alpha"], pin);
    expect(r.code).toBe(0);
    r = await run(["scope", "show", "--account", "beta"], pin);
    expect(r.code).toBe(2);
    expect(r.out).toContain("code: ACCOUNT_LOCKED");
    r = await run(["scope", "show"], { env: { WHATSAPP_AXI_ACCOUNT: "gamma" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: ACCOUNT_LOCK_INVALID");
    // An empty pin is unset.
    r = await run(["scope", "show"], { env: { WHATSAPP_AXI_ACCOUNT: "  " } });
    expect(r.out).toContain("code: ACCOUNT_REQUIRED");
    // Home names the pin.
    r = await run([], pin);
    expect(r.code).toBe(0);
    expect(r.out).toContain("account_lock: alpha (WHATSAPP_AXI_ACCOUNT)");
    expect(r.out).toContain("writes: go to alpha (pinned by WHATSAPP_AXI_ACCOUNT)");
  });

  it("--account is global: accepted on every command, and on the daemon commands it must agree with the positional", async () => {
    addAccount(env, "alpha");
    let r = await run(["daemon", "status", "alpha", "--account", "beta"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("code: VALIDATION_ERROR");
    r = await run(["setup", "hooks", "--account", "alpha"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("does not apply");
    r = await run(["daemon", "upgrade", "--account", "alpha"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("daemon restart alpha");
    r = await run(["accounts", "--account", "alpha"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("count: 1 of 1");
  });

  it("hints carry --account only when there are several accounts", async () => {
    addAccount(env, "alpha");
    const f = await daemonFor("alpha");
    f.route("GET /v1/chats", () => ({ body: { chats: [] } }));
    let r = await run(["chats"]);
    expect(r.out).not.toContain("--account");
    addAccount(env, "beta");
    r = await run(["chats", "--account", "alpha"]);
    expect(r.out).toContain("scope show --account alpha");
  });

  it("home says whether writes need --account and names the default", async () => {
    addAccount(env, "alpha");
    addAccount(env, "beta");
    await run(["account", "use", "alpha"]);
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("default: alpha");
    expect(r.out).toContain("writes: need --account (2 accounts)");
  });
});

describe("fail closed", () => {
  it("an account whose files cannot be read is still an account", async () => {
    addAccount(env, "alpha");
    addAccount(env, "beta");
    const dir = join(cfgRoot(), "accounts", "beta");
    chmodSync(dir, 0o000);
    try {
      let r = await run(["accounts"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('beta,"unknown (CONFIG_INVALID:');
      // It counts toward "more than one", so alpha is never "the only one".
      r = await run(["scope", "set", "tagged"]);
      expect(r.code).toBe(2);
      expect(r.out).toContain("code: ACCOUNT_REQUIRED");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("an accounts directory that cannot be read is CONFIG_INVALID, and home still answers", async () => {
    addAccount(env, "alpha");
    const dir = join(cfgRoot(), "accounts");
    chmodSync(dir, 0o000);
    try {
      let r = await run(["scope", "show"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("code: CONFIG_INVALID");
      r = await run([]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("unavailable (CONFIG_INVALID");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("a default file that does not parse is CONFIG_INVALID and is never overwritten", async () => {
    addAccount(env, "alpha");
    addAccount(env, "beta");
    writeFileSync(join(cfgRoot(), "config.json"), "{not json", { mode: 0o600 });
    let r = await run(["scope", "show"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: CONFIG_INVALID");
    r = await run(["account", "use", "alpha"]);
    expect(r.code).toBe(1);
    expect(readFileSync(join(cfgRoot(), "config.json"), "utf-8")).toBe("{not json");
  });

  it("a list without a numeric total is UNEXPECTED_RESPONSE, never an invented N of N", async () => {
    addAccount(env, "alpha");
    const f = await daemonFor("alpha");
    f.route("GET /v1/chats", () => ({ body: { chats: [{ id: "120363000000000001@g.us", name: "x", type: "group", scope: "tagged" }] }, exact: true }));
    const r = await run(["chats"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: UNEXPECTED_RESPONSE");
  });

  it("an unreadable service directory is an error, never not installed", async () => {
    addAccount(env, "alpha");
    const units = join(env.home, "config", "systemd", "user");
    mkdirSync(join(units, "default.target.wants"), { recursive: true });
    chmodSync(join(units, "default.target.wants"), 0o000);
    try {
      const r = await run(["daemon", "start", "alpha"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("code: SERVICE_FAILED");
    } finally {
      chmodSync(join(units, "default.target.wants"), 0o700);
    }
  });
});

describe("the accounts/ layout", () => {
  it("WHATSAPP_AXI_CONFIG_DIR moves the config root", async () => {
    const other = join(env.home, "elsewhere");
    mkdirSync(join(other, "accounts", "alpha"), { recursive: true, mode: 0o700 });
    writeFileSync(join(other, "accounts", "alpha", "settings.json"), "{}", { mode: 0o600 });
    const r = await run(["accounts"], { env: { WHATSAPP_AXI_CONFIG_DIR: other } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("alpha,");
  });

  it("home and doctor echo WHATSAPP_AXI_CONFIG_DIR and WHATSAPP_AXI_DAEMON when set", async () => {
    const other = join(env.home, "elsewhere");
    mkdirSync(join(other, "accounts", "alpha"), { recursive: true, mode: 0o700 });
    writeFileSync(join(other, "accounts", "alpha", "settings.json"), "{}", { mode: 0o600 });
    const bin = join(env.home, "whatsapp-axid-custom");
    writeFileSync(bin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const set = { WHATSAPP_AXI_CONFIG_DIR: other, WHATSAPP_AXI_DAEMON: bin };
    for (const argv of [[], ["doctor"]]) {
      const r = await run(argv, { env: set });
      expect(r.out, argv.join(" ")).toContain(`config_dir: ${other} (WHATSAPP_AXI_CONFIG_DIR)`);
      expect(r.out, argv.join(" ")).toContain(`daemon_binary: ${bin} (WHATSAPP_AXI_DAEMON)`);
    }
    // With no accounts at all, home still says where it looked.
    const empty = join(env.home, "empty");
    mkdirSync(empty, { recursive: true, mode: 0o700 });
    let r = await run([], { env: { WHATSAPP_AXI_CONFIG_DIR: empty } });
    expect(r.out).toContain(`config_dir: ${empty} (WHATSAPP_AXI_CONFIG_DIR)`);
    // A relative path is ignored, and home says so.
    r = await run([], { env: { WHATSAPP_AXI_CONFIG_DIR: "relative/dir" } });
    expect(r.out).toContain("WHATSAPP_AXI_CONFIG_DIR is ignored");
    // Unset: neither line.
    for (const argv of [[], ["doctor"]]) {
      r = await run(argv);
      expect(r.out).not.toContain("config_dir:");
      expect(r.out).not.toContain("daemon_binary:");
    }
  });

  it("a stray file or an old-layout directory is never an account", async () => {
    addLegacyAccount(env, "old");
    mkdirSync(join(cfgRoot(), "accounts"), { recursive: true, mode: 0o700 });
    writeFileSync(join(cfgRoot(), "accounts", "stray"), "x");
    let r = await run(["accounts"]);
    expect(r.out).toContain("0 accounts");
    r = await run([]);
    expect(r.out).toContain("old_layout: old");
    expect(r.out).toContain("Run `whatsapp-axi account migrate` to move old");
  });

  it("doctor reports an old-layout account as fail with the move", async () => {
    addLegacyAccount(env, "old");
    const r = await run(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("old,files,fail,");
    expect(r.out).toContain("Run `whatsapp-axi account migrate old` to fix files of old");
  });
});

const daemonBin = join(import.meta.dirname, "..", "daemon", "bin", "whatsapp-axid");

describe.skipIf(!existsSync(daemonBin))("account migrate, with the real daemon binary", () => {
  beforeEach(() => {
    process.env.WHATSAPP_AXI_DAEMON = daemonBin;
  });

  it("moves both directories, keeps modes, and is a no-op when already in place", async () => {
    addLegacyAccount(env, "old");
    let r = await run(["account", "migrate"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("action: moved");
    expect(r.out).toContain("moved[2]{account,from,to}:");
    expect(statSync(join(cfgRoot(), "accounts", "old", "settings.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(cfgRoot(), "old"))).toBe(false);
    r = await run(["account", "migrate", "old"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("action: unchanged");
    r = await run(["account", "migrate"]);
    expect(r.out).toContain("no account is in the old layout (no-op)");
    r = await run(["accounts"]);
    expect(r.out).toContain("old,");
  });

  it("refuses with DAEMON_RUNNING while that account's daemon holds its lock", async () => {
    addLegacyAccount(env, "old");
    const { spawn } = await import("node:child_process");
    // A process holding the old-place lock, as a running daemon does.
    const lock = join(env.home, "state", "whatsapp-axi", "old", "daemon.lock");
    const holder = spawn("flock", [lock, "sleep", "30"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 50 && !existsSync(lock); i++) await new Promise((x) => setTimeout(x, 20));
      await new Promise((x) => setTimeout(x, 100));
      const r = await run(["account", "migrate", "old"]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("code: DAEMON_RUNNING");
      expect(existsSync(join(cfgRoot(), "old", "settings.json"))).toBe(true);
    } finally {
      holder.kill();
    }
  });
});

describe("formatError", () => {
  it("usage-class codes exit 2, others 1", () => {
    for (const code of ["USAGE", "UNKNOWN_FLAG", "VALIDATION_ERROR", "CONFIRM_REQUIRED", "ACCOUNT_REQUIRED", "ACCOUNT_LOCKED"]) {
      expect(formatError(new AxiError("x", code)).exitCode, code).toBe(2);
    }
    for (const code of ["NO_ACCOUNT", "TIMEOUT", "ACCOUNT_LOCK_INVALID", "OUTCOME_UNKNOWN"])
      expect(formatError(new AxiError("x", code)).exitCode, code).toBe(1);
  });

  it("an unexpected throw is INTERNAL_ERROR with a doctor hint and no stack; an errno code never leaks", () => {
    const err = Object.assign(new Error("EACCES: permission denied, open '/x'"), { code: "EACCES" });
    const f = formatError(err);
    expect(f.exitCode).toBe(1);
    expect(f.output).toContain("code: INTERNAL_ERROR");
    expect(f.output).toContain("unexpected failure:");
    expect(f.output).toContain("whatsapp-axi doctor");
    expect(f.output).not.toContain("EACCES\n");
    expect(f.output).not.toMatch(/^\s+at /m);
  });

  it("daemon codes pass through unchanged", async () => {
    addAccount(env, "alpha");
    const f = await daemonFor("alpha");
    f.route("GET /v1/chats", () => apiError(409, "NOT_CONNECTED", "x", { state: "connecting" }));
    const r = await run(["chats"]);
    expect(r.out).toContain("code: NOT_CONNECTED");
  });
});
