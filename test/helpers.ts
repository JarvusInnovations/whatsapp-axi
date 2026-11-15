// Test helpers: private XDG directories, a fake daemon that speaks the socket protocol over a real
// Unix socket, and a runner that captures the CLI's output and exit code.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { defaultCtx, setServiceFactory } from "../src/context.js";
import type { CommandResult, ServiceManager, UnitState } from "../src/service.js";

/**
 * A fake systemd user manager: records every call, keeps unit states, and creates and removes the
 * enablement links under the test's unit directory as `systemctl --user enable|disable` would.
 * Tests never reach the real service manager.
 */
export class FakeService implements ServiceManager {
  linger: boolean | undefined = true;
  isSupported = true;
  calls: string[][] = [];
  states = new Map<string, UnitState>();
  logLines: string[] = [];
  logResult: CommandResult = { code: 0, stdout: "", stderr: "" };
  failVerb: string | undefined;

  constructor(private readonly unitDir: string) {}

  supported(): boolean {
    return this.isSupported;
  }

  user(): string {
    return "tester";
  }

  async lingering(): Promise<boolean | undefined> {
    return this.linger;
  }

  private set(unit: string, active: boolean): void {
    const prev = this.states.get(unit);
    this.states.set(unit, { active: active ? "active" : "inactive", sub: active ? "running" : "dead", enabled: prev?.enabled ?? "", since: active ? "2030-01-05 14:00:00 UTC" : null, pid: active ? 4242 : null });
  }

  async systemctl(args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    const verb = args[0];
    if (verb === this.failVerb) return { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found\n" };
    const unit = args[args.length - 1];
    const wants = join(this.unitDir, "default.target.wants");
    switch (verb) {
      case "enable":
        mkdirSync(wants, { recursive: true });
        writeFileSync(join(wants, unit), "");
        if (args.includes("--now")) this.set(unit, true);
        this.states.set(unit, { ...this.states.get(unit)!, enabled: "enabled" });
        break;
      case "disable":
        rmSync(join(wants, unit), { force: true });
        if (args.includes("--now")) this.set(unit, false);
        this.states.set(unit, { ...this.states.get(unit)!, enabled: "disabled" });
        break;
      case "start":
      case "restart":
        this.set(unit, true);
        break;
      case "stop":
        this.set(unit, false);
        break;
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  async show(unit: string): Promise<UnitState> {
    return this.states.get(unit) ?? { active: "inactive", sub: "dead", enabled: "", since: null, pid: null };
  }

  async logs(_unit: string, lines: number, _follow: boolean, line: (s: string) => void): Promise<CommandResult> {
    for (const l of this.logLines.slice(-lines)) line(l);
    return this.logResult;
  }

  verbs(): string[] {
    return this.calls.map((c) => c.join(" "));
  }
}

/** The fake service manager of the current test environment. */
export let service: FakeService;

export interface Env {
  home: string;
  runtime: string;
  cleanup(): void;
}

const VARS = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "WHATSAPP_AXI_DAEMON"];

export function makeEnv(): Env {
  const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  const home = mkdtempSync(join(tmpdir(), "wa-cli-home-"));
  // Short, so the socket path fits sun_path.
  const runtime = mkdtempSync("/tmp/wr");
  chmodSync(runtime, 0o700);
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.XDG_STATE_HOME = join(home, "state");
  process.env.XDG_DATA_HOME = join(home, "data");
  process.env.XDG_RUNTIME_DIR = runtime;
  delete process.env.WHATSAPP_AXI_DAEMON;
  service = new FakeService(join(home, "config", "systemd", "user"));
  setServiceFactory(() => service);
  return {
    home,
    runtime,
    cleanup() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    },
  };
}

/** Creates an account's files the way `whatsapp-axid init` does. */
export function addAccount(env: Env, name: string): void {
  const cfg = join(env.home, "config", "whatsapp-axi");
  const st = join(env.home, "state", "whatsapp-axi");
  mkdirSync(join(cfg, name), { recursive: true, mode: 0o700 });
  mkdirSync(join(st, name, "media"), { recursive: true, mode: 0o700 });
  for (const d of [cfg, st, join(cfg, name), join(st, name)]) chmodSync(d, 0o700);
  writeFileSync(join(cfg, name, "settings.json"), "{}\n", { mode: 0o600 });
}

export function socketPath(env: Env, name: string): string {
  return join(env.runtime, "whatsapp-axi", `${name}.sock`);
}

export interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
  /** For streams: lines to send, then keep the connection open until the client goes. */
  lines?: unknown[];
  /** For streams: end the response after the lines (a stream with a final line). */
  end?: boolean;
}

