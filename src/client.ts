// The socket client (specs/socket-protocol.md): HTTP/1.1 with JSON over the account's Unix socket.
// Every failure becomes a structured error; nothing here ever turns a failed read into an empty one.
import { request } from "node:http";
import { failure } from "./errors.js";
import { accountPaths, roots } from "./paths.js";
import { VERSION } from "./version.js";

export const PROTOCOL = 1;

/** Fix commands named in errors: the service start (daemon start says how to install it). */
export function startCommand(account: string): string {
  return `whatsapp-axi daemon start ${account}`;
}

const REQUEST_TIMEOUT_MS = 30_000;

export interface Status {
  protocol: number;
  account: string;
  state: string;
  since: string;
  reason: string;
  me: { id: string; lid?: string; pn?: string } | null;
  daemon_version: string;
  library_version: string;
  last_phone_activity: string | null;
  last_phone_activity_approximate: boolean;
  counts: { chats: number; messages: number; discarded: number; last_seq: number };
}

type Json = Record<string, unknown>;

function notRunning(account: string) {
  return failure(`The daemon of account ${account} is not running.`, "daemon_not_running", [
    `Run \`${startCommand(account)}\` to start it (\`whatsapp-axi daemon install ${account}\` first if it is not installed as a service)`,
  ]);
}

function badResponse(account: string, what: string) {
  return failure(`The daemon of account ${account} gave an answer that could not be read (${what}).`, "bad_response", [
    `Run \`whatsapp-axi doctor --account ${account}\` to check the daemon`,
  ]);
}

function helpForCode(account: string, code: string, body: Json): string[] {
  switch (code) {
    case "not_found":
      return [`Run \`whatsapp-axi chats --account ${account}\` to see the kept chats`];
    case "ambiguous": {
      const c = Array.isArray(body.candidates) ? (body.candidates as unknown[]).map(String) : [];
      return c.length ? [`Use one of: ${c.join(", ")}`] : [];
    }
    case "not_connected":
      return [`Run \`whatsapp-axi doctor --account ${account}\` to see the account's state`];
    case "not_linked":
      return [`Run \`whatsapp-axi auth link --phone <number> --account ${account}\` to link the account`];
    case "first_contact":
      return ["Nothing has been received from or sent to this chat. Add --first-contact if you mean to message it for the first time"];
    case "rate_limited": {
      const s = typeof body.retry_after_seconds === "number" ? body.retry_after_seconds : undefined;
      return [`Wait${s ? ` ${s} seconds` : ""} and try again; the limits are \`send.per_minute\` and \`send.per_hour\` (\`whatsapp-axi settings show --account ${account}\`)`];
    }
    case "duplicate_text":
      return ["The same text went to too many chats in ten minutes (`send.same_text_chats`); vary the text or wait"];
    case "not_downloadable":
      return ["The media cannot be fetched: it is missing, view-once, or expired on WhatsApp's servers"];
    case "link_in_progress":
      return ["Wait for the running link attempt to end (it lasts at most about three minutes)"];
    case "internal":
      return [`Check the daemon's log; run \`whatsapp-axi doctor --account ${account}\``];
    default:
      return [];
  }
}

function connError(account: string, err: NodeJS.ErrnoException) {
  if (["ENOENT", "ECONNREFUSED", "ENOTSOCK", "ECONNRESET", "EPIPE"].includes(err.code ?? "")) return notRunning(account);
  return failure(`Cannot reach the daemon of account ${account} (${err.code ?? err.message}).`, "daemon_unreachable", [
    `Run \`whatsapp-axi doctor --account ${account}\``,
  ]);
}

export class Daemon {
  readonly account: string;
  readonly socket: string;
  private checked: Status | undefined;

  private readonly timeoutMs: number;

  constructor(account: string, socket = accountPaths(account, roots()).socket, timeoutMs = REQUEST_TIMEOUT_MS) {
    this.account = account;
    this.socket = socket;
    this.timeoutMs = timeoutMs;
  }

