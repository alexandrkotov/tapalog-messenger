import { expect, test, type Page } from "@playwright/test";

/** Resolves once a service worker controls the page — after that, reloads are served from its cache. */
async function waitForServiceWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
    }
  });
}

test("opens the sign-in screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tapalog Messenger" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test.describe("in Russian", () => {
  test.use({ locale: "ru-RU" });
  test("speaks the browser's language", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Войти" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  });
});

test.describe("in Ukrainian", () => {
  test.use({ locale: "uk-UA" });
  test("speaks the browser's language", async ({ page }) => {
    await page.goto("/invite/whatever");
    await expect(page.getByRole("heading", { name: "Створіть акаунт" })).toBeVisible();
  });
});

test("links an installable web app manifest", async ({ page, request }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");
  const manifest = await (await request.get(href!)).json();
  expect(manifest).toMatchObject({ name: "Tapalog Messenger", start_url: "/", display: "standalone" });
  for (const icon of manifest.icons as { src: string }[]) {
    const res = await request.get(icon.src);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
  }
});

test("opens offline after the first visit", async ({ page, context }) => {
  await page.goto("/");
  await waitForServiceWorker(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Tapalog Messenger" })).toBeVisible();
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "offline");
  await context.setOffline(false);
});

test("a deep link reloads into the app shell", async ({ page }) => {
  await page.goto("/chat/42");
  await expect(page.getByRole("heading", { name: "Tapalog Messenger" })).toBeVisible();
});

test("the status page and shutdown are closed without the admin key", async ({ request }) => {
  expect((await request.get("/status")).status()).toBe(403);
  expect((await request.get("/status.json")).status()).toBe(403);
  expect((await request.post("/shutdown")).status()).toBe(403);
  expect((await request.post("/admin/invite")).status()).toBe(403);
  expect((await request.get("/healthz")).status()).toBe(200);
});
