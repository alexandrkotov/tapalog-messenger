import qrcode from "qrcode-generator";
import type { TunnelState } from "./tunnel";

export interface StatusInfo {
  version: string;
  schema: number;
  localUrl: string;
  /** The HTTPS address people outside use, when there is one. */
  publicUrl: string | null;
  /** Link for creating the first account, while there are no accounts yet. */
  setupInviteUrl: string | null;
  /** Null when the server runs without a tunnel. */
  tunnel: ({ kind: "named" | "quick" } & TunnelState) | null;
  /** The previous public address, when this start changed it. */
  addressChangedFrom: string | null;
  dataDir: string;
  startedAt: string;
}

/** Scannable from a phone: the quickest way to open the messenger there. */
function qrSvg(url: string): string {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export function tunnelText(t: NonNullable<StatusInfo["tunnel"]>): string {
  const kind = t.kind === "quick" ? "Quick tunnel (demo)" : "Cloudflare Tunnel";
  if (t.state === "connected") return `${kind}: connected`;
  if (t.state === "starting") return `${kind}: connecting…`;
  return `${kind}: not connected — ${t.message}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * The page the binary opens in the host's browser on start, so they never
 * have to read terminal output (on Windows there is no console at all).
 * Served only with the admin key; the Stop button sends the same key back.
 * `nonce` lets this page's one inline script pass the strict CSP.
 */
export function renderStatusPage(info: StatusInfo, nonce: string): string {
  const link = (url: string) => `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
  const rows: [string, string][] = [
    ...(info.setupInviteUrl ? ([["Create the first account (admin)", link(info.setupInviteUrl)]] as [string, string][]) : []),
    ...(info.publicUrl ? ([["Address for everyone", link(info.publicUrl)]] as [string, string][]) : []),
    ...(info.tunnel ? ([["Internet access", `<span id="tunnel">${escapeHtml(tunnelText(info.tunnel))}</span>`]] as [string, string][]) : []),
    ["Address on this computer", link(info.localUrl)],
    ["Data folder", `<code>${escapeHtml(info.dataDir)}</code>`],
    ["Version", `${escapeHtml(info.version)} · schema ${info.schema}`],
    ["Running since", escapeHtml(info.startedAt)],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tapalog Messenger · server</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #16181d; --muted: #5d6470; --accent: #1a7f64; --line: #dde1e6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111317; --card: #1a1d23; --text: #eceef2; --muted: #9aa1ad; --accent: #3dbb93; --line: #2c3139; } }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--text); }
  main { max-width: 640px; margin: 48px auto; padding: 0 16px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .state { color: var(--accent); font-weight: 600; margin: 0 0 24px; }
  dl { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 8px 20px; margin: 0 0 24px; }
  dl div { display: grid; grid-template-columns: 200px 1fr; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  dl div:last-child { border-bottom: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  a { color: var(--accent); }
  .qr { width: 200px; height: 200px; background: #fff; border-radius: 8px; margin: 0 0 24px; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .warn { color: #a15c07; font-weight: 600; }
  .actions { display: flex; gap: 12px; flex-wrap: wrap; margin: 0 0 12px; }
  .out { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-wrap: anywhere; }
  button { font: inherit; padding: 10px 20px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); cursor: pointer; }
  @media (max-width: 520px) { dl div { grid-template-columns: 1fr; gap: 2px; } }
</style>
</head>
<body>
<main>
  <h1>Tapalog Messenger</h1>
  <p class="state" id="state">Server is running</p>
  ${info.addressChangedFrom ? `<p class="warn">The address changed from ${escapeHtml(info.addressChangedFrom)}. Everyone has to open the new address and install the app and notifications again.</p>` : ""}
  <dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
  ${info.publicUrl && (!info.tunnel || info.tunnel.state === "connected") ? `<div class="qr" title="${escapeHtml(info.publicUrl)}">${qrSvg(info.publicUrl)}</div>` : ""}
  <p class="actions"><button id="invite" type="button">Create an invite link</button> <button id="stop" type="button">Stop server</button></p>
  <p id="invite-out" class="out" hidden></p>
</main>
<script nonce="${nonce}">
  const key = new URLSearchParams(location.search).get("key") ?? "";
  // Keep the tunnel line current; a new or newly connected address needs the QR code redrawn.
  const shownUrl = ${JSON.stringify(info.publicUrl).replaceAll("<", "\\u003c")};
  const shownState = ${JSON.stringify(info.tunnel?.state ?? null)};
  setInterval(async () => {
    const res = await fetch("/status.json", { headers: { "X-Admin-Key": key } }).catch(() => null);
    if (!res || !res.ok) return;
    const s = await res.json();
    if (s.publicUrl !== shownUrl || (s.tunnel && (s.tunnel.state === "connected") !== (shownState === "connected"))) location.reload();
    const el = document.getElementById("tunnel");
    if (el && s.tunnel) el.textContent = s.tunnel.text;
  }, 3000);
  document.getElementById("invite").addEventListener("click", async () => {
    const out = document.getElementById("invite-out");
    const res = await fetch("/admin/invite", { method: "POST", headers: { "X-Admin-Key": key } }).catch(() => null);
    out.hidden = false;
    out.textContent = res && res.ok ? "Send this link to one person (valid for 7 days): " + (await res.json()).url : "Could not create an invite.";
  });
  document.getElementById("stop").addEventListener("click", async (event) => {
    event.target.disabled = true;
    const res = await fetch("/shutdown", { method: "POST", headers: { "X-Admin-Key": key } }).catch(() => null);
    document.getElementById("state").textContent = res && res.ok ? "Server stopped. You can close this tab." : "Could not stop the server.";
  });
</script>
</body>
</html>`;
}
