import { describe, expect, it } from "vitest";
import { isAuthorizedDaemonRequestHeaders } from "./DaemonHttpBridge.js";

describe("daemon HTTP bridge auth", () => {
  it("accepts the daemon token from the dedicated header or bearer auth", () => {
    expect(
      isAuthorizedDaemonRequestHeaders(
        { "x-alembic-daemon-token": "bridge-token" },
        "bridge-token",
      ),
    ).toBe(true);
    expect(
      isAuthorizedDaemonRequestHeaders({ authorization: "Bearer bridge-token" }, "bridge-token"),
    ).toBe(true);
  });

  it("rejects missing or mismatched daemon tokens", () => {
    expect(isAuthorizedDaemonRequestHeaders({}, "bridge-token")).toBe(false);
    expect(
      isAuthorizedDaemonRequestHeaders({ "x-alembic-daemon-token": "wrong-token" }, "bridge-token"),
    ).toBe(false);
    expect(
      isAuthorizedDaemonRequestHeaders({ authorization: "Bearer wrong-token" }, "bridge-token"),
    ).toBe(false);
  });
});
