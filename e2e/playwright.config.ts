import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The real server from source with the built client embedded the same way the
// binary does it (`bun run build:client` first), on its own port and a fresh
// data folder per run.
const PORT = 18443;
const dataDir = mkdtempSync(join(tmpdir(), "tm-e2e-"));
export const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `bun ../server/src/main.ts --port ${PORT} --data ${JSON.stringify(dataDir)} --no-open`,
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
