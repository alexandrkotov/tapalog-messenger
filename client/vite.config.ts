import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// `bun run dev` here serves the client with hot reload and forwards server
// routes to a server started separately on the default port.
const SERVER = "http://localhost:8443";

export default defineConfig({
  plugins: [preact()],
  build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets" },
  server: { proxy: { "/healthz": SERVER, "/api": SERVER, "/ws": { target: SERVER, ws: true } } },
});
