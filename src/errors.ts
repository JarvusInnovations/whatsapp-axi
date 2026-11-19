// Error codes and exit codes (specs/conventions.md "Error codes"). Codes are UPPER_SNAKE, one
// vocabulary for the daemon and the CLI. The usage-class codes exit 2, everything else 1.
import { AxiError } from "axi-sdk-js";

export const BIN = "whatsapp-axi";

/** The codes that exit 2: the invocation was wrong, nothing was attempted. */
export const USAGE_CODES = new Set(["USAGE", "UNKNOWN_FLAG", "VALIDATION_ERROR", "CONFIRM_REQUIRED", "ACCOUNT_REQUIRED", "ACCOUNT_LOCKED"]);

/** Codes the daemon answers with (specs/conventions.md, "From the daemon"), including stream-final codes. */
export const DAEMON_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "AMBIGUOUS",
  "NOT_LINKED",
  "NOT_CONNECTED",
  "LINK_IN_PROGRESS",
  "FIRST_CONTACT",
  "CONFIRM_REQUIRED",
  "RATE_LIMITED",
  "DUPLICATE_TEXT",
  "NOT_DOWNLOADABLE",
  "UPSTREAM_ERROR",
  "OUTCOME_UNKNOWN",
  "INTERNAL_ERROR",
  "WRONG_NUMBER",
  "CLIENT_OUTDATED",
  "LINK_TIMEOUT",
  "LINK_CANCELLED",
  "MARK_FAILED",
] as const;

/** Codes the CLI raises itself (specs/conventions.md, "From the CLI"). */
export const CLI_CODES = [
  "USAGE",
  "UNKNOWN_FLAG",
  "VALIDATION_ERROR",
  "CONFIRM_REQUIRED",
  "ACCOUNT_REQUIRED",
  "ACCOUNT_LOCKED",
  "ACCOUNT_LOCK_INVALID",
  "NO_ACCOUNT",
  "CONFIG_INVALID",
  "DAEMON_NOT_RUNNING",
  "DAEMON_UNREACHABLE",
  "TIMEOUT",
  "UNEXPECTED_RESPONSE",
  "PROTOCOL_MISMATCH",
  "STREAM_CLOSED",
  "EXPORT_UNWRITABLE",
  "LINK_FAILED",
  "LINK_INTERRUPTED",
  "ACCOUNT_ADD_FAILED",
  "ACCOUNT_REMOVE_FAILED",
  "DAEMON_RUNNING",
  "DAEMON_EXITED",
  "DAEMON_BINARY_MISSING",
  "DAEMON_BINARY_FAILED",
  "UNSUPPORTED_PLATFORM",
  "NOT_INSTALLED",
  "SERVICE_FAILED",
  "SERVICE_NOT_READY",
  "LINGER_OFF",
  "LOGS_FAILED",
  "UPDATE_FAILED",
  "SETUP_FAILED",
  "NO_PROJECT",
  "INTERNAL_ERROR",
] as const;

export type Code = (typeof DAEMON_CODES)[number] | (typeof CLI_CODES)[number];

const KNOWN = new Set<string>([...DAEMON_CODES, ...CLI_CODES]);

export function knownCode(code: string): boolean {
  return KNOWN.has(code);
}

/** A tool error. `details` carries the daemon's structured fields (candidates, state, ...). */
export class ToolError extends AxiError {
  details?: Record<string, unknown>;
  /** Output keys printed before `error` (the data a command read before it failed). */
  before?: Record<string, unknown>;
  /** Output keys printed after `code`, before `help` (export lines). */
  after?: Record<string, unknown>;
  constructor(message: string, code: string, help: string[] = []) {
    super(message, code, help);
  }
}

export function failure(message: string, code: Code, help: string[] = []): ToolError {
  return new ToolError(message, code, help);
}

/** Wrong arity or a missing value. */
export function usage(message: string, help: string[] = []): ToolError {
  return new ToolError(message, "USAGE", help);
}

/** A bad value, a contradiction, an unknown subcommand. */
export function invalid(message: string, help: string[] = []): ToolError {
  return new ToolError(message, "VALIDATION_ERROR", help);
}

/** A gated change without its --confirm. */
export function confirmRequired(message: string, help: string[] = []): ToolError {
  return new ToolError(message, "CONFIRM_REQUIRED", help);
}

export function exitCodeFor(err: unknown): number {
  return err instanceof AxiError && USAGE_CODES.has(err.code) ? 2 : 1;
}

/** Clips a reason to one line for `unknown (<CODE>: …)` and `unavailable (<CODE>: …)`. */
export function clip(s: string, max = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function codeOf(err: unknown): string {
  return err instanceof AxiError ? err.code : "INTERNAL_ERROR";
}

/** `<CODE>: <message>`, clipped, for a row that could not be read. */
export function reasonOf(err: unknown): string {
  return `${codeOf(err)}: ${clip(err instanceof Error ? err.message : String(err))}`;
}
