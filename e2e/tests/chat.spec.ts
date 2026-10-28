import { expect, test } from "@playwright/test";
import { bodies, openChat, send, signIn, signUp, startChat } from "./people";
import { OwnServer } from "./server";

test("Alice writes to Bob; Bob sees it; Alice's ticks turn to read", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);

  await send(alice, "Hello, Bob");
  await expect(bodies(alice)).toHaveText(["Hello, Bob"]);
  await expect(alice.page.getByTestId("ticks").last()).toHaveAttribute("data-tick", /sent|delivered/);

  // Bob's list shows the chat with one unread message; it reached his device.
  await expect(bob.page.locator(`[data-testid="chat-row"][data-chat="${chat}"]`).getByTestId("unread")).toHaveText("1");
  await expect(alice.page.getByTestId("ticks").last()).toHaveAttribute("data-tick", "delivered");

  await openChat(bob, chat);
  await expect(bodies(bob)).toHaveText(["Hello, Bob"]);
  await expect(alice.page.getByTestId("ticks").last()).toHaveAttribute("data-tick", "read");

  await send(bob, "Hi Alice");
  await expect(bodies(alice)).toHaveText(["Hello, Bob", "Hi Alice"]);
});

test("on a phone the chat fits the screen and typing does not zoom it", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  await alice.page.setViewportSize({ width: 390, height: 844 });
  await startChat(alice, bob);
  await send(alice, "Привет! Как дела? Пишу тебе с телефона, и это сообщение длиннее ширины экрана");
  await expect(bodies(alice)).toHaveCount(1);

  // iOS zooms the page when a focused field's text is under 16px, and keeps it zoomed (seen live).
  const sizes = await alice.page.locator("input, textarea, select").evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);
  const overflow = await alice.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
  await expect(alice.page.getByTestId("message-body").last()).toBeInViewport({ ratio: 1 });
});

test("a group of three sees every message in the same order", async ({ browser }) => {
  const [alice, bob, carol] = [await signUp(browser, "Alice"), await signUp(browser, "Bob"), await signUp(browser, "Carol")];
  await alice.page.getByTestId("new-chat").click();
  await alice.page.getByTestId("toggle-group").click();
  await alice.page.getByLabel("Group name").fill("Trio");
  for (const p of [bob, carol]) {
    await alice.page.getByLabel("Find people by name").fill(p.username);
    await alice.page.getByTestId("person").filter({ hasText: p.username }).click();
  }
  await alice.page.getByRole("button", { name: "Create" }).click();
  await expect(alice.page.getByTestId("chat-title")).toContainText("Trio");
  const chat = Number(new URL(alice.page.url()).pathname.split("/")[2]);

  await openChat(bob, chat);
  await openChat(carol, chat);
  await Promise.all([send(alice, "from alice"), send(bob, "from bob"), send(carol, "from carol")]);

  const everyone = [alice, bob, carol];
  for (const p of everyone) await expect(bodies(p)).toHaveCount(3);
  const orders = await Promise.all(everyone.map((p) => bodies(p).allTextContents()));
  expect(orders[1]).toEqual(orders[0]);
  expect(orders[2]).toEqual(orders[0]);
  expect([...orders[0]!].sort()).toEqual(["from alice", "from bob", "from carol"]);
});

test("messages written offline arrive once when the network is back", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await openChat(bob, chat);

  await alice.context.setOffline(true);
  await expect(alice.page.getByTestId("connection")).toBeVisible();
  for (const text of ["one", "two", "three"]) await send(alice, text);
  await expect(alice.page.locator('[data-testid="message"][data-pending="true"]')).toHaveCount(3);

  await alice.context.setOffline(false);
  await expect(bodies(bob)).toHaveText(["one", "two", "three"]);
  await expect(alice.page.locator('[data-testid="message"][data-pending="true"]')).toHaveCount(0);
  await expect(bodies(alice)).toHaveText(["one", "two", "three"]);
  // And nothing doubles up after a reload either.
  await bob.page.reload();
  await expect(bodies(bob)).toHaveText(["one", "two", "three"]);
});