  private raw(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          socketPath: this.socket,
          path,
          method,
          headers: {
            "User-Agent": `whatsapp-axi/${VERSION}`,
            Accept: "application/json",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", (e) => reject(connError(this.account, e)));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            let json: unknown;
            try {
              json = JSON.parse(text);
            } catch {
              reject(badResponse(this.account, "not JSON"));
              return;
            }
            if (typeof json !== "object" || json === null || Array.isArray(json)) {
              reject(badResponse(this.account, "not a JSON object"));
              return;
            }
            resolve({ status: res.statusCode ?? 0, json: json as Json });
          });
        },
      );
      req.on("timeout", () => {
        req.destroy();
        reject(failure(`The daemon of account ${this.account} did not answer in time.`, "daemon_timeout", [`Run \`whatsapp-axi doctor --account ${this.account}\``]));
      });
      req.on("error", (e: NodeJS.ErrnoException) => reject(connError(this.account, e)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  private fail(status: number, json: Json): never {
    const e = json.error as Json | undefined;
    if (!e || typeof e.code !== "string" || typeof e.message !== "string") throw badResponse(this.account, `status ${status} without an error body`);
    const help = helpForCode(this.account, e.code, e);
    throw failure(e.message, e.code, help);
  }

  /** GET /v1/status, with the protocol check. */
  async status(): Promise<Status> {
    const { status, json } = await this.raw("GET", "/v1/status");
    if (status !== 200) this.fail(status, json);
    const s = json as unknown as Status;
    if (typeof s.protocol !== "number" || typeof s.state !== "string" || typeof s.counts !== "object" || s.counts === null) {
      throw badResponse(this.account, "status is missing fields");
    }
    if (s.protocol !== PROTOCOL) {
      throw failure(
        `The daemon of account ${this.account} speaks protocol ${s.protocol} (daemon ${s.daemon_version}); this CLI (${VERSION}) speaks protocol ${PROTOCOL}.`,
        "protocol_mismatch",
        [s.protocol > PROTOCOL ? "Upgrade the CLI: npm install -g whatsapp-axi@latest" : "Upgrade the daemon to the version that came with this CLI, then restart it"],
      );
    }
    this.checked = s;
    return s;
  }

  /** A JSON request; the protocol is checked once first. */
  async call(method: string, path: string, body?: unknown): Promise<Json> {
    if (!this.checked) await this.status();
    const { status, json } = await this.raw(method, path, body);
    if (status < 200 || status > 299) this.fail(status, json);
    return json;
  }

  /**
   * A streaming request: yields one parsed object per line until the stream or signal ends. A
   * stream the daemon closes is an error unless `endOk` (a stream with a final line, like link).
   */
  async *stream(path: string, signal?: AbortSignal, opts: { method?: string; body?: unknown; endOk?: boolean } = {}): AsyncGenerator<Json> {
    if (!this.checked) await this.status();
    const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          path,
          method: opts.method ?? "GET",
          headers: {
            "User-Agent": `whatsapp-axi/${VERSION}`,
            ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          },
          signal,
        },
        resolve,
      );
      req.on("error", (e: NodeJS.ErrnoException) => (e.name === "AbortError" ? resolve(null as never) : reject(connError(this.account, e))));
      if (payload) req.write(payload);
      req.end();
    });
    if (!res) return;
    if (res.statusCode !== 200) {
      const chunks: Buffer[] = [];
      for await (const c of res) chunks.push(c as Buffer);
      let json: Json;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        throw badResponse(this.account, "not JSON");
      }
      this.fail(res.statusCode ?? 0, json);
    }
    let buf = "";
    try {
      for await (const chunk of res) {
        buf += (chunk as Buffer).toString("utf-8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let obj: unknown;
          try {
            obj = JSON.parse(line);
          } catch {
            throw badResponse(this.account, "a stream line is not JSON");
          }
          yield obj as Json;
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError" || signal?.aborted) return;
      throw err;
    }
    if (buf.trim() && !signal?.aborted) throw badResponse(this.account, "a stream line is not JSON");
    if (!signal?.aborted && !opts.endOk) {
      throw failure(`The daemon of account ${this.account} closed the stream.`, "stream_closed", [`Run \`whatsapp-axi doctor --account ${this.account}\``]);
    }
  }
}

/** Fails as bad_response unless cond holds. */
export function expect(daemon: Daemon, cond: unknown, what: string): asserts cond {
  if (!cond) throw badResponse(daemon.account, what);
}
