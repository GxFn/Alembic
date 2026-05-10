import { describe, expect, it } from "vitest";
import { AiTaskPlanner, type ModelDef } from "../../mainline/ai/index.js";
import type { EvidencePackage } from "../../mainline/knowledge/index.js";
import { type ToolInvocation, type ToolResultEnvelope, toolSuccess } from "../tools/index.js";
import { AgentEventBus } from "./AgentEventBus.js";
import { AgentRuntime } from "./AgentRuntime.js";
import type { LLMResult, RuntimeAiProvider } from "./AgentRuntimeTypes.js";
import { MAX_TOOL_CALLS_PER_ITER } from "./AgentRuntimeTypes.js";
import { BudgetController } from "./BudgetController.js";
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

  it("runs a full ReAct loop through new internal agent tools and returns a final answer", async () => {
    const invocations: ToolInvocation[] = [];
    const provider = sequenceProvider([
      {
        functionCalls: [
          {
            id: "call-meta",
            name: "meta.capabilities",
            args: { includeUnavailable: false },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        text: "Final Answer: 工具链路已经接通。",
        usage: { inputTokens: 15, outputTokens: 7, cacheHitTokens: 3 },
      },
    ]);
    const runtime = new AgentRuntime({
      aiProvider: provider,
      toolRouter: {
        async invoke(invocation: ToolInvocation): Promise<ToolResultEnvelope> {
          invocations.push(invocation);
          return toolSuccess(
            { name: "meta.capabilities", resource: "meta", action: "capabilities" },
            { tools: ["meta.capabilities"] },
            { requestId: invocation.requestId },
          );
        },
      },
      additionalTools: ["meta.capabilities"],
      lang: "zh",
    });

    const result = await runtime.reactLoop("检查工具能力");

    expect(result.reply).toBe("工具链路已经接通。");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      tool: "meta.capabilities",
      result: { tools: ["meta.capabilities"] },
    });
    expect(result.tokenUsage).toMatchObject({ input: 25, output: 12, cacheHit: 3 });
    expect(invocations).toEqual([
      {
        name: "meta.capabilities",
        input: { includeUnavailable: false },
        requestId: "call-meta",
      },
    ]);
  });

  it("caps oversized tool fan-out per iteration and records diagnostics", async () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_ITER + 3 }, (_, index) => ({
      id: `call-${index + 1}`,
      name: "meta.capabilities",
      args: {},
    }));
    const provider = sequenceProvider([
      { functionCalls: calls },
      { text: "最终答案：已完成截断保护。" },
    ]);
    const invocations: ToolInvocation[] = [];
    const runtime = new AgentRuntime({
      aiProvider: provider,
      toolRouter: {
        async invoke(invocation: ToolInvocation): Promise<ToolResultEnvelope> {
          invocations.push(invocation);
          return toolSuccess(
            { name: "meta.capabilities", resource: "meta", action: "capabilities" },
            { ok: true },
            { requestId: invocation.requestId },
          );
        },
      },
      additionalTools: ["meta.capabilities"],
    });

    const result = await runtime.reactLoop("触发 fan-out");

    expect(invocations).toHaveLength(MAX_TOOL_CALLS_PER_ITER);
    expect(result.toolCalls).toHaveLength(MAX_TOOL_CALLS_PER_ITER);
    expect(result.diagnostics?.truncatedToolCalls).toBe(3);
    expect(result.reply).toBe("已完成截断保护。");
  });

  it("executes AgentMessage-like envelopes and emits replies, progress, and bus events", async () => {
    const replies: string[] = [];
    const progressTypes: string[] = [];
    const bus = new AgentEventBus();
    const events: string[] = [];
    bus.subscribe("*", (event) => {
      events.push(event.type);
    });
    const runtime = new AgentRuntime(
      {
        aiProvider: sequenceProvider([{ text: "Final Answer: 收到。" }]),
        toolRouter: neverInvokedToolRouter(),
        onProgress: (event) => {
          progressTypes.push(event.type);
        },
      },
      { eventBus: bus },
    );

    const result = await runtime.execute({
      content: "ping",
      channel: "mcp",
      session: { id: "s1", history: [{ role: "user", content: "历史" }] },
      replyFn: (text) => {
        replies.push(text);
      },
    });

    expect(result.reply).toBe("收到。");
    expect(replies).toEqual(["收到。"]);
    expect(progressTypes).toContain("agent:started");
    expect(progressTypes).toContain("agent:completed");
    expect(events).toContain("agent:started");
    expect(events).toContain("agent:completed");
    expect(result.state.phase).toBe("completed");
  });

  it("keeps evolution decision retry restricted to knowledge.manage decisions", async () => {
    let invoked = false;
    const result = await createToolPipeline().execute(
      { id: "call-search", name: "knowledge.search", args: { query: "escape" } },
      {
        toolRouter: {
          async invoke(): Promise<ToolResultEnvelope> {
            invoked = true;
            throw new Error("decision-only guard should block before router");
          },
        },
        allowedToolIds: ["knowledge.search", "knowledge.manage"],
        iteration: 1,
        sharedState: { _evolutionDecisionOnly: true },
      },
    );

    expect(invoked).toBe(false);
    expect(result.metadata.blocked).toBe(true);
    expect(result.result).toMatchObject({
      error: expect.stringContaining("Evolution retry is decision-only"),
    });
  });

  it("returns dimensionDigest JSON when system bootstrap exits through forced summary", async () => {
    const runtime = new AgentRuntime({
      toolRouter: neverInvokedToolRouter(),
    });

    const result = await runtime.reactLoop("bootstrap dimension", {
      source: "system",
      tracker: { pipelineType: "bootstrap", iteration: 3 },
    });

    expect(result.reply).toContain("dimensionDigest");
    expect(result.reply).toContain('"candidateCount"');
    expect(result.diagnostics?.degraded).toBe(true);
  });

  it("executes pending L4 compaction and records its token usage", async () => {
    const usage = { input: 0, output: 0, reasoning: 0, cacheHit: 0 };
    const budget = new BudgetController({
      maxSessionInputTokens: 100,
      cumulativeUsage: usage,
      contextWindow: {
        compactIfNeeded: () => ({ level: 3, removed: 1 }),
        compactL4: async () => ({
          removed: 2,
          usage: { inputTokens: 4, outputTokens: 5, reasoningTokens: 1, cacheHitTokens: 2 },
        }),
      },
    });

    budget.requestL4Compaction();
    const result = await budget.executeL4IfPending(sequenceProvider([{ text: "summary" }]));

    expect(result).toEqual({ level: 4, removed: 2 });
    expect(usage).toEqual({ input: 4, output: 5, reasoning: 1, cacheHit: 2 });
    expect(budget.pendingL4).toBe(false);
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

function sequenceProvider(results: readonly LLMResult[]): RuntimeAiProvider {
  let index = 0;
  return {
    async chatWithTools(): Promise<LLMResult> {
      const result = results[index] ?? results.at(-1);
      index += 1;
      if (!result) {
        throw new Error("sequenceProvider requires at least one result.");
      }
      return result;
    },
  };
}
