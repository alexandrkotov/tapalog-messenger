import { parseTunnelToken } from "./tunnel";

/** Command-line options. Kept to plain flags so a non-technical host can double-click the binary and get sensible defaults. */
export interface Args {
  /** `backup`: make a backup of the data folder and exit, instead of serving. */
  command: "serve" | "backup";
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
  /** --check-tunnel-binary (CI): run the embedded cloudflared's --version and exit. */
  checkTunnelBinary: boolean;
  version: boolean;
  help: boolean;
}

export const DEFAULT_PORT = 8443;

export const USAGE = `Usage: tapalog-messenger [options]
       tapalog-messenger backup [--data <dir>]
                 Back up the data folder into messenger-backups/ beside it and exit
                 (works while the server runs)

  --port <n>     Port to listen on, on 127.0.0.1 (default ${DEFAULT_PORT})
  --data <dir>   Data folder (default: messenger-data/ next to the binary)
  --no-open      Do not open the status page in a browser
  --public-url <https://host>
                 Address the server is reachable at from outside (saved for next time)
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
    port: DEFAULT_PORT,
    data: null,
    open: true,
    publicUrl: null,
    invite: false,
    tunnelToken: null,
    quickTunnel: false,
    noTunnel: false,
    forgetTunnel: false,
    checkTunnelBinary: false,
    version: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
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
  if ([args.tunnelToken !== null, args.quickTunnel, args.noTunnel, args.forgetTunnel].filter(Boolean).length > 1) {
    throw new ArgsError("Use only one of --tunnel-token, --quick-tunnel, --no-tunnel, --forget-tunnel");
  }
  return args;
}
