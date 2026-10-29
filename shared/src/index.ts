/** Name every /healthz answer carries, so a second launch can tell its own server apart from something else on the port. */
export const APP_ID = "tapalog-messenger";

/** Body of GET /healthz — public, used by the client's connection check and the CI smoke test. */
export interface HealthResponse {
  app: typeof APP_ID;
  ok: true;
  version: string;
  /** SQLite schema version (PRAGMA user_version) after migrations ran. */
  schema: number;
}

/** Lower case, "ё" as "е": how the search index, the words looked for and the highlighting all fold text. */
export const fold = (s: string) => s.toLowerCase().replaceAll("ё", "е");

export * from "./protocol";
