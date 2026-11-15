// The socket client (specs/socket-protocol.md): HTTP/1.1 with JSON over the account's Unix socket.
// Every failure becomes a structured error; nothing here ever turns a failed read into an empty one.
import { request } from "node:http";
import { ToolError, failure } from "./errors.js";
import { appendLine, output } from "./output/jsonout.js";
import { VERSION } from "./version.js";

export const PROTOCOL = 1;

/** The daemon's send timeout when its status does not say (core.SendTimeout). */
export const DEFAULT_SEND_TIMEOUT_S = 600;
/** How much longer than the daemon the CLI waits for a send, so the daemon answers first. */
export const SEND_MARGIN_MS = 30_000;

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
  send_timeout_seconds?: number;
}

type Json = Record<string, unknown>;

/** The fix command named when a daemon is not running. */
export function startCommand(account: string): string {
  return `whatsapp-axi daemon start ${account}`;
}

/** A send's retry command with its id, filled in by the send command. */
export interface SendContext {
  chat?: string;
  /** The full command to run again with the same --id. */
  retry?: string;
  id?: string;
}

export class Daemon {
  readonly account: string;
  readonly socket: string;
  /** " --account <name>" when the user has several accounts, for hints. */
  readonly af: string;
  private checked: Status | undefined;
  private readonly timeoutMs: number;
  /** Whether the timeout is the read deadline (named in TIMEOUT), or a probe's short budget. */
  private readonly readDeadline: boolean;
  /** Added to the daemon's send timeout (tests shorten it). */
  sendMarginMs = SEND_MARGIN_MS;

  constructor(account: string, socket: string, timeoutMs = 30_000, af = "", readDeadline = true) {
    this.account = account;
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.af = af;
    this.readDeadline = readDeadline;
  }

  private doctor(): string {
    return `Run \`whatsapp-axi doctor${this.af}\` to check the daemon`;
  }

  notRunning(): ToolError {
    return failure(`The daemon of account ${this.account} is not running.`, "DAEMON_NOT_RUNNING", [
      `Run \`${startCommand(this.account)}\` to start it as a service`,
      `Run \`whatsapp-axi daemon run ${this.account}\` to run it in the foreground instead`,
    ]);
  }

  badResponse(what: string): ToolError {
    return failure(`The daemon of account ${this.account} gave an answer that could not be used (${what}).`, "UNEXPECTED_RESPONSE", [this.doctor()]);
  }

