import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { serverCommand } from "./tests/server";

// One server for the whole run, on its own port and a fresh data folder.
// Workers load this file again, so the folder is passed on through the
// environment rather than created anew in each of them.
const PORT = 18443;
process.env.TM_E2E_DATA ??= mkdtempSync(join(tmpdir(), "tm-e2e-"));
export const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  expect: { timeout: 10_000 },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: serverCommand(PORT, process.env.TM_E2E_DATA).join(" "),
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
