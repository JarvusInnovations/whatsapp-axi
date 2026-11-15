// update: the SDK's self-update, shadowed (specs/conventions.md "update"). It updates the package
// as the SDK would, then says that each installed daemon still runs the old binary until
// `daemon upgrade`, and offers it.
import { AxiError, runUpdate, type RunUpdateOptions } from "axi-sdk-js";
import { parse, type CommandSpec } from "../flags.js";
import { failure } from "../errors.js";
import { installedAccounts } from "./daemon.js";
import type { Ctx } from "../context.js";

export const updateSpec: CommandSpec = {
  name: "update",
  summary: "Update the CLI package; the installed daemons keep running the old binary until `daemon upgrade`",
  positionals: [],
  flags: { check: { type: "bool", desc: "report the current and latest versions without installing" } },
  examples: ["whatsapp-axi update --check", "whatsapp-axi update"],
  mutation: true,
  account: "none",
};

type Updater = (o: RunUpdateOptions) => Promise<unknown>;
let updater: Updater = runUpdate as Updater;

/** Replaces the SDK updater (tests use a fake; no test reaches the registry). */
export function setUpdater(u: Updater): void {
  updater = u;
}

export async function update(ctx: Ctx, args: string[]): Promise<unknown> {
  const p = parse(updateSpec, args);
  let res: unknown;
  try {
    res = await updater({ args: p.flags.check ? ["--check"] : [], stdout: ctx.io.stdout, env: ctx.io.env as NodeJS.ProcessEnv });
  } catch (err) {
    // The SDK's own codes are not this tool's; a registry or install failure is the upstream's.
    const message = err instanceof Error ? err.message : String(err);
    const help = err instanceof AxiError ? err.suggestions : [];
    throw failure(
      `update failed: ${message}`,
      "UPSTREAM_ERROR",
      help.filter((h) => !/npm install -g/.test(h)),
    );
  }
  if (p.flags.check) return res;
  let installed: string[] = [];
  try {
    installed = installedAccounts(ctx);
  } catch {
    installed = [];
  }
  const out = (res && typeof res === "object" && !Array.isArray(res) ? { ...(res as Record<string, unknown>) } : { update: res }) as Record<string, unknown>;
  const help = Array.isArray(out.help) ? [...(out.help as string[])] : [];
  if (installed.length) {
    out.daemons = `${installed.join(", ")} still run the old daemon binary until \`daemon upgrade\``;
    help.push("Run `whatsapp-axi daemon upgrade` to install the new daemon binary and restart every installed account");
  }
  if (help.length) out.help = help;
  return out;
}
