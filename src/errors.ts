import { AxiError } from "axi-sdk-js";

export const BIN = "whatsapp-axi";

/** The code of a usage error; it exits 2. Every other error exits 1. */
export const USAGE = "usage";

export function usage(message: string, help: string[] = []): AxiError {
  return new AxiError(message, USAGE, help);
}

export function failure(message: string, code: string, help: string[] = []): AxiError {
  return new AxiError(message, code, help);
}

export function exitCodeFor(err: unknown): number {
  return err instanceof AxiError && err.code === USAGE ? 2 : 1;
}
