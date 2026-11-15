// Times in the local zone with their offset (specs/conventions.md "Output vocabulary"). The daemon
// speaks UTC instants; the TOON view shows them in the zone of `--tz`, else the process's zone,
// and names that zone once (`tz:`). `--json-out` files keep the daemon's instants.
import { invalid } from "../errors.js";

/** The process's own zone, as Intl resolves it (TZ, else the system's). */
export function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Validates an IANA zone name given to --tz. */
export function checkZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    throw invalid(`--tz ${JSON.stringify(zone)} is not a time zone: use an IANA name such as America/New_York or UTC`);
  }
}

const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(zone: string): Intl.DateTimeFormat {
  let f = cache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    cache.set(zone, f);
  }
  return f;
}

/** An instant in `zone` as `2030-01-05T09:00:00-05:00`; anything unparseable is returned as given. */
export function localTime(iso: string, zone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const parts = Object.fromEntries(fmt(zone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const off = (parts.timeZoneName ?? "GMT").replace(/^GMT/, "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}
