import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { APP_ID, type HealthResponse } from "@tapalog-messenger/shared";
import pkg from "../package.json";
import { generateAdminKey, readAdminKey, writeAdminKey } from "./adminKey";
import { ArgsError, parseArgs, USAGE } from "./args";
import { inviteDto } from "./api";
import { assets } from "./clientAssets.gen";
import { readConfig, writeConfig, type Config } from "./config";
import { ensureDataDir, isCompiled, resolveDataDir } from "./dataDir";
import { openDatabase, schemaVersion } from "./db";
import { cleanUpExtracted, cloudflaredPath } from "./embedded";
import { openInBrowser } from "./openInBrowser";
import { startServer, type ServerHandle } from "./server";
import { createInvite, ensureSetupInvite } from "./store/accounts";
import { startTunnel, type Tunnel, type TunnelMode, type TunnelState } from "./tunnel";

function isPortInUse(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EADDRINUSE";
}

/** True when whatever holds the port answers /healthz the way this app does. */
async function isOwnServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as Partial<HealthResponse>;
    return body.app === APP_ID;
  } catch {
    return false;
  }
}

/** CI: proves the embedded cloudflared comes out of the binary and runs on this OS. */
async function checkTunnelBinary(): Promise<number> {
  const path = await cloudflaredPath();
  const proc = Bun.spawnSync([path, "--version"], { windowsHide: true });
  console.log(`${path}: ${proc.stdout.toString().trim() || proc.stderr.toString().trim()}`);
  cleanUpExtracted();
  return proc.exitCode === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.version) {
    console.log(pkg.version);
    return 0;
  }
  if (args.checkTunnelBinary) return checkTunnelBinary();

  console.log(`Tapalog Messenger ${pkg.version}`);
  const dataDir = resolveDataDir({ flag: args.data, execPath: process.execPath, compiled: isCompiled(), cwd: process.cwd(), home: homedir() });
  ensureDataDir(dataDir);

  let config: Config;
  try {
    config = readConfig(dataDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
  // Flags given once are remembered, so the next start can be a plain double-click.
  const previousUrl = config.public_url ?? null;
  const next: Config = { ...config };
  if (args.publicUrl) next.public_url = args.publicUrl;
  if (args.tunnelToken) next.tunnel_token = args.tunnelToken;
  if (args.forgetTunnel) delete next.tunnel_token;
  if (JSON.stringify(next) !== JSON.stringify(config)) {
    writeConfig(dataDir, next);
    config = next;
  }
  if (args.forgetTunnel) console.log("  Tunnel token deleted.");

  const tunnelMode: TunnelMode | null = args.quickTunnel
    ? { kind: "quick" }
    : config.tunnel_token && !args.noTunnel && !args.forgetTunnel
      ? { kind: "named", token: config.tunnel_token }
      : null;
  if (tunnelMode?.kind === "named" && !config.public_url) {
    console.error("The tunnel needs its address once: start with --public-url https://<the tunnel's hostname>, e.g. https://messenger.tapalog.com");
    return 2;
  }
  // A quick tunnel's address is only known once it connects.
  const initialPublicUrl = tunnelMode?.kind === "quick" ? null : (config.public_url ?? null);
  // Installed apps, sign-ins and notifications are tied to the address; say so when it moves.
  const addressChangedFrom = args.publicUrl && previousUrl && previousUrl !== args.publicUrl ? previousUrl : null;

  let db: Database;
  try {
    db = openDatabase(dataDir);
  } catch (err) {
    // Seen live: a Windows build started from a \\wsl$ share fails here with
    // SQLITE_BUSY, because WAL mode needs shared memory that network file
    // systems do not provide.
    console.error(`Cannot open the database in ${dataDir}: ${err instanceof Error ? err.message : err}`);
    console.error("If this folder is on a network drive or a shared path, move the program to a local disk or start it with --data <local folder>.");
    return 1;
  }
  const schema = schemaVersion(db);
  console.log(`  Data:  ${dataDir}`);

  const localUrl = `http://localhost:${args.port}`;
  const startedAt = new Date().toISOString();
  let server: ServerHandle;
  let tunnel: Tunnel | null = null;
  let tunnelState: TunnelState | null = null;
  const inviteBase = () => server.publicUrl() ?? localUrl;
  const adminKey = generateAdminKey();
  try {
    server = startServer({
      port: args.port,
      assets,
      adminKey,
      db,
      publicUrl: initialPublicUrl,
      trustCfConnectingIp: tunnelMode !== null,
      health: { app: APP_ID, ok: true, version: pkg.version, schema },
      status: () => {
        const setup = ensureSetupInvite(db, Date.now());
        return {
          version: pkg.version,
          schema,
          localUrl,
          publicUrl: server.publicUrl(),
          setupInviteUrl: setup && inviteDto(setup, inviteBase()).url,
          tunnel: tunnelMode && { kind: tunnelMode.kind, ...(tunnelState ?? { state: "starting" as const }) },
          addressChangedFrom,
          dataDir,
          startedAt,
        };
      },
      onShutdownRequested: () => shutdown(),
    });
  } catch (err) {
    db.close();
    if (!isPortInUse(err)) throw err;
    if (await isOwnServer(args.port)) {
      // A second double-click: show the running instance instead of failing.
      // Its key is the one it wrote last, unless it uses another data folder.
      console.log(`  Already running on port ${args.port}; opening its status page.`);
      const key = readAdminKey(dataDir);
      if (args.open) openInBrowser(key ? `${localUrl}/status?key=${key}` : localUrl);
      return 0;
    }
    console.error(`  Port ${args.port} is used by another program. Start with --port <n> to pick a different one.`);
    return 1;
  }

  writeAdminKey(dataDir, adminKey);
  const statusUrl = `${localUrl}/status?key=${adminKey}`;
  console.log(`  Local: ${localUrl}`);
  if (server.publicUrl()) console.log(`  Public: ${server.publicUrl()}`);
  if (addressChangedFrom) console.log(`  The public address changed from ${addressChangedFrom}: installed apps and notifications must be set up again.`);
  const setup = ensureSetupInvite(db, Date.now());
  if (setup) console.log(`  Create the first account (admin): ${inviteDto(setup, inviteBase()).url}`);
  if (args.invite) {
    const row = createInvite(db, { createdBy: null, grantsAdmin: true, maxUses: 1, expiresAt: Date.now() + 24 * 3600 * 1000, now: Date.now() });
    console.log(`  Admin invite, one use, valid 24 hours: ${inviteDto(row, inviteBase()).url}`);
  }
  console.log(`  Status page (keep this link private): ${statusUrl}`);
  if (args.open) openInBrowser(statusUrl);

  if (tunnelMode) {
    if (tunnelMode.kind === "quick") console.log("  Quick tunnel: a new address on every start. For a demo only; installed apps will not survive a restart.");
    const cloudflared = await cloudflaredPath();
    let lastLine = "";
    tunnel = startTunnel({
      cloudflared,
      mode: tunnelMode,
      localUrl,
      onState: (s) => {
        tunnelState = s;
        if (s.state === "connected" && s.url) server.setPublicUrl(s.url);
        const line = s.state === "connected" ? `  Tunnel connected: ${server.publicUrl()}` : s.state === "down" ? `  Tunnel down: ${s.message}` : "";
        if (line && line !== lastLine) console.log(line);
        lastLine = line;
      },
    });
  }

  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log("Shutting down…");
    // The server first, so clients hear "going away" while the tunnel still carries it.
    void server
      .stop()
      .then(() => tunnel?.stop())
      .then(() => {
        db.close();
        cleanUpExtracted();
        process.exit(0);
      });
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return -1; // keep running
}

const code = await main();
if (code >= 0) process.exit(code);
