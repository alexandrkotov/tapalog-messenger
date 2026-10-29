import { expect, test } from "@playwright/test";
import { bodies, openChat, send, signIn, signUp, startChat, type Person } from "./people";

/** Sends `count` numbered messages and waits until the server has them all. */
async function chatter(who: Person, word: string, count: number) {
  for (let i = 1; i <= count; i++) await send(who, `${word} ${i}`);
  await expect(who.page.locator('[data-testid="message"][data-pending="true"]')).toHaveCount(0, { timeout: 30_000 });
}

test("a message found in all chats opens in its place, far back in the history", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await signUp(browser, "Alice");
  let bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await send(alice, "Встретимся у фонтана в шесть");
  // More than one page of history after it, so the chat opens far from it.
  await openChat(bob, chat);
  await Promise.all([chatter(alice, "заметка", 26), chatter(bob, "ответ", 26)]);
  // Searched from another device, which has none of this history yet.
  bob = await signIn(browser, bob);

  const search = bob.page.getByLabel("Search", { exact: true });
  await search.fill("ab");
  await expect(bob.page.getByTestId("search-problem")).toHaveText("Type at least three letters to search all chats.");

  await search.fill("ФОНТАН");
  const found = bob.page.getByTestId("found-message");
  await expect(found).toHaveCount(1);
  await expect(found).toContainText("Alice");
  await expect(found.locator("mark")).toHaveText("фонтан");
  await found.click();

  const target = bob.page.getByTestId("message").filter({ hasText: "Встретимся у фонтана" });
  await expect(target).toBeInViewport();
  await expect(bob.page.getByTestId("to-latest")).toBeVisible();

  // Something new arrives meanwhile; it shows once the reader is back at the end.
  await send(alice, "уже на месте");
  await expect(alice.page.getByTestId("message").last()).not.toHaveAttribute("data-pending", "true");
  await bob.page.getByTestId("to-latest").click();
  await expect(bodies(bob).last()).toHaveText("уже на месте");
  await expect(bob.page.getByTestId("to-latest")).toBeHidden();
  await expect(target).toHaveCount(0);
});

test("search in one chat steps through the hits, newest first", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await send(alice, "Встретимся у фонтана в шесть");
  await chatter(alice, "заметка", 55);
  await send(alice, "Фонтан сегодня закрыт");
  await openChat(bob, chat);

  await bob.page.getByTestId("chat-search").click();
  await bob.page.getByTestId("chat-search-input").fill("фонтан");
  const status = bob.page.getByTestId("chat-search-status");
  await expect(status).toHaveText("1 of 2");
  await expect(bob.page.locator('[data-testid="message"][data-hit="true"]')).toContainText("Фонтан сегодня закрыт");

  await bob.page.getByTestId("found-older").click();
  await expect(status).toHaveText("2 of 2");
  const first = bob.page.locator('[data-testid="message"][data-hit="true"]');
  await expect(first).toContainText("Встретимся у фонтана");
  await expect(first).toBeInViewport();
  await expect(bob.page.getByTestId("found-older")).toBeDisabled();

  // Short words work inside one chat.
  await bob.page.getByTestId("chat-search-input").fill("в");
  await expect(status).toHaveText(/^1 of \d+/);

  // Writing from older history brings the chat back to its end.
  await bob.page.getByTestId("chat-search-input").press("Escape");
  await bob.page.getByTestId("chat-search").click();
  await bob.page.getByTestId("chat-search-input").fill("фонтана");
  await expect(status).toHaveText("1 of 1");
  await expect(bob.page.getByTestId("to-latest")).toBeVisible();
  await send(bob, "иду");
  await expect(bodies(bob).last()).toHaveText("иду");
  await expect(bob.page.getByTestId("to-latest")).toBeHidden();
});
