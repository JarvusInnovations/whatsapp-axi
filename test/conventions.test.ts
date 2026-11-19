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
  ["operators", "add", "+15550100001", "--confirm"],
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
      expect(r.out, argv.join(" ")).toContain("code: DAEMON_NOT_RUNNING");
      expect(r.out, argv.join(" ")).toContain("whatsapp-axi daemon start example");
    }
  });

  it("doctor reports it as a failed check with the start command", async () => {
    addAccount(env, "example");
    const r = await run(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Run `whatsapp-axi daemon install example` to fix daemon of example");
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
    expect(r.out).toContain("code: NO_ACCOUNT");
    expect(r.out).toContain("account add gamma");
    r = await run(["chats", "--account", "+15550100001"]);
    expect(r.code).toBe(2);
  });
});

describe("usage errors", () => {
  it("every command rejects an unknown flag by name, listing its valid flags", async () => {
    addAccount(env, "example");
    // `session-start` is what the hook runs: it never fails and never prints an error (tested in setup.test.ts).
    for (const spec of SPECS.filter((s) => s.name !== "session-start")) {
      const argv = [...spec.name.split(" "), ...spec.positionals.filter((p) => p.required).map(() => "x"), "--bogus"];
      const r = await run(argv);
      expect(r.code, spec.name).toBe(2);
      expect(r.out, spec.name).toContain("unknown flag --bogus");
      expect(r.out, spec.name).toMatch(new RegExp(`(valid flags for|\`${spec.name}\` takes no flags of its own)`));
      expect(r.out, spec.name).toContain("code: UNKNOWN_FLAG");
      expect(r.out, spec.name).toContain("--account and --tz always allowed");
    }
  });

  it("names the guessed flags: --json, -n, and --json-out where a command has none", async () => {
    addAccount(env, "example");
    let r = await run(["chats", "--json"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("code: UNKNOWN_FLAG");
    expect(r.out).toContain("add --json-out");
    r = await run(["chats", "-n", "5"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("use --limit");
    r = await run(["accounts", "--json-out"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("`accounts` writes no JSON file; --json-out works on");
    r = await run(["send", "x", "y", "--force"]);
    expect(r.out).toContain("--confirm");
  });

  it("--json-out in the space form is a usage error naming the = form", async () => {
    addAccount(env, "example");
    const r = await run(["chats", "--json-out", "out.txt"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("code: USAGE");
    expect(r.out).toContain("--json-out=out.txt");
  });

  it("missing values, missing arguments and extra arguments exit 2", async () => {
    addAccount(env, "example");
    const cases = [
      ["events", "--after"],
      ["events", "--limit", "--follow"],
      ["read"],
      ["chat", "view"],
      ["chats", "extra"],
      ["scope"],
      ["account", "add"],
      ["chats", "--account"],
      ["chats", "--account", "a", "--account", "b"],
      ["chats", "--limit", "1", "--limit", "2"],
      ["-x"],
    ];
    for (const argv of cases) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out, argv.join(" ")).toContain("code: USAGE");
    }
  });

  it("bad values, contradictions and unknown subcommands are VALIDATION_ERROR, exit 2", async () => {
    addAccount(env, "example");
    const cases = [
      ["scope", "nope"],
      ["bogus"],
      ["events", "--kind", "bogus"],
      ["events", "--limit", "abc"],
      ["chats", "--fields", "nope"],
      ["auth", "link", "--phone", "+15550100000", "--qr"],
      ["mark-read", "x/y", "--chat", "x"],
      ["chats", "--tz", "Mars/Olympus"],
      ["chats", "--account", "Not Valid"],
    ];
    for (const argv of cases) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out, argv.join(" ")).toContain("code: VALIDATION_ERROR");
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

  it("names the missing platform package and how to build from source; a checkout is told to build", () => {
    const missing = (lookup: Parameters<typeof findDaemon>[0]) => {
      try {
        findDaemon(lookup);
      } catch (err) {
        return err as { message: string; code: string; suggestions: string[] };
      }
      throw new Error("expected DAEMON_BINARY_MISSING");
    };
    const installed = missing({ env: {}, root: join(env.home, "installed"), resolvePackage: () => undefined, platform: "darwin", arch: "arm64" });
    expect(installed.code).toBe("DAEMON_BINARY_MISSING");
    expect(installed.message).toContain("the platform package whatsapp-axi-darwin-arm64 is not installed");
    expect(installed.suggestions[0]).toBe("Run `npm install -g whatsapp-axi` to reinstall it with its optional dependency whatsapp-axi-darwin-arm64");
    expect(installed.suggestions[1]).toContain("`bun run build:daemon`");
    expect(installed.suggestions[1]).toContain("https://github.com/JarvusInnovations/whatsapp-axi");

    const other = missing({ env: {}, root: undefined, resolvePackage: () => undefined, platform: "win32", arch: "x64" });
    expect(other.message).toContain("no platform package exists for win32-x64");
    expect(other.suggestions.join(" ")).not.toContain("npm install");

    const checkout = join(env.home, "unbuilt");
    mkdirSync(join(checkout, "daemon"), { recursive: true });
    writeFileSync(join(checkout, "daemon", "go.mod"), "module example\n");
    const unbuilt = missing({ env: {}, root: checkout, resolvePackage: () => undefined, platform: "linux", arch: "x64" });
    expect(unbuilt.message).toContain("this source checkout has not built one");
    expect(unbuilt.suggestions).toEqual(["Run `bun run build:daemon` in the checkout to build daemon/bin/whatsapp-axid"]);
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
      all(() => apiError(500, "INTERNAL_ERROR", "Internal error in the daemon; see its log."));
      for (const argv of DAEMON_BACKED) {
        const r = await run(argv);
        expect(r.code, argv.join(" ")).toBe(1);
        expect(r.out, argv.join(" ")).toContain("code: INTERNAL_ERROR");
      }
      all(() => ({ raw: "<html>" }));
      for (const argv of DAEMON_BACKED) {
        const r = await run(argv);
        expect(r.code, argv.join(" ")).toBe(1);
        expect(r.out, argv.join(" ")).toContain("code: UNEXPECTED_RESPONSE");
      }
      fake.route("GET /v1/status", () => ({ body: { ...STATUS, protocol: 7 } }));
      for (const argv of DAEMON_BACKED) {
        const r = await run(argv);
        expect(r.code, argv.join(" ")).toBe(1);
        expect(r.out, argv.join(" ")).toContain("code: PROTOCOL_MISMATCH");
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
      expect(r.out).toContain("code: STREAM_CLOSED");
    } finally {
      await fake.close();
    }
  });
});

describe("a daemon that does not answer", () => {
  it("times out with TIMEOUT, naming the variable that extends the deadline", async () => {
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
      const err = (await new Daemon("example", sock, 200).status().catch((e) => e)) as { code: string; suggestions: string[] };
      expect(err.code).toBe("TIMEOUT");
      expect(err.suggestions.join(" ")).toContain("WHATSAPP_AXI_TIMEOUT_MS");
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe("output vocabulary", () => {
  it("an empty events result echoes its filters", async () => {
    const { FakeDaemon, socketPath } = await import("./helpers.js");
    addAccount(env, "example");
    const fake = new FakeDaemon();
    fake.route("GET /v1/events", () => ({ body: { events: [], latest_seq: 412 } }));
    await fake.listen(socketPath(env, "example"));
    try {
      const r = await run(["events", "--after", "412", "--chat", GROUP, "--kind", "message"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`events: 0 events after seq 412 in ${GROUP} of kind message`);
      expect(r.out).toContain(`--follow --chat ${GROUP} --kind message`);
    } finally {
      await fake.close();
    }
  });

  it("times are shown in the --tz zone with their offset, named once; a read honours WHATSAPP_AXI_TIMEOUT_MS", async () => {
    const { FakeDaemon, socketPath } = await import("./helpers.js");
    addAccount(env, "example");
    const fake = new FakeDaemon();
    fake.route("GET /v1/messages", () => ({
      body: {
        chat: { id: GROUP, type: "group", name: "x" },
        messages: [{ id: "3EB0AAAA0000000001", t: "2030-07-05T14:00:00Z", from: { id: "1@lid", name: "Sam" }, text: "hi" }],
        more: false,
      },
    }));
    await fake.listen(socketPath(env, "example"));
    try {
      let r = await run(["read", GROUP, "--tz", "Europe/Berlin"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("tz: Europe/Berlin");
      expect(r.out).toContain("2030-07-05T16:00:00+02:00");
      expect(r.out.match(/tz:/g)).toHaveLength(1);
      fake.route("GET /v1/messages", () => ({ hang: true }));
      const t0 = Date.now();
      r = await run(["read", GROUP], { env: { WHATSAPP_AXI_TIMEOUT_MS: "200" } });
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(r.code).toBe(1);
      expect(r.out).toContain("code: TIMEOUT");
      expect(r.out).toContain("WHATSAPP_AXI_TIMEOUT_MS");
    } finally {
      await fake.close();
    }
  });

  it("update is shadowed: it names daemon upgrade when daemons are installed", async () => {
    const { setUpdater } = await import("../src/commands/update.js");
    addAccount(env, "example");
    const units = join(env.home, "config", "systemd", "user", "default.target.wants");
    mkdirSync(units, { recursive: true });
    writeFileSync(join(units, "whatsapp-axi@example.service"), "");
    setUpdater(async () => ({ update: "whatsapp-axi upgraded to 9.9.9" }));
    try {
      let r = await run(["update"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("still run the old daemon binary");
      expect(r.out).toContain("Run `whatsapp-axi daemon upgrade`");
      setUpdater(async () => {
        throw new Error("registry unreachable");
      });
      r = await run(["update"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("code: UPSTREAM_ERROR");
      // A failed upgrade comes after the registry named a version, so its npm hint is kept.
      const { AxiError } = await import("axi-sdk-js");
      setUpdater(async () => {
        throw new AxiError("Failed to upgrade whatsapp-axi", "UPDATE_ERROR", ["Run `npm install -g whatsapp-axi@latest` manually"]);
      });
      r = await run(["update"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("npm install -g whatsapp-axi@latest");
    } finally {
      const { runUpdate } = await import("axi-sdk-js");
      setUpdater(runUpdate as never);
    }
  });

  it("only one module imports the TOON encoder", async () => {
    const { readdirSync } = await import("node:fs");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const src = join(import.meta.dirname, "..", "src");
    const importers = walk(src).filter((f) => f.endsWith(".ts") && readFileSync(f, "utf-8").includes("@toon-format/toon"));
    expect(importers.map((f) => f.slice(src.length + 1))).toEqual(["output/toon.ts"]);
  });
});
