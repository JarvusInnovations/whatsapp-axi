// --json-out[=path] (specs/cli.md "Conventions", specs/conventions.md "Machine output"): standard
// output stays TOON; the daemon's complete response body is also written to a file. The path is
// checked and the file opened before the command does anything; the client records what it
// received here; the dispatcher writes the file afterwards. A failed write after a successful
// command never undoes the success: it is `export_error:` and exit 1.
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { failure, usage } from "../errors.js";
import { isFlagToken } from "../flags.js";

type Obj = Record<string, unknown>;

export interface JsonOut {
  path: string;
  fd: number;
  /** Lines appended so far by a stream. */
  lines: number;
  /** An explicit path that already held a file, now replaced. */
  overwrote: boolean;
  /** The first write error, when one failed. */
  error?: string;
  /** Top-level keys of the first record written. */
  columns?: string[];
  closed?: boolean;
  /** A device or other special file: never removed. */
  device?: boolean;
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
 * the path: `""` for a bare flag (auto path), undefined when the flag is absent. The space form
 * (`--json-out <path>`) is always a usage error naming the `=` form.
 */
export function takeJsonOut(args: string[]): { args: string[]; path: string | undefined } {
  const dd = args.indexOf("--");
  const head = dd < 0 ? args : args.slice(0, dd);
  const tail = dd < 0 ? [] : args.slice(dd);
  let path: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === "--json-out" || a.startsWith("--json-out=")) {
      if (path !== undefined) throw usage("--json-out is given more than once");
      if (a === "--json-out") {
        const next = head[i + 1];
        if (next !== undefined && !isFlagToken(next)) {
          throw usage(`--json-out takes its path only with =: write \`--json-out=${next}\`; a bare --json-out picks a file in the temp directory`, [
            "Put the command's own arguments before --json-out, or use the = form",
          ]);
        }
        path = "";
      } else {
        const v = a.slice("--json-out=".length);
        if (!v) throw usage("--json-out= needs a path: --json-out=<path>, or a bare --json-out for a file in the temp directory");
        path = v;
      }
    } else rest.push(a);
  }
  return { args: [...rest, ...tail], path };
}

/** The per-user directory of automatic exports. */
export function autoDir(): string {
  const uid = process.getuid?.();
  return join(tmpdir(), uid === undefined ? "whatsapp-axi" : `whatsapp-axi-${uid}`);
}

function unwritable(target: string, why: string) {
  return failure(`Cannot write the --json-out file ${target}: ${why}. Nothing was done.`, "EXPORT_UNWRITABLE", [
    "Choose a writable path that is not a symlink with `--json-out=<path>`, or use a bare `--json-out`",
  ]);
}

/** The automatic directory, made or accepted only when it is the user's alone. */
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw unwritable(dir, "it is not a directory (a symlink?)");
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw unwritable(dir, "the directory belongs to another user");
  if ((st.mode & 0o077) !== 0) throw unwritable(dir, `the directory is open to others (mode ${(st.mode & 0o777).toString(8)})`);
}

/** Opens the file before any work: owner-only, never through a symlink; automatic names are created exclusively. */
export function openJsonOut(path: string, command: string, now = Date.now()): JsonOut {
  if (!path) {
    const dir = autoDir();
    try {
      privateDir(dir);
    } catch (err) {
      if ((err as { code?: string }).code === "EXPORT_UNWRITABLE") throw err;
      throw unwritable(dir, (err as NodeJS.ErrnoException).code ?? (err as Error).message);
    }
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const base = join(dir, `${stamp}-${command.replace(/[^a-z0-9-]+/gi, "-")}`);
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? `${base}.json` : `${base}-${n}.json`;
      try {
        const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        fchmodSync(fd, 0o600);
        return { path: candidate, fd, lines: 0, overwrote: false };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw unwritable(candidate, (err as NodeJS.ErrnoException).code ?? (err as Error).message);
      }
    }
    throw unwritable(base, "no free name");
  }
  let overwrote = false;
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw unwritable(path, "it is a symlink");
    if (st.isDirectory()) throw unwritable(path, "it is a directory");
    overwrote = st.isFile();
  } catch (err) {
    if ((err as { code?: string }).code === "EXPORT_UNWRITABLE") throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw unwritable(path, (err as NodeJS.ErrnoException).code ?? (err as Error).message);
  }
  try {
    const existed = (() => {
      try {
        return !lstatSync(path).isFile();
      } catch {
        return false;
      }
    })();
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    // A device (/dev/null) keeps its own mode; a file is owner-only.
    if (!existed) fchmodSync(fd, 0o600);
    return { path, fd, lines: 0, overwrote, device: existed };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw unwritable(path, code === "ELOOP" ? "it is a symlink" : code === "ENOENT" ? enoentReason(path) : (code ?? (err as Error).message));
  }
}

/** Why a file could not be created where open said ENOENT: its directory is missing, or refuses new files (/proc). */
function enoentReason(path: string): string {
  const dir = dirname(path);
  try {
    if (statSync(dir).isDirectory()) return `its directory ${dir} exists but no file can be created in it (ENOENT)`;
    return `${dir} is not a directory`;
  } catch {
    return "its directory does not exist";
  }
}

function keysOf(obj: unknown): string[] | undefined {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const list = Object.values(obj as Obj).find((v) => Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] !== null) as Obj[] | undefined;
  return Object.keys(list ? list[0] : (obj as Obj));
}

function write(text: string, obj: unknown): void {
  const f = output.file;
  if (!f || f.error) return;
  try {
    writeSync(f.fd, text);
    f.columns ??= keysOf(obj);
  } catch (err) {
    f.error = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
  }
}

/** Appends one streamed object as a line. */
export function appendLine(obj: unknown): void {
  const f = output.file;
  if (!f) return;
  write(`${JSON.stringify(obj)}\n`, obj);
  if (!f.error) f.lines++;
}

/** Writes one whole document. */
export function writeDoc(doc: unknown): void {
  write(`${JSON.stringify(doc)}\n`, doc);
}

/** Closes the file; a file whose write failed is removed rather than left partial. */
export function closeJsonOut(): void {
  const f = output.file;
  if (!f || f.closed) return;
  f.closed = true;
  try {
    closeSync(f.fd);
  } catch (err) {
    f.error ??= (err as NodeJS.ErrnoException).code ?? (err as Error).message;
  }
  if (f.error && !f.device) {
    try {
      rmSync(f.path, { force: true });
    } catch {
      // the export_error line says what happened; a file that cannot be removed stays
    }
  }
}

function quotePath(p: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** A ready-to-run jq example for what the file holds. */
export function jqHint(path: string, doc: unknown, stream: boolean): string {
  const p = quotePath(path);
  if (stream) return `Run \`jq -c . ${p}\` to process each line`;
  if (doc && typeof doc === "object" && "error" in (doc as Obj)) return `Run \`jq .error ${p}\` to read the error`;
  const list = doc && typeof doc === "object" ? Object.entries(doc as Obj).find(([, v]) => Array.isArray(v)) : undefined;
  if (list) return `Run \`jq '.${list[0]}[]' ${p}\` to process the full result`;
  return `Run \`jq . ${p}\` to read the full result`;
}
