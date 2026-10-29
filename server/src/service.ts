import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { APP_ID, type HealthResponse } from "@tapalog-messenger/shared";
import { DEFAULT_PORT, type ServiceAction } from "./args";
import { readConfig, withTurnFlags, writeConfig } from "./config";
import { DATA_DIR_NAME, isCompiled } from "./dataDir";

/**
 * `tapalog-messenger service …`: the messenger as a systemd service on a
 * Linux VPS, behind Caddy. Fixed places, so the README, the update and a
 * relative helping out all look in the same ones.
 */
export const SERVICE = {
  name: "tapalog-messenger",
  user: "tapalog",
  binary: "/usr/local/bin/tapalog-messenger",
  home: "/var/lib/tapalog-messenger",
  data: `/var/lib/tapalog-messenger/${DATA_DIR_NAME}`,
  unit: "/etc/systemd/system/tapalog-messenger.service",
} as const;

const HEALTH_WAIT_MS = 30_000;

class ServiceError extends Error {}

/** The unit file: its own user, writes only to its folder, restarts after a crash. */
export function unitFile(o: { publicUrl: string; port: number }): string {
  const exec = [SERVICE.binary, "--data", SERVICE.data, "--port", String(o.port), "--public-url", o.publicUrl, "--behind-proxy", "--no-tunnel", "--no-open"];
  return `[Unit]
Description=Tapalog Messenger
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE.user}
Group=${SERVICE.user}
ExecStart=${exec.join(" ")}
Restart=always
RestartSec=3
UMask=0027
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${SERVICE.home}
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
`;
}

/** The port the installed unit serves on, so an update knows where to look for /healthz. */
export function unitPort(unit: string): number {
  const m = /--port (\d+)/.exec(unit);
  return m ? Number(m[1]) : DEFAULT_PORT;
}

function run(cmd: string[], what = cmd.join(" ")): string {
  const p = Bun.spawnSync(cmd, { stderr: "pipe" });
  if (p.exitCode !== 0) throw new ServiceError(`${what} failed: ${p.stderr.toString().trim() || `exit code ${p.exitCode}`}`);
  return p.stdout.toString().trim();
}

const succeeds = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

/** Waits for the service to answer /healthz as this app, and as `version` when given. */
async function waitHealthy(port: number, version?: string): Promise<HealthResponse | null> {
  const until = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      const body = (await res.json()) as HealthResponse;
      if (body.app === APP_ID && (!version || body.version === version)) return body;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  return null;
}

/** Copies a file into place by renaming a finished copy over it, which also works while the old one runs. */
function placeBinary(from: string, to: string) {
  copyFileSync(from, `${to}.new`);
  chmodSync(`${to}.new`, 0o755);
  renameSync(`${to}.new`, to);
}

const statusHint = (port: number) =>
  [
    "  The status page is not reachable from outside. To open it, from your own computer:",
    `    ssh -L ${port}:127.0.0.1:${port} <you>@<this server>`,
    `    then http://localhost:${port}/status?key=<the key>`,
    `  The key: sudo cat ${SERVICE.data}/admin.key`,
    `  Log (first-account link, errors): journalctl -u ${SERVICE.name} -n 50`,
  ].join("\n");

async function install(publicUrl: string, port: number, turnUrls: string[], turnSecretFile: string | null) {
  if (!existsSync(SERVICE.binary) || realpathSync(process.execPath) !== realpathSync(SERVICE.binary)) placeBinary(process.execPath, SERVICE.binary);
  if (!succeeds(["id", "-u", SERVICE.user])) {
    run(["useradd", "--system", "--home-dir", SERVICE.home, "--no-create-home", "--shell", "/usr/sbin/nologin", SERVICE.user]);
  }
  run(["mkdir", "-p", SERVICE.data]);
  // Root reads the TURN secret here, so its file can stay readable by root and coturn only.
  if (turnUrls.length > 0 || turnSecretFile) writeConfig(SERVICE.data, withTurnFlags(readConfig(SERVICE.data), turnUrls, turnSecretFile));
  // Also data copied in by hand when moving from another computer.
  run(["chown", "-R", `${SERVICE.user}:${SERVICE.user}`, SERVICE.home]);
  chmodSync(SERVICE.home, 0o750);
  writeFileSync(SERVICE.unit, unitFile({ publicUrl, port }));
  run(["systemctl", "daemon-reload"]);
  run(["systemctl", "enable", SERVICE.name]);
  run(["systemctl", "restart", SERVICE.name]);
  const health = await waitHealthy(port);
  if (!health) throw new ServiceError(`The service did not start. See: journalctl -u ${SERVICE.name} -n 50`);
  console.log(`Installed and running: Tapalog Messenger ${health.version} at ${publicUrl}, on 127.0.0.1:${port}`);
  console.log(`  It starts by itself after a reboot. Data: ${SERVICE.data}`);
  console.log(statusHint(port));
}

