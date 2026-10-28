import { afterAll, describe, expect, it } from "bun:test";
import { LIMITS } from "@tapalog-messenger/shared";
import { ByteBudget, cleanMime, cleanName, parseRange } from "../src/files";
import { Client, testServer } from "./helpers";

const t = testServer();
afterAll(() => t.server.stop());
let n = 0;
const newUser = (name: string) => new Client(t.base).register(t.invite(), `${name}${++n}`);

/** A raw-body request the way the client's uploader sends it. */
async function raw(c: Client | null, method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  const res = await fetch(t.base + path, { method, body, headers: { Origin: t.base, ...(c?.cookie && { Cookie: c.cookie }), ...headers } });
  return res;
}

async function upload(c: Client, content: string, mime = "image/jpeg", query = "name=photo.jpg&width=800&height=600") {
  const res = await raw(c, "POST", `/api/media?${query}`, content, { "Content-Type": mime });
  return { status: res.status, data: (await res.json()) as any };
}

async function sendWith(c: Client, chat: number, kind: string, media: string) {
  const ws = await c.connect();
  ws.send({ t: "msg.send", chat, client_id: crypto.randomUUID(), kind, body: "", media });
  const res = await Promise.race([ws.next("msg.new").then((f) => f.msg), ws.next("error")]);
  ws.close();
  return res;
}

async function directChat(a: Client, b: Client): Promise<number> {
  return (await a.call("POST", "/api/chats", { kind: "direct", user: b.id })).data.id;
}

describe("uploading", () => {
  it("refuses a file over the limit", async () => {
    const alice = await newUser("alice");
    const res = await upload(alice, "x".repeat(LIMITS.fileBytes + 1), "application/zip", "name=big.zip");
    expect(res).toMatchObject({ status: 413, data: { error: "too_large" } });
  });

  it("stores the file and answers with what messages will carry", async () => {
    const alice = await newUser("alice");
    const res = await upload(alice, "jpeg bytes", "image/jpeg; charset=whatever", "name=..%2Fholiday%0A.jpg&width=800&height=600");
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ id: expect.stringMatching(/^[\w-]{22}$/), mime: "image/jpeg", size: 10, name: "..holiday.jpg", width: 800, height: 600, duration_ms: null, waveform: null, thumb: false });

    const voice = await upload(alice, "ogg", "audio/ogg", "name=voice.ogg&duration_ms=4200&waveform=0,50,100");
    expect(voice.data).toMatchObject({ mime: "audio/ogg", duration_ms: 4200, waveform: [0, 50, 100] });
  });

  it("needs a session, our Origin, sane numbers and some bytes", async () => {
    const alice = await newUser("alice");
    expect((await raw(null, "POST", "/api/media", "x")).status).toBe(401);
    expect((await raw(alice, "POST", "/api/media", "x", { Origin: "https://evil.example" })).status).toBe(403);
    for (const q of ["width=-1", "height=1.5", "width=abc", "duration_ms=0", "waveform=1,2,300", `waveform=${Array(101).fill(1).join(",")}`]) {
      expect((await upload(alice, "x", "image/png", q)).status).toBe(400);
    }
    expect((await raw(alice, "POST", "/api/media", "")).status).toBe(400);
  });

  it("adds a preview until the photo is sent, and only for its uploader", async () => {
    const [alice, bob] = [await newUser("alice"), await newUser("bob")];
    const photo = (await upload(alice, "big photo")).data;
    expect((await raw(bob, "PUT", `/api/media/${photo.id}/thumb`, "small", { "Content-Type": "image/webp" })).status).toBe(404);
    expect((await raw(alice, "PUT", `/api/media/${photo.id}/thumb`, "<svg/>", { "Content-Type": "image/svg+xml" })).status).toBe(400);
    const put = await raw(alice, "PUT", `/api/media/${photo.id}/thumb`, "small", { "Content-Type": "image/webp" });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).thumb).toBe(true);

    await sendWith(alice, await directChat(alice, bob), "image", photo.id);
    expect((await raw(alice, "PUT", `/api/media/${photo.id}/thumb`, "other", { "Content-Type": "image/webp" })).status).toBe(403);
  });
});

