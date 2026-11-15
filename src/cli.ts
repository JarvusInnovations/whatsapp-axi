import { runAxiCli } from "axi-sdk-js";
import { homeView } from "./home.js";
import { VERSION } from "./version.js";

export const DESCRIPTION = "Agent-ergonomic CLI for WhatsApp accounts, each served by a local daemon";

export const TOP_HELP = `usage: whatsapp-axi [command] [args] [flags]
commands[1]:
  (none)=home
flags[2]:
  --help, -v/--version
note: skeleton build; commands arrive once specs/ is written`;

export async function main(argv?: string[]): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    topLevelHelp: TOP_HELP,
    home: () => homeView(),
    commands: {},
  });
}
