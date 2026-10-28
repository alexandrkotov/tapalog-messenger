import type { HealthResponse } from "@tapalog-messenger/shared";
import { useEffect, useState } from "preact/hooks";
import type { Strings } from "./i18n";

type Connection = { state: "checking" } | { state: "online"; health: HealthResponse } | { state: "offline" };

const RECHECK_MS = 5000;

export function App({ s }: { s: Strings }) {
  const [conn, setConn] = useState<Connection>({ state: "checking" });

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/healthz", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const health = (await res.json()) as HealthResponse;
        if (!cancelled) setConn({ state: "online", health });
      } catch {
        if (!cancelled) setConn({ state: "offline" });
      }
    }
    void check();
    const timer = setInterval(check, RECHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <main class="shell">
      <h1>{s.title}</h1>
      <p class={`conn conn-${conn.state}`} data-testid="connection" data-state={conn.state} role="status">
        {conn.state === "checking" ? s.checking : conn.state === "online" ? s.online : s.offline}
      </p>
      {conn.state === "online" && (
        <p class="meta">
          {s.version}: {conn.health.version}
        </p>
      )}
    </main>
  );
}
