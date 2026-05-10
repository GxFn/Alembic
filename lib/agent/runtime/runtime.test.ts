import { describe, expect, it } from "vitest";
import { AiTaskPlanner, type ModelDef } from "../../mainline/ai/index.js";
import type { EvidencePackage } from "../../mainline/knowledge/index.js";
import { type ToolInvocation, type ToolResultEnvelope, toolSuccess } from "../tools/index.js";
import { AgentRuntime } from "./AgentRuntime.js";
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

  it("records tool observations, tracker signals, traces, and submit dedup metadata", async () => {
    const observations: unknown[] = [];
    const signals: unknown[] = [];
    const traces: unknown[] = [];
    const onToolCalls: unknown[] = [];
    const toolRouter = {
      async invoke(invocation: ToolInvocation): Promise<ToolResultEnvelope> {
        return toolSuccess(
          { name: "knowledge.submit", resource: "knowledge", action: "submit" },
          { status: "duplicate_blocked", id: "candidate-1" },
          { requestId: invocation.requestId },
        );
      },
    };

    const result = await createToolPipeline().execute(
      { id: "call-submit", name: "knowledge.submit", args: { title: "Duplicate" } },
      {
        toolRouter,
        allowedToolIds: ["knowledge.submit"],
        iteration: 2,
        source: "runtime-test",
        onToolCall: (name, args, toolResult, iteration) => {
          onToolCalls.push({ name, args, toolResult, iteration });
        },
        observationSink: {
          recordToolCall: (entry) => {
            observations.push(entry);
          },
        },
        trackerSink: {
          signalToolCall: (event) => {
            signals.push(event);
          },
        },
        traceSink: {
          recordToolCall: (name, args, toolResult, isNew) => {
            traces.push({ name, args, toolResult, isNew });
          },
        },
      },
    );

    expect(result.metadata).toMatchObject({
      isSubmit: true,
      isNew: false,
      dedupMessage: "Knowledge submission blocked as duplicate.",
    });
    expect(observations).toHaveLength(1);
    expect(signals).toEqual([
      {
        name: "knowledge.submit",
        ok: true,
        blocked: false,
        isNew: false,
        iteration: 2,
        source: "runtime-test",
      },
    ]);
    expect(traces).toEqual([
      {
        name: "knowledge.submit",
        args: { title: "Duplicate" },
        toolResult: { status: "duplicate_blocked", id: "candidate-1" },
        isNew: false,
      },
    ]);
    expect(onToolCalls).toEqual([
      {
        name: "knowledge.submit",
        args: { title: "Duplicate" },
        toolResult: { status: "duplicate_blocked", id: "candidate-1" },
        iteration: 2,
      },
    ]);
  });

  it("maps missing provider plans to blocked runtime degradation without mock fallback", async () => {
    const runtime = new AgentRuntime({ toolRouter: neverInvokedToolRouter() });

    const result = await runtime.planAiTasks((planner) =>
      planner.planContentMining({
        evidencePackage: evidenceFixture(),
        providerStatus: undefined,
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.blocked).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.tasks).toEqual([]);
    expect(result.recipePublicationAttempted).toBe(false);
    expect(result.diagnostics.degraded).toBe(true);
    expect(result.diagnostics.fallbackUsed).toBe(false);
    expect(result.diagnostics.gateFailures).toEqual([
      {
        stage: "ai.task",
        action: "degrade",
        reason: "AI provider 状态缺失，主线不会使用 mock fallback。",
      },
    ]);
  });

  it("keeps degraded planner status distinct from ready execution wiring", async () => {
    const runtime = new AgentRuntime({ toolRouter: neverInvokedToolRouter() });
    const planner = new AiTaskPlanner();

    const result = runtime.acceptAiTaskPlan({
      plan: planner.planContentMining({
        evidencePackage: evidenceFixture(),
        providerStatus: {
          provider: "openai",
          model: "gpt-test",
          ready: false,
          mock: false,
          reason: "OPENAI_API_KEY missing.",
        },
      }),
    });

    expect(result.status).toBe("degraded");
    expect(result.blocked).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.diagnostics.fallbackUsed).toBe(false);
  });

  it("passes ready AI task parameters through ParameterGuard without executing a provider", async () => {
    const runtime = new AgentRuntime({ toolRouter: neverInvokedToolRouter() });

    const result = await runtime.planAiTasks(
      (planner) =>
        planner.planContentMining({
          evidencePackage: evidenceFixture(),
          providerStatus: {
            provider: "deepseek",
            model: "test-thinking",
            ready: true,
            mock: false,
          },
        }),
      {
        model: thinkingModel(),
        params: {
          temperature: 0.7,
          toolChoice: "auto",
          reasoningEffort: "maximum",
          maxTokens: 9000,
        },
      },
    );

    expect(result.status).toBe("ready");
    expect(result.blocked).toBe(false);
    expect(result.recipePublicationAttempted).toBe(false);
    expect(result.tasks.map((task) => task.kind)).toEqual([
      "summarize-evidence",
      "propose-recipe-edges",
    ]);
    expect(result.guardedParams).toMatchObject({
      reasoningEffort: "high",
      maxTokens: 4096,
    });
    expect(result.guardedParams?.temperature).toBeUndefined();
    expect(result.guardedParams?.toolChoice).toBeUndefined();
    expect(result.guardedParams?.filtered.map((entry) => entry.param)).toEqual([
      "temperature",
      "toolChoice",
      "reasoningEffort",
    ]);
  });

  it("keeps AgentRuntime tool allowlist scoped to lib/agent/tools", async () => {
    let invoked = false;
    const diagnostics = new DiagnosticsCollector();
    const runtime = new AgentRuntime({
      toolRouter: {
        async invoke(): Promise<ToolResultEnvelope> {
          invoked = true;
          throw new Error("Codex plugin tools must not reach the agent ToolRouter.");
        },
      },
      additionalTools: ["meta.capabilities", "alembic_submit_knowledge"],
    });

    expect(runtime.allowedToolIds()).toEqual(["meta.capabilities"]);

    const result = await runtime.executeToolCall(
      { id: "call-codex-tool", name: "alembic_submit_knowledge", args: {} },
      {
        allowedToolIds: ["meta.capabilities", "alembic_submit_knowledge"],
        diagnostics,
      },
    );

    expect(invoked).toBe(false);
    expect(result.metadata.blocked).toBe(true);
    expect(result.result).toMatchObject({
      error: expect.stringContaining("alembic_submit_knowledge"),
    });
    expect(diagnostics.toJSON().blockedTools).toEqual([
      {
        tool: "alembic_submit_knowledge",
        reason: expect.stringContaining("alembic_submit_knowledge"),
      },
    ]);
  });
});