test("after the server is killed and restarted, clients catch up", async ({ browser }, info) => {
  const server = new OwnServer(18500 + info.parallelIndex * 10 + ["chromium", "firefox", "webkit"].indexOf(info.project.name));
  await server.start();
  try {
    const alice = await signUp(browser, "Alice", { baseURL: server.url, invite: await server.invite() });
    const bob = await signUp(browser, "Bob", { baseURL: server.url, invite: await server.invite() });
    const chat = await startChat(alice, bob);
    await openChat(bob, chat);
    await send(alice, "before");
    await expect(bodies(bob)).toHaveText(["before"]);

    server.kill();
    await expect(alice.page.getByTestId("connection")).toBeVisible();
    await send(alice, "while down");
    await server.start();

    await expect(bodies(bob)).toHaveText(["before", "while down"], { timeout: 20_000 });
    await expect(bodies(alice)).toHaveText(["before", "while down"]);
    await expect(alice.page.locator('[data-testid="message"][data-pending="true"]')).toHaveCount(0);
  } finally {
    server.kill();
  }
});

test("two devices of one person show the same history and ticks", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await send(alice, "from the laptop");

  const phone = await signIn(browser, alice);
  await openChat(phone, chat);
  await expect(bodies(phone)).toHaveText(["from the laptop"]);
  await send(phone, "from the phone");
  await expect(bodies(alice)).toHaveText(["from the laptop", "from the phone"]);

  await openChat(bob, chat);
  for (const device of [alice, phone]) {
    const ticks = device.page.getByTestId("messages").getByTestId("ticks");
    await expect(ticks).toHaveCount(2);
    for (const tick of await ticks.all()) await expect(tick).toHaveAttribute("data-tick", "read");
  }
});

test("someone outside a chat cannot open it, even with the link", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const eve = await signUp(browser, "Eve");
  const chat = await startChat(alice, bob);
  await send(alice, "secret");

  await eve.page.goto(`/chat/${chat}`);
  await expect(eve.page.getByTestId("message-body")).toHaveCount(0);
  expect((await eve.page.request.get(`/api/chats/${chat}`)).status()).toBe(404);
  expect((await eve.page.request.get(`/api/chats/${chat}/messages`)).status()).toBe(404);
});

test("typing and online status show up for the other person", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await openChat(bob, chat);
  await expect(alice.page.getByTestId("chat-subtitle")).toHaveText("online");

  await bob.page.getByLabel("Message", { exact: true }).pressSequentially("hel");
  await expect(alice.page.getByTestId("chat-subtitle")).toHaveText("typing…");

  await bob.context.close();
  await expect(alice.page.getByTestId("chat-subtitle")).toHaveText(/^last seen /);
});

test("reply, edit, react and delete", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await openChat(bob, chat);
  await send(alice, "Lunch at 1?");
  await expect(bodies(bob)).toHaveText(["Lunch at 1?"]);

  await bob.page.getByTestId("message").first().locator(".bubble").click();
  await bob.page.getByRole("button", { name: "Reply" }).click();
  await send(bob, "Yes");
  await expect(alice.page.getByTestId("message").last().locator(".quote")).toContainText("Lunch at 1?");

  await alice.page.getByTestId("message").first().locator(".bubble").click();
  await alice.page.getByRole("button", { name: "Edit" }).click();
  await send(alice, "Lunch at 2?");
  await expect(bodies(bob).first()).toHaveText("Lunch at 2?");
  await expect(bob.page.getByTestId("message").first()).toContainText("edited");

  await bob.page.getByTestId("message").first().locator(".bubble").click();
  await bob.page.getByRole("button", { name: "👍" }).click();
  await expect(alice.page.getByTestId("reactions")).toHaveText("👍");

  alice.page.once("dialog", (d) => d.accept());
  await alice.page.getByTestId("message").first().locator(".bubble").click();
  await alice.page.getByRole("button", { name: "Delete" }).click();
  await expect(bodies(bob).first()).toHaveText("This message was deleted");
});

test("the interface follows the language picked in settings", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  await alice.page.getByTestId("settings").click();
  await alice.page.getByLabel("Language").selectOption("ru");
  await expect(alice.page.getByRole("heading", { name: "Чаты" })).toBeVisible();
  await alice.page.reload();
  await expect(alice.page.getByRole("heading", { name: "Чаты" })).toBeVisible();
});
