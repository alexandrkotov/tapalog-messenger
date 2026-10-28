import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { APP_ID, type HealthResponse } from "@tapalog-messenger/shared";
import pkg from "../package.json";
import { generateAdminKey, readAdminKey, writeAdminKey } from "./adminKey";
import { ArgsError, parseArgs, USAGE } from "./args";
import { assets } from "./clientAssets.gen";
import { ensureDataDir, isCompiled, resolveDataDir } from "./dataDir";
import { openDatabase, schemaVersion } from "./db";
import { openInBrowser } from "./openInBrowser";
import { startServer, type ServerHandle } from "./server";

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

  console.log(`Tapalog Messenger ${pkg.version}`);
  const dataDir = resolveDataDir({ flag: args.data, execPath: process.execPath, compiled: isCompiled(), cwd: process.cwd(), home: homedir() });
  ensureDataDir(dataDir);
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
  const adminKey = generateAdminKey();
  try {
    server = startServer({
      port: args.port,
      assets,
      adminKey,
      health: { app: APP_ID, ok: true, version: pkg.version, schema },
      status: () => ({ version: pkg.version, schema, localUrl, dataDir, startedAt }),
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
  console.log(`  Status page (keep this link private): ${statusUrl}`);
  if (args.open) openInBrowser(statusUrl);

  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log("Shutting down…");
    void server.stop().then(() => {
      db.close();
      process.exit(0);
    });
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return -1; // keep running
}

const code = await main();
if (code >= 0) process.exit(code);
