import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { bodies, openChat, signUp, startChat, type Person } from "./people";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function attach(who: Person, kind: "photo" | "file", ...names: string[]) {
  await who.page.getByTestId(`${kind}-input`).setInputFiles(names.map(fixture));
  await expect(who.page.getByTestId("attachment")).toHaveCount(names.length);
}

async function submit(who: Person, caption = "") {
  const box = who.page.getByLabel("Message", { exact: true });
  await box.fill(caption);
  await box.press("Enter");
}

/** The media id behind the last message's photo, file or voice. */
async function lastMediaId(page: Page): Promise<string> {
  const src = await page
    .getByTestId("message")
    .last()
    .evaluate((el) => el.querySelector("img")?.getAttribute("src") ?? el.querySelector("a.file-card")?.getAttribute("href") ?? el.querySelector("audio")?.getAttribute("src"));
  return src!.split("/")[2]!.split("?")[0]!;
}

test("a photo arrives as a preview at its own proportions and opens in full", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await openChat(bob, chat);

  await attach(alice, "photo", "photo.jpg");
  await submit(alice, "Sunset");
  await expect(alice.page.locator('[data-testid="message"][data-pending="true"]')).toHaveCount(0);

  const photo = bob.page.getByTestId("photo");
  await expect(photo).toBeVisible();
  await expect(bodies(bob)).toHaveText(["Sunset"]);
  // 3000×1500 shown 2:1 straight away, from the sizes in the message, not after the picture loads.
  const box = (await photo.boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(2, 1);
  await expect(photo.locator("img")).toHaveAttribute("src", /\/thumb$/);
  await expect(bob.page.getByTestId("chat-row").first()).toContainText("Photo: Sunset");

  // Re-encoded in the browser to at most 2560 px, as WebP, or as JPEG where the browser cannot write WebP.
  const id = await lastMediaId(bob.page);
  const full = await bob.page.request.get(`/media/${id}`);
  expect(["image/webp", "image/jpeg"]).toContain(full.headers()["content-type"]);
  expect((await full.body()).length).toBeLessThan(readFileSync(fixture("photo.jpg")).length * 2);

  await bob.page.setViewportSize({ width: 390, height: 844 });
  await photo.click();
  const viewed = bob.page.getByTestId("viewer-photo");
  await expect(viewed).toBeInViewport({ ratio: 1 });
  expect(await viewed.evaluate((img: HTMLImageElement) => img.decode().then(() => [img.naturalWidth, img.naturalHeight]))).toEqual([2560, 1280]);
  await bob.page.keyboard.press("Escape");
  await expect(bob.page.getByTestId("viewer")).toBeHidden();
});

test("a file arrives byte for byte, and nobody outside the chat can fetch it", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const eve = await signUp(browser, "Eve");
  const chat = await startChat(alice, bob);
  await openChat(bob, chat);

  await alice.page.getByTestId("attach").click();
  await attach(alice, "file", "report.pdf");
  await submit(alice);

  const card = bob.page.getByTestId("file-card");
  await expect(card).toContainText("report.pdf");
  await expect(card).toContainText("591 B");
  const [download] = await Promise.all([bob.page.waitForEvent("download"), card.click()]);
  expect(download.suggestedFilename()).toBe("report.pdf");
  const path = await download.path();
  expect(readFileSync(path).equals(readFileSync(fixture("report.pdf")))).toBe(true);

  const id = await lastMediaId(bob.page);
  expect((await bob.page.request.get(`/media/${id}`)).status()).toBe(200);
  expect((await eve.page.request.get(`/media/${id}`)).status()).toBe(404);
});

