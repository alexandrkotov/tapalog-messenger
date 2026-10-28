/** Best-effort "open this in the default browser" — the URL is always printed to the console too, so a failure here never strands the host without a way to find it. */
export function openInBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(command, {
      stdout: "ignore",
      stderr: "ignore",
      // On Windows `cmd.exe` is a console-subsystem app, so spawning it from
      // this console-less (--windows-hide-console) process flashes a fresh
      // console window for the instant `cmd /c start` takes to run (seen
      // live in ECM's collab-server, where this helper comes from).
      // windowsHide is a no-op on the other platforms.
      windowsHide: true,
    });
  } catch {
    // No graphical opener available (e.g. a headless box) — the console
    // message main.ts prints already has the same localhost URL.
  }
}
