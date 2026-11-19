// The one command reference (specs/conventions.md "Repository"): the description and every
// command's spec, grouped. It feeds the top-level help, per-command help, the home view's hints
// and the generated skill (scripts/generate-skill.ts), so none of them is written by hand.
import { usageLine, type CommandSpec } from "./flags.js";
import { accountAddSpec, accountMigrateSpec, accountRemoveSpec, accountsSpec, accountUseSpec, daemonRunSpec, DISCOVERY } from "./commands/accounts.js";
import { downloadSpec, markReadSpec, reactSpec, sendFileSpec, sendSpec, typingSpec } from "./commands/act.js";
import { authLinkSpec, authLogoutSpec } from "./commands/auth.js";
import {
  daemonInstallSpec,
  daemonLogsSpec,
  daemonRestartSpec,
  daemonStartSpec,
  daemonStatusSpec,
  daemonStopSpec,
  daemonUninstallSpec,
  daemonUpgradeSpec,
} from "./commands/daemon.js";
import { doctorSpec } from "./commands/doctor.js";
import { chatViewSpec, chatsSpec, eventsSpec, forgetSpec, groupsSpec, messageViewSpec, readSpec } from "./commands/read.js";
import {
  operatorsAddSpec,
  operatorsListSpec,
  operatorsRemoveSpec,
  scopeDMFromSpec,
  scopeSetSpec,
  scopeShowSpec,
  settingsSetSpec,
  settingsShowSpec,
} from "./commands/settings.js";
import { sessionStartSpec, setupHooksSpec, setupHooksStatusSpec, setupHooksUninstallSpec } from "./commands/setup.js";
import { updateSpec } from "./commands/update.js";
import { BIN } from "./errors.js";

export const DESCRIPTION = "Agent-ergonomic CLI for WhatsApp accounts, each served by a local daemon";

export interface Group {
  title: string;
  specs: CommandSpec[];
}

export const GROUPS: Group[] = [
  { title: "accounts", specs: [accountsSpec, accountAddSpec, accountUseSpec, accountRemoveSpec, accountMigrateSpec, authLinkSpec, authLogoutSpec] },
  { title: "reading", specs: [chatsSpec, groupsSpec, chatViewSpec, eventsSpec, readSpec, messageViewSpec] },
  { title: "acting", specs: [sendSpec, sendFileSpec, reactSpec, markReadSpec, typingSpec, downloadSpec, forgetSpec] },
  {
    title: "settings",
    specs: [scopeShowSpec, scopeSetSpec, scopeDMFromSpec, operatorsListSpec, operatorsAddSpec, operatorsRemoveSpec, settingsShowSpec, settingsSetSpec],
  },
  {
    title: "daemon",
    specs: [
      daemonInstallSpec,
      daemonUninstallSpec,
      daemonStartSpec,
      daemonStopSpec,
      daemonRestartSpec,
      daemonStatusSpec,
      daemonLogsSpec,
      daemonUpgradeSpec,
      daemonRunSpec,
      doctorSpec,
      updateSpec,
    ],
  },
  { title: "agents", specs: [setupHooksSpec, setupHooksStatusSpec, setupHooksUninstallSpec, sessionStartSpec] },
];

/** Every command spec, in reference order. */
export const SPECS: CommandSpec[] = GROUPS.flatMap((g) => g.specs);

export { DISCOVERY };

/** The top-level help, rendered from the reference in block form. */
export function renderTopLevelHelp(): string {
  const lines = [`usage: ${BIN} [command] [args] [flags]`, "home: with no command, the accounts with their state and scope"];
  for (const g of GROUPS) {
    lines.push(`${g.title}[${g.specs.length}]:`);
    for (const s of g.specs) lines.push(`  ${usageLine(s).slice(BIN.length + 1)}: ${s.summary}`);
  }
  const jsonOut = SPECS.filter((s) => s.jsonOut).map((s) => s.name);
  lines.push(
    "global_flags[3]:",
    "  --account <name>: the account; needed for a change once there are several (WHATSAPP_AXI_ACCOUNT pins it)",
    "  --tz <iana>: show times in this zone (default: the system's)",
    "  --help: usage on any command; -v, --version: the version",
    `json_out: --json-out[=path] also writes the complete result as JSON to a file, on ${jsonOut.join(", ")}`,
    `help[1]:`,
    `  ${DISCOVERY}`,
  );
  return `${lines.join("\n")}\n`;
}
