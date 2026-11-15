// Leaf module: node builtins only, so `--version` answers before the command graph loads.
import { readFileSync } from "node:fs";

function readVersion(): string {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf-8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === "whatsapp-axi" && typeof parsed.version === "string") return parsed.version;
    } catch {
      // try the next layout (src/ vs dist/src/)
    }
  }
  return "0.0.0";
}

export const VERSION = readVersion();
