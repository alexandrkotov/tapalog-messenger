export interface StatusInfo {
  version: string;
  schema: number;
  localUrl: string;
  dataDir: string;
  startedAt: string;
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
  const rows: [string, string][] = [
    ["Address on this computer", `<a href="${escapeHtml(info.localUrl)}">${escapeHtml(info.localUrl)}</a>`],
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
  button { font: inherit; padding: 10px 20px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); cursor: pointer; }
  @media (max-width: 520px) { dl div { grid-template-columns: 1fr; gap: 2px; } }
</style>
</head>
<body>
<main>
  <h1>Tapalog Messenger</h1>
  <p class="state" id="state">Server is running</p>
  <dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
  <button id="stop" type="button">Stop server</button>
</main>
<script nonce="${nonce}">
  const key = new URLSearchParams(location.search).get("key") ?? "";
  document.getElementById("stop").addEventListener("click", async (event) => {
    event.target.disabled = true;
    const res = await fetch("/shutdown", { method: "POST", headers: { "X-Admin-Key": key } }).catch(() => null);
    document.getElementById("state").textContent = res && res.ok ? "Server stopped. You can close this tab." : "Could not stop the server.";
  });
</script>
</body>
</html>`;
}
