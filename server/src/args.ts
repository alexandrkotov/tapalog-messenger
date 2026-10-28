/** Command-line options. Kept to plain flags so a non-technical host can double-click the binary and get sensible defaults. */
export interface Args {
  port: number;
  /** Explicit data folder from --data; null means "pick one" (see dataDir.ts). */
  data: string | null;
  /** Open the status page in the default browser on start. Off for CI and headless servers. */
  open: boolean;
  version: boolean;
  help: boolean;
}

export const DEFAULT_PORT = 8443;

export const USAGE = `Usage: tapalog-messenger [options]

  --port <n>     Port to listen on, on 127.0.0.1 (default ${DEFAULT_PORT})
  --data <dir>   Data folder (default: messenger-data/ next to the binary)
  --no-open      Do not open the status page in a browser
  --version      Print the version and exit
  --help         Print this help and exit`;

export class ArgsError extends Error {}

export function parseArgs(argv: string[]): Args {
  const args: Args = { port: DEFAULT_PORT, data: null, open: true, version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new ArgsError(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
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
  return args;
}
