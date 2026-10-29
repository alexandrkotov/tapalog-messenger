import { describe, expect, it } from "bun:test";
import { SERVICE, unitFile, unitPort } from "../src/service";
import { renderStatusPage } from "../src/statusPage";

describe("systemd unit", () => {
  const unit = unitFile({ publicUrl: "https://messenger.tapalog.com", port: 8443 });

  it("runs the installed binary behind the proxy, without a tunnel or a browser", () => {
    expect(unit).toContain(
      "ExecStart=/usr/local/bin/tapalog-messenger --data /var/lib/tapalog-messenger/messenger-data --port 8443 --public-url https://messenger.tapalog.com --behind-proxy --no-tunnel --no-open",
    );
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("Restart=always"); // also after Restart server on the status page
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

describe("status page under systemd", () => {
  const info = { version: "1", schema: 4, localUrl: "http://localhost:8443", publicUrl: null, setupInviteUrl: null, tunnel: null, addressChangedFrom: null, dataDir: "/d", startedAt: "now" };

  it("offers Restart instead of Stop, because the unit starts it again", () => {
    expect(renderStatusPage({ ...info, turnUrls: null, restartsWhenStopped: true }, "n")).toContain(">Restart server<");
    expect(renderStatusPage({ ...info, turnUrls: null, restartsWhenStopped: false }, "n")).toContain(">Stop server<");
  });

  it("lists the TURN relay's addresses, never its secret", () => {
    const page = renderStatusPage({ ...info, turnUrls: ["turn:t.example.com:3478", "turns:t.example.com:5349"], restartsWhenStopped: true }, "n");
    expect(page).toContain("<code>turn:t.example.com:3478</code><br><code>turns:t.example.com:5349</code>");
    expect(renderStatusPage({ ...info, turnUrls: null, restartsWhenStopped: true }, "n")).toContain("Not set up");
  });
});