test("several photos go as separate messages, the caption with the first", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await openChat(bob, chat);

  await attach(alice, "photo", "photo.jpg", "photo.jpg");
  await submit(alice, "Two of them");
  await expect(bob.page.getByTestId("photo")).toHaveCount(2);
  await expect(bodies(bob)).toHaveText(["Two of them"]);
  await expect(bob.page.getByTestId("message").first().getByTestId("message-body")).toHaveText("Two of them");

  // "Send as files": the original goes untouched.
  await attach(alice, "photo", "photo.jpg");
  await alice.page.getByTestId("send-as-files").check();
  await submit(alice);
  await expect(bob.page.getByTestId("file-card")).toContainText("photo.jpg");
  const id = await lastMediaId(bob.page);
  expect((await (await bob.page.request.get(`/media/${id}`)).body()).equals(readFileSync(fixture("photo.jpg")))).toBe(true);
});

test("text written right after a photo does not overtake it", async ({ browser }) => {
  const alice = await signUp(browser, "Alice");
  const bob = await signUp(browser, "Bob");
  const chat = await startChat(alice, bob);
  await openChat(bob, chat);

  await attach(alice, "photo", "photo.jpg");
  await submit(alice);
  await attach(alice, "file", "report.pdf");
  await submit(alice);
  await submit(alice, "and some text");
  await expect(bob.page.getByTestId("message")).toHaveCount(3);
  const kinds = await bob.page
    .getByTestId("message")
    .evaluateAll((els) => els.map((el) => (el.querySelector("[data-testid=photo]") ? "photo" : el.querySelector("[data-testid=file-card]") ? "file" : "text")));
  expect(kinds).toEqual(["photo", "file", "text"]);
});

test("each browser plays the voice formats browsers record", async ({ page, browserName }) => {
  await page.goto("/");
  // Chrome and Firefox record Opus in WebM or Ogg; Safari records WebM or, before 18.4, AAC in MP4.
  // The open-source Chromium and Firefox builds Playwright runs have no AAC, unlike Chrome and Firefox
  // as people install them, so MP4 is only required where Safari's engine runs.
  const formats = browserName === "webkit" ? ["voice.webm", "voice.ogg", "voice.m4a"] : ["voice.webm", "voice.ogg"];
  for (const name of formats) {
    const bytes = [...readFileSync(fixture(name))];
    const seconds = await page.evaluate(async (data) => {
      const ctx = new AudioContext();
      const audio = await ctx.decodeAudioData(new Uint8Array(data).buffer);
      void ctx.close();
      return audio.duration;
    }, bytes);
    expect(seconds, name).toBeCloseTo(2, 0);
  }
});

test.describe("recording", () => {
  test.skip(({ browserName }) => browserName === "webkit", "Playwright's WebKit has no fake microphone");

  test("a voice message is recorded, sent and played in place", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    const bob = await signUp(browser, "Bob");
    const chat = await startChat(alice, bob);
    await openChat(bob, chat);

    await alice.page.getByTestId("record").click();
    await expect(alice.page.getByTestId("recording")).toBeVisible();
    await alice.page.waitForTimeout(1500);
    await alice.page.getByTestId("record-send").click();
    await expect(alice.page.getByTestId("voice")).toBeVisible();
    await expect(alice.page.locator('[data-testid="message"][data-pending="true"]')).toHaveCount(0);

    const voice = bob.page.getByTestId("voice");
    await expect(voice).toBeVisible();
    await expect(voice).toContainText(/0:0[1-2]/);
    await expect(bob.page.getByTestId("chat-row").first()).toContainText("Voice message");
    await voice.getByTestId("voice-play").click();
    await expect.poll(() => voice.getByTestId("voice-audio").evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.2);
  });

  test("cancelling a recording sends nothing", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    const bob = await signUp(browser, "Bob");
    await startChat(alice, bob);
    await alice.page.getByTestId("record").click();
    await alice.page.waitForTimeout(500);
    await alice.page.getByTestId("record-cancel").click();
    await expect(alice.page.getByTestId("record")).toBeVisible();
    await expect(alice.page.getByTestId("message")).toHaveCount(0);
  });
});
