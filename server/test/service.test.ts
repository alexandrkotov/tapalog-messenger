import { describe, expect, it } from "bun:test";
import { SERVICE, unitFile, unitPort } from "../src/service";

describe("systemd unit", () => {
  const unit = unitFile({ publicUrl: "https://messenger.tapalog.com", port: 8443 });

  it("runs the installed binary behind the proxy, without a tunnel or a browser", () => {
    expect(unit).toContain(
      "ExecStart=/usr/local/bin/tapalog-messenger --data /var/lib/tapalog-messenger/messenger-data --port 8443 --public-url https://messenger.tapalog.com --behind-proxy --no-tunnel --no-open",
    );
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("Restart=on-failure");
  });

  it("runs as its own user and writes only to its own folder", () => {
    for (const line of [`User=${SERVICE.user}`, "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", `ReadWritePaths=${SERVICE.home}`]) {
      expect(unit.split("\n")).toContain(line);
    }
    expect(SERVICE.data.startsWith(`${SERVICE.home}/`)).toBe(true);
  });

  it("lets an update find the port again", () => {
    expect(unitPort(unit)).toBe(8443);
    expect(unitPort(unitFile({ publicUrl: "https://m.example.com", port: 9100 }))).toBe(9100);
    expect(unitPort("[Service]\nExecStart=/x\n")).toBe(8443);
  });
});
