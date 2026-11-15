import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { homeView } from "../src/home.js";

async function capture(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await main(argv);
  } finally {
    process.stdout.write = write;
  }
  return chunks.join("");
}

describe("home view", () => {
  it("states that no accounts exist", () => {
    expect(homeView()).toContain("accounts: none configured");
  });

  it("is what the CLI prints with no arguments", async () => {
    const out = await capture([]);
    expect(out).toContain("description:");
    expect(out).toContain("accounts: none configured");
  });
});
