// The one module that imports the TOON encoder (specs/conventions.md "Repository"). Everything
// printed goes through `render`, which never prints `null`: an absent value's key is omitted, and
// an absent cell of a table is "-" so that every row keeps the same columns.
import { encode } from "@toon-format/toon";

type Obj = Record<string, unknown>;

function isPlain(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Absent values out: keys dropped from objects, "-" in uniform table rows. */
export function clean(v: unknown): unknown {
  if (Array.isArray(v)) {
    const rows = v.filter((x) => x !== null && x !== undefined);
    if (rows.length && rows.every(isPlain)) {
      const keys = Object.keys(rows[0] as Obj);
      const uniform = rows.every((r) => {
        const k = Object.keys(r as Obj);
        return k.length === keys.length && k.every((x, i) => x === keys[i]);
      });
      const flat = rows.every((r) => Object.values(r as Obj).every((x) => x === null || x === undefined || typeof x !== "object"));
      if (uniform && flat) {
        return rows.map((r) => Object.fromEntries(Object.entries(r as Obj).map(([k, x]) => [k, x === null || x === undefined ? "-" : x])));
      }
    }
    return rows.map(clean);
  }
  if (isPlain(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === null || x === undefined) continue;
      out[k] = clean(x);
    }
    return out;
  }
  return v;
}

/** TOON for a value, without a trailing newline. */
export function render(v: unknown): string {
  return encode(clean(v) as never);
}

/** TOON for a value, with a trailing newline. */
export function line(v: unknown): string {
  return `${render(v)}\n`;
}
