/**
 * Light or dark, or whatever the system says (the default). Kept on this
 * device, like the language. The stylesheet reads data-theme on <html>.
 */
export type Theme = "system" | "light" | "dark";

const KEY = "theme";

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Private mode: it lasts until the tab closes.
  }
  applyTheme(theme);
}
