import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonJobKind } from "../daemon/index.js";
import { handleCodexTool } from "./tools.js";

const daemonClient = vi.hoisted(() => ({
  enqueued: [] as Array<{ readonly kind: DaemonJobKind; readonly input: Record<string, unknown> }>,
}));

vi.mock("./daemon-client.js", () => ({
  enqueueCodexDaemonJob: async (kind: DaemonJobKind, input: Record<string, unknown>) => {
    daemonClient.enqueued.push({ kind, input });
    return {
      id: `${kind}_test`,
      kind,
      status: "queued",
      input,
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z",
    };
  },
  listCodexDaemonJobs: async () => [],
  getCodexDaemonJob: async () => undefined,
  cancelCodexDaemonJob: async () => undefined,
}));

beforeEach(() => {
  daemonClient.enqueued = [];
});

describe("Codex public bootstrap/rescan enqueue contract", () => {
  it("queues bootstrap through the daemon client without running scan work in the MCP handler", async () => {
    const result = await handleCodexTool("alembic_codex_bootstrap", {
      force: true,
      scan: { maxFiles: 20, includeTests: false },
      changedFiles: ["src/app.ts", "", 42],
      agentFill: true,
      maxAgentTasks: 2,
      ignored: "not forwarded",
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Alembic bootstrap job queued.");
    expect(result.data).toMatchObject({
      job: {
        id: "bootstrap_test",
        kind: "bootstrap",
        status: "queued",
        input: {
          force: true,
          scan: { maxFiles: 20, includeTests: false },
          changedFiles: ["src/app.ts"],
          agentFill: true,
          maxAgentTasks: 2,
        },
      },
      nextAction: { tool: "alembic_codex_job", arguments: { id: "bootstrap_test" } },
    });
    expect(daemonClient.enqueued).toEqual([
      {
        kind: "bootstrap",
        input: {
          force: true,
          scan: { maxFiles: 20, includeTests: false },
          changedFiles: ["src/app.ts"],
          agentFill: true,
          maxAgentTasks: 2,
        },
      },
    ]);
  });

  it("queues rescan with incremental and internal agent fields preserved", async () => {
    const result = await handleCodexTool("alembic_codex_rescan", {
      scan: { includeMarkdown: true },
      changedFiles: ["src/app.ts", "src/util.ts"],
      removedFiles: ["src/old.ts"],
      diffTextByPath: {
        "src/app.ts": "@@ -1 +1 @@\n-old\n+new",
        "src/skip.ts": 7,
      },
      agentFill: true,
      includeEvolution: true,
      maxAgentTasks: 3,
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Alembic rescan job queued.");
    expect(result.data).toMatchObject({
      job: { id: "rescan_test", kind: "rescan", status: "queued" },
      nextAction: { tool: "alembic_codex_job", arguments: { id: "rescan_test" } },
    });
    expect(daemonClient.enqueued).toEqual([
      {
        kind: "rescan",
        input: {
          scan: { includeMarkdown: true },
          changedFiles: ["src/app.ts", "src/util.ts"],
          removedFiles: ["src/old.ts"],
          diffTextByPath: { "src/app.ts": "@@ -1 +1 @@\n-old\n+new" },
          agentFill: true,
          includeEvolution: true,
          maxAgentTasks: 3,
        },
      },
    ]);
  });
});
