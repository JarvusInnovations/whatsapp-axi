import { encode } from "@toon-format/toon";

/** Content-first home view. Skeleton: no account store exists yet, so it states that definitively. */
export function homeView(): string {
  return [
    encode({ accounts: "none configured", build: "skeleton" }),
    "help[1]:",
    "  Run `whatsapp-axi --help` to see the command list",
  ].join("\n");
}
