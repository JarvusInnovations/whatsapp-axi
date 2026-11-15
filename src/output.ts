// --json output (specs/cli.md "Conventions"): one JSON document instead of TOON. A command that
// calls the daemon prints the daemon's response body unchanged; a streaming one prints each line
// the daemon sends as it arrives; a local command prints the data it would print as TOON.
import { encode } from "@toon-format/toon";

export const output = {
  /** True while the current command runs with --json. */
  json: false,
  /** The body of the last successful daemon call of the current command. */
  body: undefined as Record<string, unknown> | undefined,
};

/** Encodes one printed object as TOON, or as one JSON line with --json. */
export function render(obj: unknown): string {
  return output.json ? JSON.stringify(obj) : encode(obj);
}
