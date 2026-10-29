import type { TurnDto } from "@tapalog-messenger/shared";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { checkRelay, type CallCheckResult, type Transport } from "../callCheck";
import { fmt } from "../i18n";
import { useLang } from "./common";

const SECONDS = 20;

/** Settings → Calls: shown only when the server has a TURN relay. */
export function CallCheck() {
  const { s } = useLang();
  const [available, setAvailable] = useState(false);
  const [transport, setTransport] = useState<Transport>("any");
  const [left, setLeft] = useState<number | null>(null);
  const [result, setResult] = useState<CallCheckResult | null>(null);

  useEffect(() => {
    api<TurnDto>("GET", "/turn").then(
      () => setAvailable(true),
      () => setAvailable(false),
    );
  }, []);
  if (!available) return null;

  const run = async () => {
    setResult(null);
    setLeft(SECONDS);
    try {
      // Fresh credentials every time: they last hours, a settings page may stay open longer.
      setResult(await checkRelay(await api<TurnDto>("GET", "/turn"), transport, SECONDS, setLeft));
    } catch {
      setResult({ ok: false, transport: null, serverMs: null, lossPct: null, error: "unreachable" });
    } finally {
      setLeft(null);
    }
  };

  // Over 300 ms to the server and back, a call with someone as far on the other side starts to feel like a walkie-talkie.
  const weak = result?.ok && ((result.serverMs ?? 0) > 300 || (result.lossPct ?? 0) > 3);
  return (
    <>
      <h3>{s.calls}</h3>
      <p class="hint">{fmt(s.callCheckHint, { n: SECONDS })}</p>
      <select aria-label={s.callTransport} value={transport} disabled={left !== null} onChange={(e) => setTransport(e.currentTarget.value as Transport)}>
        <option value="any">{s.transportAny}</option>
        <option value="udp">{s.transportUdp}</option>
        <option value="tcp">{s.transportTcp}</option>
        <option value="tls">{s.transportTls}</option>
      </select>
      <button type="button" disabled={left !== null} onClick={() => void run()} data-testid="call-check">
        {left !== null ? fmt(s.callChecking, { n: left }) : s.callCheck}
      </button>
      {result && (
        <p class={result.ok ? "hint" : "error"} role="status" data-testid="call-check-result" data-ok={String(result.ok)} data-transport={result.transport ?? ""}>
          {result.ok
            ? fmt(s.callCheckOk, { transport: (result.transport ?? "?").toUpperCase(), ms: result.serverMs ?? "?", loss: result.lossPct ?? "?" }) + (weak ? ` ${s.callCheckWeak}` : "")
            : result.error === "no_address"
              ? s.callCheckNoAddress
              : s.callCheckFail}
        </p>
      )}
    </>
  );
}