async function update(file: string) {
  if (!existsSync(SERVICE.unit)) throw new ServiceError("The service is not installed. Run: sudo tapalog-messenger service install --public-url https://…");
  if (!existsSync(file)) throw new ServiceError(`No such file: ${file}`);
  const port = unitPort(readFileSync(SERVICE.unit, "utf-8"));
  const staged = `${SERVICE.binary}.new`;
  copyFileSync(file, staged);
  chmodSync(staged, 0o755);
  let next: string;
  try {
    next = run([staged, "--version"], `${file} --version`);
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  }
  const current = run([SERVICE.binary, "--version"]);
  // The database may be migrated by the new version, and an older binary cannot open a newer schema: this copy is the way back.
  try {
    console.log(run(["runuser", "-u", SERVICE.user, "--", SERVICE.binary, "backup", "--data", SERVICE.data], "Backup before the update"));
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  }
  copyFileSync(SERVICE.binary, `${SERVICE.binary}.prev`);
  renameSync(staged, SERVICE.binary);
  run(["systemctl", "restart", SERVICE.name]);
  if (await waitHealthy(port, next)) {
    console.log(`Updated ${current} → ${next}. The previous binary is kept as ${SERVICE.binary}.prev`);
    return;
  }
  console.error(`Version ${next} did not start; going back to ${current}.`);
  placeBinary(`${SERVICE.binary}.prev`, SERVICE.binary);
  run(["systemctl", "restart", SERVICE.name]);
  if (await waitHealthy(port, current)) {
    throw new ServiceError(`Back on ${current}. See why ${next} failed: journalctl -u ${SERVICE.name} -n 100`);
  }
  throw new ServiceError(
    `${current} does not start either, probably because ${next} already changed the database. ` +
      `Restore the backup made above (see "Backups" in the README), or install ${next} again once it is fixed.`,
  );
}

function uninstall() {
  if (existsSync(SERVICE.unit)) {
    run(["systemctl", "disable", "--now", SERVICE.name]);
    rmSync(SERVICE.unit);
    run(["systemctl", "daemon-reload"]);
  }
  rmSync(SERVICE.binary, { force: true });
  rmSync(`${SERVICE.binary}.prev`, { force: true });
  console.log(`The service is removed. The data is still in ${SERVICE.home}, owned by the user ${SERVICE.user}.`);
  console.log(`  To delete it too: sudo userdel ${SERVICE.user} && sudo rm -r ${SERVICE.home}`);
}

export async function serviceCommand(
  action: ServiceAction,
  o: { publicUrl: string | null; port: number; file: string | null; turnUrls: string[]; turnSecretFile: string | null },
): Promise<number> {
  try {
    if (process.platform !== "linux" || !existsSync("/run/systemd/system")) throw new ServiceError("service works on Linux with systemd only.");
    if (process.getuid?.() !== 0) throw new ServiceError(`Run it as root: sudo tapalog-messenger service ${action} …`);
    if (!isCompiled()) throw new ServiceError("service needs the released binary, not bun server/src/main.ts.");
    if (action === "install") await install(o.publicUrl!, o.port, o.turnUrls, o.turnSecretFile);
    else if (action === "update") await update(o.file!);
    else uninstall();
    return 0;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    console.error(err.message);
    return 1;
  }
}
