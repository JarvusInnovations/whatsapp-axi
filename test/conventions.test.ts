// Cross-cutting rules of specs/cli.md: usage errors, account choice, daemon down, version flags.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDaemon, platformPackage } from "../src/binary.js";
import { SPECS } from "../src/cli.js";
import { addAccount, makeEnv, run, type Env } from "./helpers.js";

let env: Env;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

const GROUP = "120363000000000001@g.us";

/** One valid invocation per daemon-backed command. */
const DAEMON_BACKED: string[][] = [
  ["chats"],
  ["groups"],
  ["chat", "view", GROUP],
  ["events"],
  ["events", "--follow"],
  ["read", GROUP],
  ["message", "view", "3EB0AAAA0000000001"],
  ["forget", GROUP, "--confirm"],
  ["mark-read", `${GROUP}/3EB0AAAA0000000001`],
  ["mark-read", "--chat", GROUP],
  ["typing", GROUP],
  ["typing", GROUP, "--stop"],
  ["scope", "show"],
  ["scope", "set", "tagged"],
  ["scope", "dm-from", "anyone", "--confirm"],
  ["operators", "list"],
  ["operators", "add", "+15550100001"],
  ["operators", "remove", "+15550100001"],
  ["settings", "show"],
  ["settings", "set", "presence", "false"],
];

describe("with no daemon running", () => {
  it("every daemon-backed command names the start command and exits 1", async () => {
    addAccount(env, "example");
    for (const argv of DAEMON_BACKED) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.out, argv.join(" ")).toContain("code: daemon_not_running");
      expect(r.out, argv.join(" ")).toContain("whatsapp-axi daemon start example");
    }
  });

  it("doctor reports it as a failed check with the start command", async () => {
    addAccount(env, "example");
    const r = await run(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("whatsapp-axi daemon start example");
  });
});

describe("choosing the account", () => {
  it("a missing --account with several accounts is a usage error listing them", async () => {
    addAccount(env, "alpha");
    addAccount(env, "beta");
    for (const argv of DAEMON_BACKED) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out, argv.join(" ")).toContain("alpha, beta");
    }
  });

  it("an unknown or malformed --account is rejected", async () => {
    addAccount(env, "alpha");
    let r = await run(["chats", "--account", "gamma"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: no_account");
    expect(r.out).toContain("account add gamma");
    r = await run(["chats", "--account", "+15550100001"]);
    expect(r.code).toBe(2);
  });
});

describe("usage errors", () => {
  it("every command rejects an unknown flag by name, listing its valid flags", async () => {
    addAccount(env, "example");
    for (const spec of SPECS) {
      const argv = [...spec.name.split(" "), ...spec.positionals.filter((p) => p.required).map(() => "x"), "--bogus"];
      const r = await run(argv);
      expect(r.code, spec.name).toBe(2);
      expect(r.out, spec.name).toContain("unknown flag --bogus");
      expect(r.out, spec.name).toContain(`valid flags for \`${spec.name}\``);
    }
  });

  it("missing values, missing arguments and extra arguments exit 2", async () => {
    addAccount(env, "example");
    const cases = [["events", "--after"], ["events", "--limit", "--follow"], ["read"], ["chat", "view"], ["chats", "extra"], ["scope"], ["scope", "nope"], ["account", "add"], ["chats", "--account"], ["bogus"], ["-x"]];
    for (const argv of cases) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out, argv.join(" ")).toContain("code: usage");
    }
  });

  it("--help works on every command and prints its flags and examples", async () => {
    for (const spec of SPECS) {
      const r = await run([...spec.name.split(" "), "--help"]);
      expect(r.code, spec.name).toBe(0);
      expect(r.out, spec.name).toContain(`command: ${spec.name}`);
      expect(r.out, spec.name).toContain("examples[");
    }
    const top = await run(["--help"]);
    expect(top.out).toContain("usage: whatsapp-axi");
    const group = await run(["scope", "--help"]);
    expect(group.out).toContain("scope set");
  });
});

describe("version flags", () => {
  const bin = join(import.meta.dirname, "..", "dist", "bin", "whatsapp-axi.js");
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")) as { version: string };

  it("the entry point loads only the fast path and the version before answering", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "bin", "whatsapp-axi.ts"), "utf-8");
    const statics = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(statics).toEqual(["axi-sdk-js/fast-path", "../src/version.js"]);
    const version = readFileSync(join(import.meta.dirname, "..", "src", "version.ts"), "utf-8");
    expect([...version.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).every((m) => m.startsWith("node:"))).toBe(true);
  });

  it.skipIf(!existsSync(bin))("-v, -V and --version print the bare version", () => {
    for (const flag of ["-v", "-V", "--version"]) {
      expect(execFileSync(process.execPath, [bin, flag], { encoding: "utf-8" }).trim()).toBe(pkg.version);
    }
  });
});

