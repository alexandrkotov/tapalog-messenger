import { expect, test } from "@playwright/test";
import { signUp, startChat } from "./people";

test("notifications turn on and off from Settings", async ({ browser, browserName }) => {
  // Headless browsers have no push service to reach and always refuse
  // notifications, so the permission and the subscription are stand-ins (with
  // real keys). What is checked is the app's side: asking, handing the
  // subscription to the server, and taking it back.
  test.skip(browserName !== "chromium", "the stand-ins are written against Chromium's push API");
  const alice = await signUp(browser, "Alice");
  await alice.context.addInitScript(() => {
    let permission: NotificationPermission = "default";
    Object.defineProperty(Notification, "permission", { get: () => permission });
    Notification.requestPermission = async () => (permission = "granted");
    let sub: PushSubscription | null = null;
    PushManager.prototype.getSubscription = async () => sub;
    PushManager.prototype.subscribe = async function (options) {
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const keys = { p256dh: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
      const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${Math.random().toString(36).slice(2)}`;
      sub = {
        endpoint,
        options: { ...options, applicationServerKey: options?.applicationServerKey },
        toJSON: () => ({ endpoint, keys }),
        unsubscribe: async () => ((sub = null), true),
      } as unknown as PushSubscription;
      return sub;
    };
  });
  await alice.page.reload();
  await alice.page.getByTestId("settings").click();
  const state = alice.page.getByTestId("push-state");
  await expect(state).toHaveAttribute("data-state", "off");

  const saved = alice.page.waitForResponse((r) => r.url().endsWith("/api/push/subscribe") && r.request().method() === "POST");
  await alice.page.getByRole("button", { name: "Turn on" }).click();
  expect((await saved).status()).toBe(201);
  await expect(state).toHaveAttribute("data-state", "on");

  const removed = alice.page.waitForResponse((r) => r.url().endsWith("/api/push/subscribe") && r.request().method() === "DELETE");
  await alice.page.getByRole("button", { name: "Turn off" }).click();
  expect((await removed).status()).toBe(200);
  await expect(state).toHaveAttribute("data-state", "off");
});

test("a chat can be muted, and stays muted", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  const row = alice.page.locator(`[data-testid="chat-row"][data-chat="${chat}"]`);
  await expect(row.getByTestId("muted")).toHaveCount(0);

  await alice.page.getByTestId("chat-title").click();
  // The info page says whose it is, and the list keeps that chat marked.
  await expect(alice.page.getByTestId("chat-info")).toContainText("Bob");
  await expect(row).toHaveClass(/active/);
  await alice.page.getByLabel("Don't notify me about this chat").check();
  await expect(row.getByTestId("muted")).toBeVisible();
  await alice.page.reload();
  await expect(row.getByTestId("muted")).toBeVisible();
  await expect(alice.page.getByLabel("Don't notify me about this chat")).toBeChecked();

  await alice.page.getByLabel("Don't notify me about this chat").uncheck();
  await expect(row.getByTestId("muted")).toHaveCount(0);
});