  private connError(err: NodeJS.ErrnoException): ToolError {
    if (["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(err.code ?? "")) return this.notRunning();
    return failure(`Cannot reach the daemon of account ${this.account} (${err.code ?? err.message}).`, "DAEMON_UNREACHABLE", [this.doctor()]);
  }

  private outcomeHelp(s: SendContext): string[] {
    const chat = s.chat ?? "<chat>";
    const help = [`Run \`whatsapp-axi read ${chat}${this.af}\` to check whether it went out before sending again`];
    if (s.retry) help.push(`Run \`${s.retry}\` to retry safely: a send with the same --id is never sent twice`);
    return help;
  }

  /** A send the CLI stopped waiting for: it may have gone out. */
  private outcomeUnknown(s: SendContext, why: string): ToolError {
    const id = s.id ? ` (id ${s.id})` : "";
    return failure(`The daemon of account ${this.account} did not answer the send${id} (${why}); it may have gone out.`, "OUTCOME_UNKNOWN", this.outcomeHelp(s));
  }

  private helpForCode(code: string, body: Json, send?: SendContext): string[] {
    const af = this.af;
    switch (code) {
      case "NOT_FOUND":
        return [`Run \`whatsapp-axi chats${af}\` to see the kept chats`];
      case "AMBIGUOUS": {
        const c = Array.isArray(body.candidates) ? (body.candidates as unknown[]).map(String) : [];
        return c.length ? c.map((x) => `Use ${x}`) : [];
      }
      case "NOT_CONNECTED":
        return [`Run \`whatsapp-axi doctor${af}\` to see the account's state`];
      case "NOT_LINKED":
        return [`Run \`whatsapp-axi auth link --phone <number>${af}\` to link the account`];
      case "FIRST_CONTACT":
        return send?.retry
          ? [`Run \`${send.retry.replace(/ --id \S+/, "")} --first-contact\` if you mean to message this chat for the first time`]
          : ["Add --first-contact if you mean to message this chat for the first time"];
      case "RATE_LIMITED": {
        const s = typeof body.retry_after_seconds === "number" ? body.retry_after_seconds : undefined;
        return [`Wait${s ? ` ${s} seconds` : ""} and run the same command again`, `Run \`whatsapp-axi settings show${af}\` to see the limits (send.per_minute, send.per_hour)`];
      }
      case "DUPLICATE_TEXT":
        return ["The same text went to too many chats in ten minutes (send.same_text_chats): vary the text or wait", `Run \`whatsapp-axi settings show${af}\` to see the limit`];
      case "NOT_DOWNLOADABLE":
        return ["The media cannot be fetched: it is missing, view-once, or expired on WhatsApp's servers"];
      case "OUTCOME_UNKNOWN":
        return this.outcomeHelp(send ?? {});
      case "LINK_IN_PROGRESS":
        return ["Wait for the running link attempt to end (at most about three minutes), then run it again"];
      case "INTERNAL_ERROR":
      case "UPSTREAM_ERROR":
        return [`Run \`whatsapp-axi daemon logs ${this.account}\` to see the daemon's log`, this.doctor()];
      default:
        return [];
    }
  }

  private raw(method: string, path: string, body?: unknown, send?: SendContext & { timeoutMs: number }): Promise<{ status: number; json: Json }> {
    return new Promise((resolve, reject) => {
      let written = false;
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
          timeout: send ? send.timeoutMs : this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", (e) => reject(send ? this.outcomeUnknown(send, "the answer was cut off") : this.connError(e)));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            let json: unknown;
            try {
              json = JSON.parse(text);
            } catch {
              reject(send && res.statusCode === 200 ? this.outcomeUnknown(send, "the answer could not be read") : this.badResponse("not JSON"));
              return;
            }
            if (typeof json !== "object" || json === null || Array.isArray(json)) {
              reject(this.badResponse("not a JSON object"));
              return;
            }
            resolve({ status: res.statusCode ?? 0, json: json as Json });
          });
        },
      );
      req.on("timeout", () => {
        req.destroy();
        if (send) reject(this.outcomeUnknown(send, `no answer in ${Math.round(send.timeoutMs / 1000)} s`));
        else {
          const s = Math.round(this.timeoutMs / 100) / 10;
          reject(
            failure(
              `The daemon of account ${this.account} did not answer in ${s} s; the outcome of the read is unknown.`,
              "TIMEOUT",
              this.readDeadline
                ? ["Run the same command again to retry the read", `Set WHATSAPP_AXI_TIMEOUT_MS to wait longer (now ${this.timeoutMs})`, this.doctor()]
                : [this.doctor()],
            ),
          );
        }
      });
      req.on("error", (e: NodeJS.ErrnoException) => {
        // A send whose request reached the daemon and then lost its connection may have gone out.
        if (send && written && ["ECONNRESET", "EPIPE"].includes(e.code ?? "")) reject(this.outcomeUnknown(send, "the connection was lost"));
        else if (!send && ["ECONNRESET", "EPIPE"].includes(e.code ?? "")) reject(this.notRunning());
        else reject(this.connError(e));
      });
      req.on("finish", () => {
        written = true;
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  private fail(status: number, json: Json, send?: SendContext): never {
    const e = json.error as Json | undefined;
    if (!e || typeof e.code !== "string" || typeof e.message !== "string") throw this.badResponse(`status ${status} without an error body`);
    let message = e.message;
    if (e.code === "OUTCOME_UNKNOWN" && send?.id) message = `${message} (id ${send.id})`;
    const err = new ToolError(message, e.code, this.helpForCode(e.code, e, send));
    err.details = e;
    output.daemonError = e;
    throw err;
  }

  /** GET /v1/status, with the protocol check. */
  async status(): Promise<Status> {
    const { status, json } = await this.raw("GET", "/v1/status");
    if (status !== 200) this.fail(status, json);
    const s = json as unknown as Status;
    if (typeof s.protocol !== "number" || typeof s.state !== "string" || typeof s.counts !== "object" || s.counts === null) {
      throw this.badResponse("status is missing fields");
    }
    if (s.protocol !== PROTOCOL) {
      throw failure(
        `The daemon of account ${this.account} speaks protocol ${s.protocol} (daemon ${s.daemon_version}); this CLI (${VERSION}) speaks protocol ${PROTOCOL}.`,
        "PROTOCOL_MISMATCH",
        s.protocol > PROTOCOL
          ? ["Run `whatsapp-axi daemon upgrade` to replace the daemon with the one that came with this CLI (or use the CLI that came with the running daemon)"]
          : ["Run `whatsapp-axi daemon upgrade` to install the daemon that came with this CLI and restart it"],
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
    output.body = json;
    return json;
  }

  /** How long a send is waited for: the daemon's send timeout plus the margin, never less than a plain request. */
  sendTimeoutMs(st: Pick<Status, "send_timeout_seconds">): number {
    const daemonS = typeof st.send_timeout_seconds === "number" && st.send_timeout_seconds > 0 ? st.send_timeout_seconds : DEFAULT_SEND_TIMEOUT_S;
    return Math.max(this.timeoutMs, daemonS * 1000 + this.sendMarginMs);
  }

  /**
   * A send, a file or a reaction: waits as long as the daemon's own send timeout allows, plus a
   * margin, never less. When the CLI stops waiting the outcome is unknown, never a plain failure.
   */
  async send(path: string, body: Json, ctx: SendContext = {}): Promise<Json> {
    const st = this.checked ?? (await this.status());
    const { status, json } = await this.raw("POST", path, body, { ...ctx, timeoutMs: this.sendTimeoutMs(st) });
    if (status < 200 || status > 299) this.fail(status, json, ctx);
    output.body = json;
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
      req.on("error", (e: NodeJS.ErrnoException) => (e.name === "AbortError" ? resolve(null as never) : reject(this.connError(e))));
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
        throw this.badResponse("not JSON");
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
            throw this.badResponse("a stream line is not JSON");
          }
          appendLine(obj);
          yield obj as Json;
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError" || signal?.aborted) return;
      throw err;
    }
    if (buf.trim() && !signal?.aborted) throw this.badResponse("a stream line is not JSON");
    if (!signal?.aborted && !opts.endOk) {
      throw failure(`The daemon of account ${this.account} closed the stream before its end.`, "STREAM_CLOSED", [this.doctor()]);
    }
  }
}

/** Fails as UNEXPECTED_RESPONSE unless cond holds. */
export function expect(daemon: Daemon, cond: unknown, what: string): asserts cond {
  if (!cond) throw daemon.badResponse(what);
}
