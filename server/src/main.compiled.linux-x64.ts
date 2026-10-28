/**
 * Entry point for `compile:linux-x64` only: embeds the pinned cloudflared (put into
 * vendor/ by scripts/fetch-cloudflared.ts) in the executable, so the person
 * running it never installs cloudflared. One such file per platform, because
 * the embedded file has to be a literal import. Dev mode (`bun src/main.ts`)
 * never loads these and needs no vendor/ folder.
 */
import { registerEmbeddedCloudflared } from "./embedded";
// @ts-ignore — exists only after fetch-cloudflared.ts has run
import cloudflared from "../../vendor/cloudflared-linux-x64" with { type: "file" };

registerEmbeddedCloudflared(cloudflared as unknown as string);
await import("./main");
