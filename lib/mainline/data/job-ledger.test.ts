import { describe, expect, it } from "vitest";
import { InMemoryMainlineJobLedger } from "./JobLedger.js";

describe("InMemoryMainlineJobLedger", () => {
  it("tracks compile job state transitions without allowing terminal mutation", async () => {
    const ledger = new InMemoryMainlineJobLedger();
    const created = await ledger.create({
      id: "compile_1",
      kind: "mainline-compile-session",
      source: "compile",
      request: { mode: "cold-start" },
    });

    expect(created).toMatchObject({ status: "queued", source: "compile" });
    await expect(ledger.markRunning(created.id)).resolves.toMatchObject({ status: "running" });
    await expect(ledger.complete(created.id, { ok: true })).resolves.toMatchObject({
      status: "completed",
      result: { ok: true },
    });
    await expect(ledger.fail(created.id, new Error("late failure"))).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("rejects unsafe ids and filters listed jobs", async () => {
    const ledger = new InMemoryMainlineJobLedger();
    await expect(ledger.create({ id: "../escape", kind: "compile" })).rejects.toThrow("Unsafe");
    await ledger.create({ id: "compile_a", kind: "compile", source: "compile" });
    await ledger.create({ id: "runtime_a", kind: "runtime", source: "runtime" });

    await expect(ledger.list({ kind: "compile" })).resolves.toEqual([
      expect.objectContaining({ id: "compile_a" }),
    ]);
    await expect(ledger.get("../escape")).resolves.toBeNull();
  });
});
