import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { inviteCode } from "./server";

let counter = 0;

/** A username no other test or browser in this run will pick. */
export function uniqueName(base: string): string {
  return `${base}${process.pid.toString(36)}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 32);
}

export interface Person {
  name: string;
  username: string;
  context: BrowserContext;
  page: Page;
}

/** A new browser profile that signs up through an invite link, in English. */
export async function signUp(browser: Browser, name: string, opts: { baseURL?: string; invite?: string; locale?: string } = {}): Promise<Person> {
  const baseURL = opts.baseURL ?? "http://localhost:18443";
  const context = await browser.newContext({ baseURL, locale: opts.locale ?? "en-US" });
  const page = await context.newPage();
  const username = uniqueName(name.toLowerCase());
  await page.goto(`/invite/${opts.invite ?? (await inviteCode(baseURL))}`);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Create your account" }).click();
  await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
  await expect(page.getByTestId("connection")).toBeHidden();
  return { name, username, context, page };
}

/** The same account on another device (a separate browser profile). */
export async function signIn(browser: Browser, who: Person, baseURL = "http://localhost:18443"): Promise<Person> {
  const context = await browser.newContext({ baseURL, locale: "en-US" });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
  return { ...who, context, page };
}

/** From `from`'s screen: find `to` and open the direct chat. Returns the chat id. */
export async function startChat(from: Person, to: Person): Promise<number> {
  await from.page.getByTestId("new-chat").click();
  await from.page.getByLabel("Find people by name").fill(to.username);
  await from.page.getByTestId("person").filter({ hasText: to.username }).click();
  await expect(from.page.getByTestId("chat-title")).toContainText(to.name);
  return Number(new URL(from.page.url()).pathname.split("/")[2]);
}

export async function openChat(who: Person, chatId: number) {
  await who.page.locator(`[data-testid="chat-row"][data-chat="${chatId}"]`).click();
  await expect(who.page.getByTestId("chat-view")).toHaveAttribute("data-chat", String(chatId));
}

export async function send(who: Person, text: string) {
  const box = who.page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await box.press("Enter");
}

/** Message texts in the open chat, top to bottom. */
export function bodies(who: Person) {
  return who.page.getByTestId("message-body");
}
