/** See main.compiled.linux-x64.ts — the same for windows-x64. */
import { registerEmbeddedCloudflared } from "./embedded";
// @ts-ignore — exists only after fetch-cloudflared.ts has run
import cloudflared from "../../vendor/cloudflared-windows-x64.exe" with { type: "file" };

registerEmbeddedCloudflared(cloudflared as unknown as string);
await import("./main");
