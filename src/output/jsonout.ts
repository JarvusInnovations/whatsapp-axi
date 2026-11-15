// --json-out[=path] (specs/cli.md "Conventions"): standard output stays TOON; the daemon's
// complete response body is also written to a file. The client records what it received here;
// the dispatcher in cli.ts opens the file before the command runs and writes it afterwards.
import { closeSync, constants, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failure, usage } from "./errors.js";

type Obj = Record<string, unknown>;

export interface JsonOut {
  path: string;
  fd: number;
  /** Lines appended so far by a stream. */
  lines: number;
}

export const output = {
  /** The open --json-out file of the current command, if any. */
  file: undefined as JsonOut | undefined,
  /** The body of the last successful daemon call of the current command. */
  body: undefined as Obj | undefined,
  /** The `error` object of the daemon's last error answer, exactly as sent. */
  daemonError: undefined as Obj | undefined,
};

export function resetOutput(): void {
  output.file = undefined;
  output.body = undefined;
  output.daemonError = undefined;
}

/**
 * Takes `--json-out[=path]` out of the arguments before `--`. Returns the remaining arguments and
 * the path: `""` for a bare flag (auto path), undefined when the flag is absent.
 */
export function takeJsonOut(args: string[]): { args: string[]; path: string | undefined } {
  const dd = args.indexOf("--");
  const head = dd < 0 ? args : args.slice(0, dd);
  const tail = dd < 0 ? [] : args.slice(dd);
  let path: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === "--json-out") {
      const next = head[i + 1];
      if (next !== undefined && !next.startsWith("-") && next.endsWith(".json")) {
        throw usage(`--json-out takes its path only with =; ${JSON.stringify(next)} was not taken as the path`, [`Write \`--json-out=${next}\``]);
      }
      path = "";
    } else if (a.startsWith("--json-out=")) {
      const v = a.slice("--json-out=".length);
      if (!v) throw usage("--json-out= needs a path", ["Write `--json-out=<path>`, or a bare `--json-out` for a file in the temp directory"]);
      path = v;
    } else rest.push(a);
  }
  return { args: [...rest, ...tail], path };
}

/** Opens the file: owner-only, created or truncated, never through a symlink. */
export function openJsonOut(path: string, command: string): JsonOut {
  let target = path;
  try {
    if (!target) {
      const dir = join(tmpdir(), "whatsapp-axi");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      target = join(dir, `${stamp}-${command.replace(/[^a-z0-9-]+/gi, "-")}-${process.pid}.json`);
    }
    const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    return { path: target, fd, lines: 0 };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const why = err.code === "ELOOP" ? "it is a symlink" : (err.code ?? err.message);
    throw failure(`Cannot write the --json-out file ${target || path}: ${why}. Nothing was sent to the daemon.`, "json_out_unwritable", [
      "Choose a writable path that is not a symlink with `--json-out=<path>`, or use a bare `--json-out`",
    ]);
  }
}

/** Appends one streamed object as a line. */
export function appendLine(obj: unknown): void {
  const f = output.file;
  if (!f) return;
  writeSync(f.fd, `${JSON.stringify(obj)}\n`);
  f.lines++;
}

/** Writes one whole document. */
export function writeDoc(doc: unknown): void {
  const f = output.file;
  if (f) writeSync(f.fd, `${JSON.stringify(doc)}\n`);
}

export function closeJsonOut(): void {
  if (output.file) closeSync(output.file.fd);
}

/** A ready-to-run jq example for what the file holds. */
export function jqHint(path: string, doc: unknown, stream: boolean): string {
  if (stream) return `Run \`jq -c . ${path}\` to process each line`;
  if (doc && typeof doc === "object" && "error" in (doc as Obj)) return `Run \`jq .error ${path}\` to read the error`;
  const list = doc && typeof doc === "object" ? Object.entries(doc as Obj).find(([, v]) => Array.isArray(v)) : undefined;
  if (list) return `Run \`jq '.${list[0]}[]' ${path}\` to process the full result`;
  return `Run \`jq . ${path}\` to read the full result`;
}
