/**
 * Best-effort "open this in the default browser" — the URL is always printed to the console too, so a failure here never strands the host without a way to find it.
 * Resolves once the opener has handed the URL over (at most a few seconds):
 * on Windows Bun kills its child processes when it exits, so a caller about
 * to exit must wait, or `cmd /c start` dies before the browser opens (seen
 * live on the second double-click).
 */
export async function openInBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const command =
    platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    const proc = Bun.spawn(command, {
      stdout: "ignore",
      stderr: "ignore",
      // On Windows `cmd.exe` is a console-subsystem app, so spawning it from
      // this console-less (--windows-hide-console) process flashes a fresh
      // console window for the instant `cmd /c start` takes to run (seen
      // live in ECM's collab-server, where this helper comes from).
      // windowsHide is a no-op on the other platforms.
      windowsHide: true,
    });
    await Promise.race([proc.exited, Bun.sleep(5000)]);
  } catch {
    // No graphical opener available (e.g. a headless box) — the console
    // message main.ts prints already has the same localhost URL.
  }
}
