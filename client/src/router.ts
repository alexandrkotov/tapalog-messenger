import { useEffect, useState } from "preact/hooks";

/** The whole router: the current path, and a way to change it without a reload. */

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener("popstate", notify);

export function navigate(path: string, replace = false) {
  if (path === location.pathname) return;
  history[replace ? "replaceState" : "pushState"](null, "", path);
  notify();
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const l = () => setPath(location.pathname);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return path;
}

/** `/chat/:id/info` style matching; null when the path does not fit. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/");
  const a = path.split("/");
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}
