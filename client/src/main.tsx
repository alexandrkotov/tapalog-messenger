import { render } from "preact";
import { useState } from "preact/hooks";
import { App } from "./App";
import { pickLang, t, type Lang } from "./i18n";
import { navigate } from "./router";
import { setUpdateReady } from "./state";
import { applyTheme, savedTheme } from "./theme";
import { LangContext } from "./ui/common";
import "./styles.css";

// Before the first paint, so a chosen dark theme does not flash light.
applyTheme(savedTheme());

const LANG_KEY = "lang";

function savedLang(): Lang | null {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    return saved ? pickLang([saved]) : null;
  } catch {
    return null;
  }
}

function Root() {
  const [lang, setLangState] = useState<Lang>(() => savedLang() ?? pickLang(navigator.languages ?? [navigator.language]));
  document.documentElement.lang = lang;
  const setLang = (l: Lang) => {
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      // Private mode: the choice lasts until the tab closes.
    }
    setLangState(l);
  };
  return (
    <LangContext.Provider value={{ lang, s: t(lang), setLang }}>
      <App />
    </LangContext.Provider>
  );
}

render(<Root />, document.getElementById("app")!);

// The service worker keeps the app shell available offline. Only in a
// production build: in `vite dev` it would cache files that keep changing.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  // A new build takes over at once (sw.js skips waiting), but this page still
  // runs the old code: offer a reload rather than reloading mid-sentence.
  const hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => hadController && setUpdateReady());
  void navigator.serviceWorker.register("/sw.js");
  // A tapped notification brings this window forward and asks it to open the chat.
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const path = (e.data as { t?: string; path?: unknown } | null)?.path;
    if (e.data?.t === "open" && typeof path === "string" && /^\/chat\/\d+$/.test(path)) navigate(path);
  });
}
