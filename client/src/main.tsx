import { render } from "preact";
import { App } from "./App";
import { pickLang, t } from "./i18n";
import "./styles.css";

const lang = pickLang(navigator.languages ?? [navigator.language]);
document.documentElement.lang = lang;
render(<App s={t(lang)} />, document.getElementById("app")!);

// The service worker keeps the app shell available offline. Only in a
// production build: in `vite dev` it would cache files that keep changing.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js");
}
