import { describe, expect, it } from "vitest";
import { type ToolInvocation, type ToolResultEnvelope, toolSuccess } from "../tools/index.js";
import { DiagnosticsCollector } from "./DiagnosticsCollector.js";
import { createToolPipeline } from "./ToolExecutionPipeline.js";

describe("AgentRuntime tool execution pipeline", () => {
  it("executes allowed tools only through the new ToolRouter contract", async () => {
    const invocations: ToolInvocation[] = [];
    const toolRouter = {
      async invoke(invocation: ToolInvocation): Promise<ToolResultEnvelope> {
        invocations.push(invocation);
        return toolSuccess(
          { name: "meta.capabilities", resource: "meta", action: "capabilities" },
          { tools: [] },
          { requestId: invocation.requestId },
        );
      },
    };

    const result = await createToolPipeline().execute(
      { id: "call-1", name: "meta.capabilities", args: {} },
      {
        toolRouter,
        allowedToolIds: ["meta.capabilities"],
        iteration: 1,
        source: "test",
      },
    );

    expect(result.result).toEqual({ tools: [] });
    expect(result.metadata.envelope?.ok).toBe(true);
    expect(invocations).toEqual([{ name: "meta.capabilities", input: {}, requestId: "call-1" }]);
  });

  it("blocks unknown tools at allowlist gate before ToolRouter is called", async () => {
    let invoked = false;
    const diagnostics = new DiagnosticsCollector();
    const toolRouter = {
      async invoke(): Promise<ToolResultEnvelope> {
        invoked = true;
        throw new Error("ToolRouter should not see unknown runtime tools.");
      },
    };

    const result = await createToolPipeline().execute(
      { id: "call-2", name: "legacy.v2", args: { query: "nope" } },
      {
        toolRouter,
        allowedToolIds: ["meta.capabilities"],
        iteration: 1,
        diagnostics,
      },
    );

    expect(invoked).toBe(false);
    expect(result.metadata.blocked).toBe(true);
    expect(result.metadata.envelope?.ok).toBe(false);
    expect(result.result).toMatchObject({ error: expect.stringContaining("legacy.v2") });
    expect(diagnostics.toJSON().blockedTools).toEqual([
      { tool: "legacy.v2", reason: expect.stringContaining("legacy.v2") },
    ]);
  });
});
