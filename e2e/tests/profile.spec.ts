import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { openChat, signUp, startChat } from "./people";
import { OwnServer } from "./server";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

test("a profile photo shows up for the other person, cut square, and can be removed", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await alice.page.goto("/");

  await bob.page.getByTestId("settings").click();
  await bob.page.getByTestId("avatar-input").setInputFiles(fixture("photo.jpg"));
  await expect(bob.page.getByTestId("settings-panel").getByTestId("avatar-photo")).toBeVisible();

  const row = alice.page.locator(`[data-testid="chat-row"][data-chat="${chat}"]`);
  const photo = row.getByTestId("avatar-photo");
  await expect(photo).toBeVisible();
  // 3000×1500 in, the middle square out: 128 px for the small picture, 512 px behind it.
  expect(await photo.evaluate((img: HTMLImageElement) => img.decode().then(() => [img.naturalWidth, img.naturalHeight]))).toEqual([128, 128]);
  const id = (await photo.getAttribute("src"))!.split("/")[2]!;
  const full = await alice.page.request.get(`/media/${id}`);
  expect(full.status()).toBe(200);
  await openChat(alice, chat);
  await expect(alice.page.getByTestId("chat-title").getByTestId("avatar-photo")).toBeVisible();

  await bob.page.getByTestId("remove-photo").click();
  await expect(bob.page.getByTestId("remove-photo")).toBeHidden();
  await expect(row.getByTestId("avatar-photo")).toHaveCount(0);
  await expect(alice.page.getByTestId("chat-title").getByTestId("avatar-photo")).toHaveCount(0);
});

/** A server of the test's own, whose first account is an administrator. */
async function serverWithAdmin(browser: Browser, info: TestInfo) {
  const server = new OwnServer(18505 + info.parallelIndex * 10 + ["chromium", "firefox", "webkit"].indexOf(info.project.name));
  await server.start();
  const admin = await signUp(browser, "Admin", { baseURL: server.url, invite: await server.adminInvite() });
  const bob = await signUp(browser, "Bob", { baseURL: server.url, invite: await server.invite() });
  await admin.page.getByTestId("settings").click();
  await admin.page.getByTestId("server-section").click();
  return { server, admin, bob, bobRow: admin.page.locator(`[data-testid="admin-user"][data-user="${bob.username}"]`) };
}

async function signInAs(page: Page, username: string, password: string) {
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("a blocked person is signed out at once and cannot sign in until unblocked", async ({ browser }, info) => {
  const { server, admin, bob, bobRow } = await serverWithAdmin(browser, info);
  try {
    admin.page.once("dialog", (d) => void d.accept());
    await bobRow.getByTestId("block").click();
    await expect(bobRow).toContainText("blocked");

    // Bob's open tab drops to the sign-in screen, where signing in is refused.
    await expect(bob.page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await signInAs(bob.page, bob.username, "password123");
    await expect(bob.page.getByRole("alert")).toHaveText("This account is blocked. Ask the server's administrator.");

    await bobRow.getByTestId("unblock").click();
    await expect(bobRow).not.toContainText("blocked");
    await bob.page.getByRole("button", { name: "Sign in" }).click();
    await expect(bob.page.getByRole("heading", { name: "Chats" })).toBeVisible();
  } finally {
    server.kill();
  }
});

test("a password reset link sets a new password, and the old one stops working", async ({ browser }, info) => {
  const { server, admin, bob, bobRow } = await serverWithAdmin(browser, info);
  try {
    await bobRow.getByTestId("reset-link").click();
    const url = await bobRow.getByTestId("reset-url").textContent();

    const phone = await browser.newContext({ baseURL: server.url, locale: "en-US" });
    const page = await phone.newPage();
    await page.goto(url!);
    await expect(page.getByTestId("reset-form")).toContainText(`For Bob (@${bob.username})`);
    await page.getByLabel("New password").fill("a brand new one");
    await page.getByRole("button", { name: "Save and sign in" }).click();
    await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
    // Every earlier sign-in ends.
    await expect(bob.page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await signInAs(bob.page, bob.username, "password123");
    await expect(bob.page.getByRole("alert")).toHaveText("Wrong username or password.");
    await signInAs(bob.page, bob.username, "a brand new one");
    await expect(bob.page.getByRole("heading", { name: "Chats" })).toBeVisible();

    // The link is used up.
    const later = await (await browser.newContext({ baseURL: server.url, locale: "en-US" })).newPage();
    await later.goto(url!);
    await expect(later.getByRole("alert")).toContainText("already been used");
  } finally {
    server.kill();
  }
});
