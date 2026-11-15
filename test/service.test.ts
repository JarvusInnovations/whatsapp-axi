import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import { addAccount, FakeDaemon, makeEnv, run, service, socketPath, STATUS, type Env } from "./helpers.js";

let env: Env;
let src: string;

/** A stand-in daemon binary that reports a version. */
function fakeBinary(version: string, tag = "a"): string {
  const p = join(env.home, `whatsapp-axid-${tag}`);
  writeFileSync(p, `#!/bin/sh\n# ${tag}\n[ "$1" = version ] && echo "whatsapp-axid ${version}" && echo "go.mau.fi/whatsmeow v0" && exit 0\nexit 3\n`, { mode: 0o755 });
  return p;
}

beforeEach(() => {
  env = makeEnv();
  addAccount(env, "example");
  src = fakeBinary(VERSION);
  process.env.WHATSAPP_AXI_DAEMON = src;
});

afterEach(() => env.cleanup());

const unitDir = () => join(env.home, "config", "systemd", "user");
const unitPath = () => join(unitDir(), "whatsapp-axi@.service");
const installed = () => join(env.home, "data", "whatsapp-axi", "bin", "whatsapp-axid");

function listAll(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

describe("daemon install --dry-run", () => {
  it("prints the unit and the paths and changes nothing", async () => {
    const before = listAll(env.home);
    const r = await run(["daemon", "install", "example", "--dry-run"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("dry_run: true");
    expect(r.out).toContain(`from: ${src}`);
    expect(r.out).toContain(`to: ${installed()}`);
    expect(r.out).toContain(`unit_file ${unitPath()}:`);
    expect(r.out).toContain(`ExecStart="${installed()}" run --account %i`);
    expect(r.out).toContain("Restart=on-failure");
    expect(r.out).toContain("systemctl --user enable --now whatsapp-axi@example.service");
    expect(listAll(env.home)).toEqual(before);
    expect(service.calls).toEqual([]);
  });

  it("says it would refuse when lingering is off", async () => {
    service.linger = false;
    const r = await run(["daemon", "install", "example", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("would_refuse");
    expect(r.out).toContain("lingering: false");
  });
});

describe("daemon install", () => {
  it("copies the binary to the stable path, writes the template unit, enables and starts it", async () => {
    const r = await run(["daemon", "install", "example"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("installed: example");
    expect(r.out).toContain("service: active (running)");
    expect(readFileSync(installed(), "utf-8")).toBe(readFileSync(src, "utf-8"));
    expect(statSync(installed()).mode & 0o777).toBe(0o755);
    expect(statSync(join(env.home, "data", "whatsapp-axi", "bin")).mode & 0o777).toBe(0o700);
    const unit = readFileSync(unitPath(), "utf-8");
    // The unit runs the binary from the stable path, never from the package or checkout.
    expect(unit).toContain(`ExecStart="${installed()}" run --account %i`);
    expect(unit).not.toContain(src);
    expect(unit).not.toContain("node_modules");
    expect(unit).toContain(`Environment="XDG_STATE_HOME=${join(env.home, "state")}"`);
    expect(unit).toContain("WantedBy=default.target");
    expect(service.verbs()).toEqual(["daemon-reload", "enable --now whatsapp-axi@example.service"]);
    // Again: a no-op.
    service.calls = [];
    const again = await run(["daemon", "install", "example"]);
    expect(again.out).toContain("already installed and running (no-op)");
    expect(service.verbs()).toEqual(["enable --now whatsapp-axi@example.service"]);
  });

  it("refuses without lingering and names the command; the override works", async () => {
    service.linger = false;
    let r = await run(["daemon", "install", "example"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: linger_off");
    expect(r.out).toContain("loginctl enable-linger tester");
    expect(r.out).toContain("--no-linger-check");
    expect(existsSync(installed()) || existsSync(unitPath())).toBe(false);
    expect(service.calls).toEqual([]);
    service.linger = undefined;
    r = await run(["daemon", "install", "example"]);
    expect(r.out).toContain("could not be confirmed");
    r = await run(["daemon", "install", "example", "--no-linger-check"]);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(unitPath())).toBe(true);
  });

  it("refuses while a foreground daemon runs, and on an unknown account or platform", async () => {
    const fake = new FakeDaemon();
    await fake.listen(socketPath(env, "example"));
    try {
      const r = await run(["daemon", "install", "example"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("code: daemon_running");
      expect(existsSync(unitPath())).toBe(false);
    } finally {
      await fake.close();
    }
    let r = await run(["daemon", "install", "nobody"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no_account");
    service.isSupported = false;
    r = await run(["daemon", "install", "example"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("unsupported_platform");
    expect(r.out).toContain("daemon run");
  });

  it("reports a failing service manager", async () => {
    service.failVerb = "enable";
    const r = await run(["daemon", "install", "example"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: service_failed");
    expect(r.out).toContain("Failed to connect to bus");
  });
});

describe("daemon start, stop, restart, status, uninstall", () => {
  it("needs an installed service", async () => {
    for (const verb of ["start", "stop", "restart"]) {
      const r = await run(["daemon", verb, "example"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("code: not_installed");
      expect(r.out).toContain("whatsapp-axi daemon install example");
    }
  });

  it("controls the service, with no-ops when already so", async () => {
    await run(["daemon", "install", "example"]);
    service.calls = [];
    let r = await run(["daemon", "start", "example"]);
    expect(r.out).toContain("already running (no-op)");
    r = await run(["daemon", "stop", "example"]);
    expect(r.out).toContain("example inactive (dead)");
    r = await run(["daemon", "stop", "example"]);
    expect(r.out).toContain("already stopped (no-op)");
    r = await run(["daemon", "start", "example"]);
    expect(r.out).toContain("example active (running)");
    r = await run(["daemon", "restart", "example"]);
    expect(r.code).toBe(0);
    expect(service.verbs()).toEqual(["stop whatsapp-axi@example.service", "start whatsapp-axi@example.service", "restart whatsapp-axi@example.service"]);
  });

  it("shows the service and the daemon together", async () => {
    let r = await run(["daemon", "status", "example"]);
    expect(r.out).toContain("installed: false");
    expect(r.out).toContain("state: not running");
    expect(r.out).toContain("daemon install example");
    await run(["daemon", "install", "example"]);
    const fake = new FakeDaemon();
    await fake.listen(socketPath(env, "example"));
    try {
      r = await run(["daemon", "status", "example"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("installed: true");
      expect(r.out).toContain("active: active");
      expect(r.out).toContain("state: connected");
    } finally {
      await fake.close();
    }
  });

  it("uninstalls with --confirm, leaving the account's files", async () => {
    addAccount(env, "other");
    await run(["daemon", "install", "example"]);
    await run(["daemon", "install", "other"]);
    let r = await run(["daemon", "uninstall", "example"]);
    expect(r.code).toBe(2);
    r = await run(["daemon", "uninstall", "example", "--confirm"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("kept: other accounts use it");
    expect(existsSync(unitPath())).toBe(true);
    r = await run(["daemon", "uninstall", "other", "--confirm"]);
    expect(r.out).toContain("template_unit: removed");
    expect(existsSync(unitPath())).toBe(false);
    expect(existsSync(join(env.home, "config", "whatsapp-axi", "example", "settings.json"))).toBe(true);
    r = await run(["daemon", "uninstall", "other", "--confirm"]);
    expect(r.out).toContain("not installed (no-op)");
  });
});

describe("daemon logs", () => {
  it("prints recent lines, says when there are none, and reports a failing journal", async () => {
    service.logLines = ["2030-01-05T14:00:00+0000 host whatsapp-axid[1]: level=INFO msg=listening", "2030-01-05T14:00:01+0000 host whatsapp-axid[1]: level=INFO msg=state state=connected"];
    let r = await run(["daemon", "logs", "example", "--lines", "1"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("msg=state state=connected");
    expect(r.out).not.toContain("msg=listening");
    service.logLines = ["-- No entries --"];
    r = await run(["daemon", "logs", "example"]);
    expect(r.out).toContain("0 lines for whatsapp-axi@example.service");
    service.logResult = { code: 1, stdout: "", stderr: "No journal files were found.\n" };
    r = await run(["daemon", "logs", "example"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: logs_failed");
    r = await run(["daemon", "logs", "example", "--lines", "0"]);
    expect(r.code).toBe(2);
  });
});

describe("daemon upgrade and doctor", () => {
  it("replaces the binary, restarts installed accounts, then doctor reports matching versions", async () => {
    const old = fakeBinary("0.0.1", "old");
    process.env.WHATSAPP_AXI_DAEMON = old;
    addAccount(env, "other");
    await run(["daemon", "install", "example"]);
    await run(["daemon", "install", "other"]);
    process.env.WHATSAPP_AXI_DAEMON = src;

    const fake = new FakeDaemon();
    fake.route("GET /v1/status", () => ({ body: { ...STATUS, daemon_version: "0.0.1" } }));
    await fake.listen(socketPath(env, "example"));
    try {
      let r = await run(["doctor", "--account", "example"]);
      expect(r.out).toContain("example,binary,warn,");
      expect(r.out).toContain("installed binary 0.0.1");
      expect(r.out).toContain("whatsapp-axi daemon upgrade");

      service.calls = [];
      r = await run(["daemon", "upgrade"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("upgrade: replaced");
      expect(r.out).toContain(`version: ${VERSION}`);
      expect(service.verbs()).toEqual(["restart whatsapp-axi@example.service", "restart whatsapp-axi@other.service"]);
      expect(readFileSync(installed(), "utf-8")).toBe(readFileSync(src, "utf-8"));

      // The restarted daemon now runs the new binary.
      fake.route("GET /v1/status", () => ({ body: { ...STATUS, daemon_version: VERSION } }));
      r = await run(["doctor", "--account", "example"]);
      expect(r.out).toContain(`example,binary,ok,installed binary ${VERSION} matches the cli and the running daemon`);
      expect(r.out).toContain("example,service,ok");
      expect(r.out).toContain("example,linger,ok");

      r = await run(["daemon", "upgrade"]);
      expect(r.out).toContain("already this CLI's (no-op)");
    } finally {
      await fake.close();
    }
  });

  it("with nothing installed, upgrade is a no-op", async () => {
    const r = await run(["daemon", "upgrade"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no-op");
    expect(existsSync(installed())).toBe(false);
  });

  it("doctor names the service fixes", async () => {
    let r = await run(["doctor"]);
    expect(r.out).toContain("example,service,warn,");
    expect(r.out).toContain("whatsapp-axi daemon install example");
    await run(["daemon", "install", "example"]);
    await run(["daemon", "stop", "example"]);
    service.linger = false;
    r = await run(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("example,service,fail,");
    expect(r.out).toContain("whatsapp-axi daemon start example");
    expect(r.out).toContain("example,linger,fail,");
    expect(r.out).toContain("loginctl enable-linger tester");
    service.isSupported = false;
    r = await run(["doctor"]);
    expect(r.out).not.toContain("example,service");
  });
});
