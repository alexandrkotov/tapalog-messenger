import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bodies, openChat, send, signUp, startChat } from "./people";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

test("chats and recent messages open without a network", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await send(alice, "Read me on the train");
  await openChat(bob, chat);
  await expect(bodies(bob)).toHaveText(["Read me on the train"]);
  await bob.page.evaluate(() => navigator.serviceWorker.ready);
  await bob.page.waitForTimeout(800); // the state is saved shortly after it changes

  await bob.context.setOffline(true);
  await bob.page.reload();
  await expect(bob.page.getByTestId("chat-row")).toContainText("Alice");
  await expect(bodies(bob)).toHaveText(["Read me on the train"]);
  await expect(bob.page.getByTestId("connection")).toBeVisible();

  await bob.context.setOffline(false);
  await expect(bob.page.getByTestId("connection")).toBeHidden();
  await send(alice, "Back online?");
  await expect(bodies(bob)).toHaveText(["Read me on the train", "Back online?"]);
});

test("a photo sent without a network survives closing the app and arrives once", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await openChat(bob, chat);
  await alice.page.evaluate(() => navigator.serviceWorker.ready);

  await alice.context.setOffline(true);
  await alice.page.getByTestId("photo-input").setInputFiles(fixture("photo.jpg"));
  const box = alice.page.getByLabel("Message", { exact: true });
  await box.fill("Taken in the tunnel");
  await box.press("Enter");
  await expect(alice.page.locator('[data-testid="message"][data-pending="true"]')).toHaveCount(1);
  await alice.page.waitForTimeout(1000);
  await alice.page.close();

  const page = await alice.context.newPage();
  await page.goto(`/chat/${chat}`);
  await expect(page.locator('[data-testid="message"][data-pending="true"]')).toHaveCount(1);
  await expect(page.getByTestId("message-body")).toHaveText(["Taken in the tunnel"]);

  await alice.context.setOffline(false);
  await expect(bob.page.getByTestId("photo")).toHaveCount(1);
  await expect(bodies(bob)).toHaveText(["Taken in the tunnel"]);
  await expect(page.locator('[data-testid="message"][data-pending="true"]')).toHaveCount(0);
  await bob.page.reload();
  await expect(bob.page.getByTestId("photo")).toHaveCount(1);
});

test("signing out leaves nothing of the account on the device", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  await startChat(alice, bob);
  await send(alice, "private");
  await alice.page.waitForTimeout(800);
  const saved = () => alice.page.evaluate(() => new Promise<number>((resolve) => {
    const req = indexedDB.open("tapalog-messenger");
    req.onsuccess = () => {
      const count = req.result.transaction("kv").objectStore("kv").count();
      count.onsuccess = () => resolve(count.result);
    };
  }));
  expect(await saved()).toBeGreaterThan(0);

  await alice.page.getByTestId("settings").click();
  await alice.page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(alice.page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect.poll(saved).toBe(0);
});
