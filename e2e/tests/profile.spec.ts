import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { openChat, signUp, startChat } from "./people";

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
