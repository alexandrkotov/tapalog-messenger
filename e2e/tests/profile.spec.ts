import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { openChat, send, signUp, startChat } from "./people";
import { OwnServer } from "./server";

test("a profile photo is cut where the person moves it, shows up for the other person, and can be removed", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await alice.page.goto("/");

  // 2000×1000: the left half red, the right half blue.
  const halves = await bob.page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 2000;
    c.height = 1000;
    const g = c.getContext("2d")!;
    g.fillStyle = "#f00";
    g.fillRect(0, 0, 1000, 1000);
    g.fillStyle = "#00f";
    g.fillRect(1000, 0, 1000, 1000);
    return c.toDataURL("image/png").split(",")[1]!;
  });
  const file = { name: "halves.png", mimeType: "image/png", buffer: Buffer.from(halves, "base64") };

  await bob.page.getByTestId("settings").click();
  // Changing one's mind uploads nothing.
  await bob.page.getByTestId("avatar-input").setInputFiles(file);
  await expect(bob.page.getByTestId("avatar-crop")).toBeVisible();
  await bob.page.keyboard.press("Escape");
  await expect(bob.page.getByTestId("avatar-crop")).toBeHidden();
  await expect(bob.page.getByTestId("remove-photo")).toBeHidden();

  // It opens on the middle square; dragged right as far as it goes, the red half fills the circle.
  await bob.page.getByTestId("avatar-input").setInputFiles(file);
  await expect(bob.page.getByTestId("crop-save")).toBeEnabled();
  const box = (await bob.page.getByTestId("crop-frame").boundingBox())!;
  await bob.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await bob.page.mouse.down();
  await bob.page.mouse.move(box.x + box.width, box.y + box.height / 2, { steps: 5 });
  await bob.page.mouse.up();
  await bob.page.getByTestId("crop-save").click();
  await expect(bob.page.getByTestId("settings-panel").getByTestId("avatar-photo")).toBeVisible();

  const row = alice.page.locator(`[data-testid="chat-row"][data-chat="${chat}"]`);
  const photo = row.getByTestId("avatar-photo");
  await expect(photo).toBeVisible();
  // A square: 128 px for the small picture, 512 px behind it. Red right up to its right edge.
  const seen = await photo.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    return { size: [img.naturalWidth, img.naturalHeight], right: [...g.getImageData(120, 64, 1, 1).data.slice(0, 3)] };
  });
  expect(seen.size).toEqual([128, 128]);
  expect(seen.right[0]).toBeGreaterThan(200);
  expect(seen.right[2]).toBeLessThan(60);
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

test("a deleted account's messages stay, signed as from a deleted account, and nothing more can be sent there", async ({ browser }, info) => {
  const { server, admin, bob, bobRow } = await serverWithAdmin(browser, info);
  try {
    const chatId = await startChat(bob, admin);
    await send(bob, "hello from bob");
    admin.page.once("dialog", (d) => void d.accept());
    await bobRow.getByTestId("delete-user").click();
    await expect(bobRow).toHaveCount(0);
    await expect(bob.page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await admin.page.goto("/");
    await openChat(admin, chatId);
    await expect(admin.page.getByTestId("chat-title")).toContainText("Deleted account");
    await expect(admin.page.getByTestId("message").filter({ hasText: "hello from bob" })).toBeVisible();
    await expect(admin.page.getByTestId("peer-deleted")).toBeVisible();
    await expect(admin.page.locator(".composer")).toHaveCount(0);
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

test("a chosen dark theme outlasts a reload, over a light system setting", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  await alice.page.emulateMedia({ colorScheme: "light" });
  const background = () => alice.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await background()).toBe("rgb(240, 242, 245)");

  await alice.page.getByTestId("settings").click();
  await alice.page.getByLabel("Theme").selectOption("dark");
  expect(await background()).toBe("rgb(14, 16, 19)");
  await alice.page.reload();
  await expect(alice.page.getByRole("heading", { name: "Chats" })).toBeVisible();
  expect(await background()).toBe("rgb(14, 16, 19)");

  // Back to the system's choice.
  await alice.page.getByLabel("Theme").selectOption("system");
  expect(await background()).toBe("rgb(240, 242, 245)");
});
