import { isTurnUrl } from "./turn";
import { parseTunnelToken } from "./tunnel";

/** Command-line options. Kept to plain flags so a non-technical host can double-click the binary and get sensible defaults. */
export interface Args {
  /** `backup`: make a backup of the data folder and exit. `service`: install, update or remove the systemd service. */
  command: "serve" | "backup" | "service";
  /** What `service` does; `file` is the new binary for `update`. */
  service: { action: ServiceAction; file: string | null } | null;
  port: number;
  /** Explicit data folder from --data; null means "pick one" (see dataDir.ts). */
  data: string | null;
  /** Open the status page in the default browser on start. Off for CI and headless servers. */
  open: boolean;
  /** --public-url: the HTTPS origin people outside use. Saved in config.json; null means "keep what is saved". */
  publicUrl: string | null;
  /** --invite: print a new single-use admin invite link on start. */
  invite: boolean;
  /** --tunnel-token: a named Cloudflare Tunnel's token, saved in config.json. */
  tunnelToken: string | null;
  /** --quick-tunnel: a throwaway *.trycloudflare.com address for a demo. */
  quickTunnel: boolean;
  /** --no-tunnel: do not start the saved tunnel this time. */
  noTunnel: boolean;
  /** --forget-tunnel: delete the saved tunnel token. */
  forgetTunnel: boolean;
  /** --turn-url (repeatable): the calls relay's addresses, saved in config.json. */
  turnUrls: string[];
  /** --turn-secret-file: a file with the secret shared with coturn, read once and saved in config.json. */
  turnSecretFile: string | null;
  /** --behind-proxy: a reverse proxy on this machine (Caddy) carries the traffic. */
  behindProxy: boolean;
  /** --check-tunnel-binary (CI): run the embedded cloudflared's --version and exit. */
  checkTunnelBinary: boolean;
  version: boolean;
  help: boolean;
}

export const DEFAULT_PORT = 8443;

export type ServiceAction = "install" | "update" | "uninstall";
const SERVICE_ACTIONS: readonly string[] = ["install", "update", "uninstall"];

export const USAGE = `Usage: tapalog-messenger [options]
       tapalog-messenger backup [--data <dir>]
                 Back up the data folder into messenger-backups/ beside it and exit
                 (works while the server runs)
       tapalog-messenger service install --public-url <https://host> [--port <n>]
                 [--turn-url <url>]... [--turn-secret-file <file>]
       tapalog-messenger service update <new binary>
       tapalog-messenger service uninstall
                 Linux, as root: run as a systemd service behind a reverse proxy
                 such as Caddy (see "On a VPS" in the README)

  --port <n>     Port to listen on, on 127.0.0.1 (default ${DEFAULT_PORT})
  --data <dir>   Data folder (default: messenger-data/ next to the binary)
  --no-open      Do not open the status page in a browser
  --public-url <https://host>
                 Address the server is reachable at from outside (saved for next time)
  --behind-proxy Behind a reverse proxy on this machine: take the client's
                 address from X-Forwarded-For, and keep the status page off it
  --turn-url <turn:host:3478>
                 A TURN relay (coturn) for calls; repeat for each address,
                 e.g. turn:…:3478, turn:…:3478?transport=tcp, turns:…:5349
  --turn-secret-file <file>
                 File with the secret shared with coturn (use-auth-secret)
                 Both are saved for next time.
  --invite       Print a new single-use admin invite link (e.g. to regain access)
  --tunnel-token <token>
                 Connect a named Cloudflare Tunnel (saved for next time;
                 needs --public-url with the tunnel's hostname once)
  --quick-tunnel Temporary https://*.trycloudflare.com address, for a demo only
  --no-tunnel    Do not start the saved tunnel this time
  --forget-tunnel
                 Delete the saved tunnel token
  --version      Print the version and exit
  --help         Print this help and exit`;

export class ArgsError extends Error {}

/** Just the origin of an https:// URL: cookies, invite links and the Origin check all hang on it. */
export function parsePublicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArgsError(`--public-url is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:") throw new ArgsError("--public-url must start with https://");
  return url.origin;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "serve",
    service: null,
    port: DEFAULT_PORT,
    data: null,
    open: true,
    publicUrl: null,
    invite: false,
    tunnelToken: null,
    quickTunnel: false,
    noTunnel: false,
    forgetTunnel: false,
    turnUrls: [],
    turnSecretFile: null,
    behindProxy: false,
    checkTunnelBinary: false,
    version: false,
    help: false,
  };
  let start = 0;
  if (argv[0] === "service") {
    const action = argv[1];
    if (!action || !SERVICE_ACTIONS.includes(action)) throw new ArgsError("service needs install, update or uninstall");
    args.command = "service";
    args.service = { action: action as ServiceAction, file: null };
    start = 2;
    if (action === "update") {
      const file = argv[2];
      if (!file || file.startsWith("--")) throw new ArgsError("service update needs the new binary: tapalog-messenger service update <file>");
      args.service.file = file;
      start = 3;
    }
  }
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new ArgsError(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case "backup":
        if (i !== 0) throw new ArgsError("backup must come first: tapalog-messenger backup [--data <dir>]");
        args.command = "backup";
        break;
      case "--port": {
        const port = Number(value());
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ArgsError("--port must be a number from 1 to 65535");
        args.port = port;
        break;
      }
      case "--data":
        args.data = value();
        break;
      case "--no-open":
        args.open = false;
        break;
      case "--public-url":
        args.publicUrl = parsePublicUrl(value());
        break;
      case "--invite":
        args.invite = true;
        break;
      case "--tunnel-token": {
        const token = parseTunnelToken(value());
        if (!token) throw new ArgsError("--tunnel-token does not look like a Cloudflare Tunnel token (it starts with eyJ…)");
        args.tunnelToken = token;
        break;
      }
      case "--quick-tunnel":
        args.quickTunnel = true;
        break;
      case "--no-tunnel":
        args.noTunnel = true;
        break;
      case "--forget-tunnel":
        args.forgetTunnel = true;
        break;
      case "--turn-url": {
        const url = value();
        if (!isTurnUrl(url)) throw new ArgsError(`--turn-url must look like turn:host:3478 or turns:host:5349, not ${url}`);
        args.turnUrls.push(url);
        break;
      }
      case "--turn-secret-file":
        args.turnSecretFile = value();
        break;
      case "--behind-proxy":
        args.behindProxy = true;
        break;
      case "--check-tunnel-binary":
        args.checkTunnelBinary = true;
        break;
      case "--version":
        args.version = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new ArgsError(`Unknown option: ${arg}`);
    }
  }
  if (args.command === "backup" && argv.some((a) => a.startsWith("--") && a !== "--data")) {
    throw new ArgsError("backup takes only --data <dir>");
  }
  if (args.service) {
    const given = argv.slice(start).filter((a) => a.startsWith("--"));
    const allowed = args.service.action === "install" ? ["--public-url", "--port", "--turn-url", "--turn-secret-file"] : [];
    const extra = given.find((a) => !allowed.includes(a));
    if (extra) throw new ArgsError(`service ${args.service.action} does not take ${extra}`);
    if (args.service.action === "install" && !args.publicUrl) throw new ArgsError("service install needs --public-url https://<the address people open>");
  }
  if ([args.tunnelToken !== null, args.quickTunnel, args.noTunnel, args.forgetTunnel].filter(Boolean).length > 1) {
    throw new ArgsError("Use only one of --tunnel-token, --quick-tunnel, --no-tunnel, --forget-tunnel");
  }
  return args;
}