export type Route = (req: { method: string; path: string; query: URLSearchParams; body: unknown }) => Reply;

export interface Seen {
  method: string;
  path: string;
  query: string;
  body: unknown;
  userAgent: string | undefined;
}

export const STATUS = {
  protocol: 1,
  account: "example",
  state: "connected",
  since: "2030-01-05T14:00:00Z",
  reason: "",
  me: { id: "100000000000000@lid", lid: "100000000000000@lid", pn: "+15550100000", name: "", me: true, operator: false },
  daemon_version: "0.1.0",
  library_version: "v0.0.0-test",
  last_phone_activity: "2030-01-05T13:00:00Z",
  last_phone_activity_approximate: true,
  counts: { chats: 1, messages: 2, discarded: 3, last_seq: 7 },
};

export const SETTINGS = {
  scope: "tagged",
  dm_from: "operators",
  chats: {},
  operators: [] as string[],
  parent_buffer: true,
  wake_file: null as string | null,
  retain_days: null as number | null,
  presence: true,
  read_receipts: "on-read",
  send: { first_contact: "refuse", per_hour: 60, per_minute: 10, same_text_chats: 3, max_file_mb: 64 },
};

export function apiError(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Reply {
  return { status, body: { error: { code, message, ...extra } } };
}

export class FakeDaemon {
  server: Server;
  routes = new Map<string, Route>();
  seen: Seen[] = [];
  settings = structuredClone(SETTINGS);

  constructor() {
    this.server = createServer((req, res) => this.handle(req, res));
    this.route("GET /v1/status", () => ({ body: STATUS }));
    this.route("GET /v1/settings", () => ({ body: { settings: this.settings, effective_retain_days: 90 } }));
    this.route("PATCH /v1/settings", ({ body }) => {
      const before = JSON.stringify(this.settings);
      const patch = body as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (k === "chats" || k === "send") {
          const target = (this.settings as Record<string, Record<string, unknown>>)[k];
          for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
            if (cv === null) delete target[ck];
            else target[ck] = cv;
          }
        } else (this.settings as Record<string, unknown>)[k] = v;
      }
      return { body: { settings: this.settings, effective_retain_days: 90, changed: JSON.stringify(this.settings) !== before } };
    });
  }

  route(key: string, fn: Route): this {
    this.routes.set(key, fn);
    return this;
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const text = Buffer.concat(chunks).toString();
      const body = text ? JSON.parse(text) : undefined;
      this.seen.push({ method: req.method ?? "", path: url.pathname, query: url.search, body, userAgent: req.headers["user-agent"] });
      let fn = this.routes.get(`${req.method} ${url.pathname}`);
      if (!fn) {
        for (const [k, f] of this.routes) {
          const [m, p] = k.split(" ");
          if (m === req.method && p.endsWith("*") && url.pathname.startsWith(p.slice(0, -1))) fn = f;
        }
      }
      const reply = fn ? fn({ method: req.method ?? "", path: url.pathname, query: url.searchParams, body }) : apiError(400, "bad_request", "Unknown request.");
      if (reply.lines) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        for (const l of reply.lines) res.write(JSON.stringify(l) + "\n");
        if (reply.end) res.end();
        return;
      }
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  }

  listen(path: string): Promise<void> {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    return new Promise((resolve) => this.server.listen(path, () => resolve()));
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export interface Result {
  out: string;
  code: number;
}

/** Runs the CLI in-process and captures stdout and the exit code. */
export async function run(argv: string[]): Promise<Result> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
  try {
    await main(argv, defaultCtx);
  } finally {
    process.stdout.write = write;
  }
  const code = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = undefined;
  return { out: chunks.join(""), code };
}