describe("downloading", () => {
  it("only the uploader and the chat's members get the file", async () => {
    const [alice, bob, eve] = [await newUser("alice"), await newUser("bob"), await newUser("eve")];
    const photo = (await upload(alice, "the photo bytes")).data;
    expect((await raw(alice, "GET", `/media/${photo.id}`)).status).toBe(200);
    expect((await raw(bob, "GET", `/media/${photo.id}`)).status).toBe(404);

    const msg = await sendWith(alice, await directChat(alice, bob), "image", photo.id);
    expect(msg).toMatchObject({ kind: "image", media: { id: photo.id } });
    const got = await raw(bob, "GET", `/media/${photo.id}`);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("the photo bytes");
    expect((await raw(eve, "GET", `/media/${photo.id}`)).status).toBe(404);
    expect((await raw(null, "GET", `/media/${photo.id}`)).status).toBe(401);
    expect((await raw(bob, "GET", "/media/not-an-id")).status).toBe(404);
  });

  it("shows pictures and sound in place and makes everything else a download", async () => {
    const alice = await newUser("alice");
    const photo = (await upload(alice, "jpeg")).data;
    const page = (await upload(alice, "<script>alert(1)</script>", "text/html", "name=page.html")).data;

    const inline = await raw(alice, "GET", `/media/${photo.id}`);
    expect(inline.headers.get("Content-Type")).toBe("image/jpeg");
    expect(inline.headers.get("Content-Disposition")).toBe("inline; filename*=UTF-8''photo.jpg");
    expect(inline.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(inline.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(inline.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");

    expect((await raw(alice, "GET", `/media/${page.id}`)).headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''page.html");
    expect((await raw(alice, "GET", `/media/${photo.id}?download`)).headers.get("Content-Disposition")).toStartWith("attachment;");
  });

  it("answers byte ranges so a voice message can seek", async () => {
    const alice = await newUser("alice");
    const voice = (await upload(alice, "0123456789", "audio/ogg", "name=v.ogg")).data;
    const part = await raw(alice, "GET", `/media/${voice.id}`, undefined, { Range: "bytes=2-5" });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
    expect(await (await raw(alice, "GET", `/media/${voice.id}`, undefined, { Range: "bytes=-3" })).text()).toBe("789");
    const bad = await raw(alice, "GET", `/media/${voice.id}`, undefined, { Range: "bytes=20-" });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe("bytes */10");
  });

  it("serves the preview separately", async () => {
    const alice = await newUser("alice");
    const photo = (await upload(alice, "big")).data;
    expect((await raw(alice, "GET", `/media/${photo.id}/thumb`)).status).toBe(404);
    await raw(alice, "PUT", `/api/media/${photo.id}/thumb`, "small", { "Content-Type": "image/webp" });
    const thumb = await raw(alice, "GET", `/media/${photo.id}/thumb`);
    expect([thumb.status, thumb.headers.get("Content-Type"), await thumb.text()]).toEqual([200, "image/webp", "small"]);
  });
});

describe("helpers", () => {
  it("parses one byte range", () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange("bytes=0-0", 10)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=5-100", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=-100", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("bytes=7-3", 10)).toBe("bad");
    expect(parseRange("bytes=10-", 10)).toBe("bad");
    expect(parseRange("bytes=-", 10)).toBe("bad");
  });

  it("cleans types and names", () => {
    expect(cleanMime("Audio/WebM;codecs=opus")).toBe("audio/webm");
    expect(cleanMime(null)).toBe("application/octet-stream");
    expect(cleanMime("text/html\r\nX-Evil: 1")).toBe("application/octet-stream");
    expect(cleanName("C:\\Users\\me\\отчёт.pdf")).toBe("C:Usersmeотчёт.pdf");
    expect(cleanName("  ")).toBe("file");
    expect(cleanName("a".repeat(300))).toHaveLength(LIMITS.fileName);
  });

  it("counts upload bytes per person per hour", () => {
    const budget = new ByteBudget(100);
    budget.spend(1, 70, 0);
    expect(budget.left(1, 1000)).toBe(30);
    expect(budget.left(2, 1000)).toBe(100);
    expect(budget.left(1, 3600 * 1000 + 1)).toBe(100);
  });
});
