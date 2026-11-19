import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Several tests spawn the CLI or the daemon; give them room on a loaded machine.
    testTimeout: 30_000,
  },
});
