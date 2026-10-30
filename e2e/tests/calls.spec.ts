import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openChat, signIn, signUp, startChat, type Person } from "./people";
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

// ---- Calls between two people ----------------------------------------------

/** Both in their direct chat; returns its id. */
async function pair(browser: import("@playwright/test").Browser, baseURL?: string, invite?: () => Promise<string>) {
  const alice = await signUp(browser, "Alice", { baseURL, invite: invite && (await invite()) });
  const bob = await signUp(browser, "Bob", { baseURL, invite: invite && (await invite()) });
  const chat = await startChat(alice, bob);
  return { alice, bob, chat };
}

const screen = (p: Page) => p.getByTestId("call-screen");

/** Whether the other side's picture actually arrives: the remote <video> has frames. */
const remoteVideoPlays = (p: Page) =>
  expect.poll(() => p.getByTestId("call-remote").evaluate((v: HTMLVideoElement) => v.videoWidth > 0 && v.readyState >= 2), { timeout: 15_000 }).toBe(true);

async function answer(bob: Person, video: boolean) {
  await expect(screen(bob.page)).toHaveAttribute("data-phase", "incoming");
  await expect(bob.page.getByTestId("call-status")).toHaveText(video ? "Incoming video call" : "Incoming call");
  await bob.page.getByTestId("call-answer").click();
}

test.describe("calls", () => {
  test.skip(({ browserName }) => browserName === "webkit", "Playwright's WebKit has no fake camera and microphone");

  test("a video call: it rings, Bob answers, both see each other, the call is written into the chat", async ({ browser }) => {
    test.setTimeout(60_000);
    const { alice, bob, chat } = await pair(browser);
    await alice.page.getByTestId("call-video").click();
    await expect(screen(alice.page)).toHaveAttribute("data-phase", "outgoing");
    await expect(alice.page.getByTestId("call-status")).toHaveText("Calling…");

    await answer(bob, true);
    for (const p of [alice.page, bob.page]) {
      await expect(screen(p)).toHaveAttribute("data-phase", "active", { timeout: 20_000 });
      await expect(p.getByTestId("call-status")).toHaveText(/^0:0\d$/);
      await remoteVideoPlays(p);
    }

    // Details: two browsers on one machine find each other directly.
    await alice.page.getByTestId("call-details").click();
    await expect(alice.page.getByTestId("call-details-list")).toHaveAttribute("data-route", "direct", { timeout: 5000 });

    // Microphone off and on, camera off: the buttons say what they will do next.
    await alice.page.getByTestId("call-mute").click();
    await expect(alice.page.getByTestId("call-mute")).toHaveAttribute("aria-label", "Turn the microphone on");
    await alice.page.getByTestId("call-camera").click();
    await expect(alice.page.getByTestId("call-local")).toHaveCount(0);

    // Back to the chats while talking, then back to the call.
    await alice.page.getByTestId("call-minimize").click();
    await expect(alice.page.getByTestId("call-bar")).toBeVisible();
    await alice.page.getByTestId("call-bar").click();

    await alice.page.getByTestId("call-hang-up").click();
    await expect(bob.page.getByTestId("call-status")).toHaveText("Call ended");
    await expect(screen(alice.page)).toBeHidden({ timeout: 5000 });
    await expect(screen(bob.page)).toBeHidden({ timeout: 5000 });

    await openChat(bob, chat);
    await expect(alice.page.getByTestId("call-record").last()).toHaveText(/^📹 Outgoing call · 0:\d\d$/);
    await expect(bob.page.getByTestId("call-record").last()).toHaveText(/^📹 Incoming call · 0:\d\d$/);
    await expect(bob.page.locator(`[data-testid="chat-row"][data-chat="${chat}"]`)).toContainText("Incoming call");
    await alice.context.close();
    await bob.context.close();
  });

  test("Bob declines; then Alice cancels before he answers", async ({ browser }) => {
    const { alice, bob, chat } = await pair(browser);
    await alice.page.getByTestId("call-audio").click();
    await expect(screen(bob.page)).toHaveAttribute("data-phase", "incoming");
    await bob.page.getByTestId("call-decline").click();
    await expect(alice.page.getByTestId("call-status")).toHaveText("Declined");
    await expect(alice.page.getByTestId("call-record").last()).toHaveText("📞 Declined");

    await expect(screen(alice.page)).toBeHidden({ timeout: 5000 });
    await alice.page.getByTestId("call-audio").click();
    await expect(screen(bob.page)).toHaveAttribute("data-phase", "incoming");
    await alice.page.getByTestId("call-hang-up").click();
    await expect(screen(bob.page)).toHaveAttribute("data-phase", "ended");
    await openChat(bob, chat);
    await expect(bob.page.getByTestId("call-record").last()).toHaveText("📞 Missed call");
    await expect(bob.page.getByTestId("call-record").last()).toHaveAttribute("data-outcome", "missed");

    // Call back from the record.
    await bob.page.getByTestId("call-record").last().click();
    await bob.page.getByTestId("call-back").click();
    await expect(screen(alice.page)).toHaveAttribute("data-phase", "incoming");
    await bob.page.getByTestId("call-hang-up").click();
    await alice.context.close();
    await bob.context.close();
  });

  test("Bob's other device stops ringing when he answers on one", async ({ browser }) => {
    test.setTimeout(60_000);
    const { alice, bob, chat } = await pair(browser);
    const phone = await signIn(browser, bob);
    await alice.page.getByTestId("call-audio").click();
    await expect(screen(phone.page)).toHaveAttribute("data-phase", "incoming");
    await answer(bob, false);
    await expect(screen(phone.page)).toBeHidden();
    await expect(screen(alice.page)).toHaveAttribute("data-phase", "active", { timeout: 20_000 });
    await bob.page.getByTestId("call-hang-up").click();
    await expect(screen(alice.page)).toHaveAttribute("data-phase", "ended");
    for (const p of [alice, bob, phone]) await p.context.close();
  });
});

test("a call only through the relay goes through a real coturn", async ({ browser, browserName }, info) => {
  test.skip(!turnSecret, "TM_E2E_TURN_SECRET is not set: no coturn to test against");
  test.skip(browserName !== "chromium", "one browser is enough for the relay itself");
  test.setTimeout(120_000);
  const secretFile = join(mkdtempSync(join(tmpdir(), "tm-turn-")), "secret");
  writeFileSync(secretFile, turnSecret!);
  // UDP and TCP addresses only: "only through the server" then goes by TCP.
  const server = new OwnServer(18580 + info.parallelIndex, ["--turn-url", "turn:127.0.0.1:3478", "--turn-url", "turn:127.0.0.1:3478?transport=tcp", "--turn-secret-file", secretFile]);
  await server.start();
  try {
    const { alice, bob, chat } = await pair(browser, server.url, () => server.adminInvite());
    for (const who of [alice, bob]) {
      await who.page.getByTestId("settings").click();
      await who.page.getByTestId("call-route").selectOption("relay");
    }
    await openChat(alice, chat);
    await alice.page.getByTestId("call-audio").click();
    await answer(bob, false);
    await expect(screen(alice.page)).toHaveAttribute("data-phase", "active", { timeout: 30_000 });
    await alice.page.getByTestId("call-details").click();
    await expect(alice.page.getByTestId("call-details-list")).toHaveAttribute("data-route", "relay tcp", { timeout: 10_000 });
    await alice.page.getByTestId("call-hang-up").click();
    await alice.context.close();
    await bob.context.close();
  } finally {
    server.kill();
  }
});
