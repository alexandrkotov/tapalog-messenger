import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { signUp } from "./people";
import { OwnServer } from "./server";

test("without a TURN relay, Settings has no call check", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  await alice.page.getByTestId("settings").click();
  await expect(alice.page.getByTestId("settings-panel")).toBeVisible();
  await expect(alice.page.getByTestId("call-check")).toHaveCount(0);
  await alice.context.close();
});

// Needs a real coturn on 127.0.0.1:3478 with this secret (CI starts one; see ci.yml).
const turnSecret = process.env.TM_E2E_TURN_SECRET;

test("the call check gets through a real coturn, by UDP and by TCP", async ({ browser, browserName }, info) => {
  test.skip(!turnSecret, "TM_E2E_TURN_SECRET is not set: no coturn to test against");
  test.skip(browserName !== "chromium", "one browser is enough for the relay itself");
  test.setTimeout(120_000);
  const secretFile = join(mkdtempSync(join(tmpdir(), "tm-turn-")), "secret");
  writeFileSync(secretFile, turnSecret!);
  const server = new OwnServer(18560 + info.parallelIndex, [
    "--turn-url",
    "turn:127.0.0.1:3478",
    "--turn-url",
    "turn:127.0.0.1:3478?transport=tcp",
    "--turn-secret-file",
    secretFile,
  ]);
  await server.start();
  try {
    const admin = await signUp(browser, "Admin", { baseURL: server.url, invite: await server.adminInvite() });
    await admin.page.getByTestId("settings").click();
    const result = admin.page.getByTestId("call-check-result");
    for (const [label, transport] of [
      ["UDP only", "udp"],
      ["TCP only", "tcp"],
    ] as const) {
      await admin.page.getByLabel("Way to the relay").selectOption({ label });
      await admin.page.getByTestId("call-check").click();
      await expect(admin.page.getByTestId("call-check")).toBeDisabled();
      await expect(result).toHaveAttribute("data-ok", "true", { timeout: 45_000 });
      await expect(result).toHaveAttribute("data-transport", transport);
      await expect(result).toContainText(`Calls get through: by ${transport.toUpperCase()}`);
    }
    // No TLS address was given to this server.
    await admin.page.getByLabel("Way to the relay").selectOption({ label: "TLS only" });
    await admin.page.getByTestId("call-check").click();
    await expect(result).toHaveText("The server has no relay address of this kind.");
    await admin.context.close();
  } finally {
    server.kill();
  }
});

test("a relay that cannot be reached is reported as such", async ({ browser, browserName }, info) => {
  test.skip(browserName !== "chromium", "one browser is enough");
  test.setTimeout(60_000);
  const secretFile = join(mkdtempSync(join(tmpdir(), "tm-turn-")), "secret");
  writeFileSync(secretFile, "a-secret-nobody-listens-for");
  // Nothing listens on port 9 here.
  const server = new OwnServer(18570 + info.parallelIndex, ["--turn-url", "turn:127.0.0.1:9", "--turn-secret-file", secretFile]);
  await server.start();
  try {
    const admin = await signUp(browser, "Admin", { baseURL: server.url, invite: await server.adminInvite() });
    await admin.page.getByTestId("settings").click();
    await admin.page.getByTestId("call-check").click();
    const result = admin.page.getByTestId("call-check-result");
    await expect(result).toHaveAttribute("data-ok", "false", { timeout: 30_000 });
    await expect(result).toContainText("Could not reach the relay from this network.");
    await admin.context.close();
  } finally {
    server.kill();
  }
});