function neverInvokedToolRouter() {
  return {
    async invoke(): Promise<ToolResultEnvelope> {
      throw new Error("AI planning hook must not execute runtime tools.");
    },
  };
}

function evidenceFixture(): EvidencePackage {
  return {
    id: "evidence-1",
    origin: "manual",
    projectRoot: "/tmp/alembic-test",
    changedFiles: ["lib/example.ts"],
    sourceRefs: [
      {
        id: "lib/example.ts",
        kind: "file",
        location: { path: "lib/example.ts" },
        status: "active",
      },
    ],
    notes: ["fixture evidence"],
    createdAt: 1,
  };
}

function thinkingModel(): ModelDef {
  return {
    id: "deepseek:test-thinking",
    displayName: "DeepSeek Test Thinking",
    provider: "deepseek",
    apiModelId: "test-thinking",
    contextWindow: 64_000,
    maxOutputTokens: 4096,
    capabilities: {
      toolCalling: true,
      vision: false,
      embedding: false,
      jsonMode: true,
      streaming: true,
    },
    reasoning: { supported: true, mode: "thinking", defaultEffort: "high" },
    parameterConstraints: {
      temperature: { allowed: false },
      toolChoice: { allowed: true, disabledWhen: "thinking" },
      reasoningEffort: { allowed: true, allowedValues: ["low", "medium", "high"] },
    },
  };
}