describe("finding the daemon binary", () => {
  it("prefers the environment variable, then a source checkout, then the platform package", () => {
    const dir = join(env.home, "pkg");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "whatsapp-axid"), "", { mode: 0o755 });
    const checkout = join(env.home, "checkout");
    mkdirSync(join(checkout, "daemon", "bin"), { recursive: true });
    writeFileSync(join(checkout, "daemon", "bin", "whatsapp-axid"), "", { mode: 0o755 });
    const envBin = join(env.home, "env-axid");
    writeFileSync(envBin, "", { mode: 0o755 });

    expect(findDaemon({ env: { WHATSAPP_AXI_DAEMON: envBin }, root: checkout, resolvePackage: () => dir })).toBe(envBin);
    expect(findDaemon({ env: {}, root: checkout, resolvePackage: () => dir })).toBe(join(checkout, "daemon", "bin", "whatsapp-axid"));
    expect(findDaemon({ env: {}, root: undefined, resolvePackage: () => dir })).toBe(join(dir, "bin", "whatsapp-axid"));
    expect(() => findDaemon({ env: {}, root: undefined, resolvePackage: () => undefined })).toThrow(/platform package whatsapp-axi-/);
  });

  it("maps platforms to package names", () => {
    expect(platformPackage("linux", "x64")).toBe("whatsapp-axi-linux-x64");
    expect(platformPackage("darwin", "arm64")).toBe("whatsapp-axi-darwin-arm64");
    expect(platformPackage("win32", "x64")).toBeUndefined();
  });
});

describe("daemon errors on every daemon-backed command", () => {
  it("internal, unreadable answers and an unsupported protocol all exit 1, never an empty success", async () => {
    const { FakeDaemon, STATUS, apiError, socketPath } = await import("./helpers.js");
    addAccount(env, "example");
    const fake = new FakeDaemon();
    await fake.listen(socketPath(env, "example"));
    try {
      const all = (reply: () => import("./helpers.js").Reply) => {
        fake.routes.clear();
        for (const m of ["GET", "PATCH", "POST"]) fake.route(`${m} /v1/*`, reply);
        fake.route("GET /v1/status", () => ({ body: STATUS }));
      };
      all(() => apiError(500, "internal", "Internal error in the daemon; see its log."));
      for (const argv of DAEMON_BACKED) {
        const r = await run(argv);
        expect(r.code, argv.join(" ")).toBe(1);
        expect(r.out, argv.join(" ")).toContain("code: internal");
      }
      all(() => ({ raw: "<html>" }));
      for (const argv of DAEMON_BACKED) {
        const r = await run(argv);
        expect(r.code, argv.join(" ")).toBe(1);
        expect(r.out, argv.join(" ")).toContain("code: bad_response");
      }
      fake.route("GET /v1/status", () => ({ body: { ...STATUS, protocol: 7 } }));
      for (const argv of DAEMON_BACKED) {
        const r = await run(argv);
        expect(r.code, argv.join(" ")).toBe(1);
        expect(r.out, argv.join(" ")).toContain("code: protocol_mismatch");
      }
    } finally {
      await fake.close();
    }
  });

  it("a follow stream the daemon closes is an error", async () => {
    const { FakeDaemon, socketPath } = await import("./helpers.js");
    addAccount(env, "example");
    const fake = new FakeDaemon();
    fake.route("GET /v1/events", () => ({ raw: "" }));
    // A stream that ends at once.
    fake.server.removeAllListeners("request");
    fake.server.on("request", (req, res) => {
      if (req.url?.startsWith("/v1/status")) {
        import("./helpers.js").then(({ STATUS }) => res.end(JSON.stringify(STATUS)));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end();
    });
    await fake.listen(socketPath(env, "example"));
    try {
      const r = await run(["events", "--follow"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("code: stream_closed");
    } finally {
      await fake.close();
    }
  });
});

describe("a daemon that does not answer", () => {
  it("times out with daemon_timeout", async () => {
    const { createServer } = await import("node:http");
    const { Daemon } = await import("../src/client.js");
    const { socketPath } = await import("./helpers.js");
    const sock = socketPath(env, "example");
    mkdirSync(join(sock, ".."), { recursive: true });
    const server = createServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => server.listen(sock, () => r()));
    try {
      await expect(new Daemon("example", sock, 200).status()).rejects.toMatchObject({ code: "daemon_timeout" });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
