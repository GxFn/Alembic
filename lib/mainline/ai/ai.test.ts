import { describe, expect, it } from "vitest";
import type { EvidencePackage } from "../knowledge/index.js";
import { AiCapabilityPolicy } from "./AiCapabilityPolicy.js";
import type { MainlineAgentAiPort } from "./AiPort.js";
import { AiProviderMainlineAdapter } from "./AiProviderAdapter.js";
import { AiTaskPlanner } from "./AiTaskPlanner.js";
import { ParameterGuard } from "./guard/ParameterGuard.js";
import type { ModelDef } from "./registry/model-defs.js";

describe("Mainline AI boundaries", () => {
  it("blocks missing and mock providers before any mainline AI task runs", async () => {
    const policy = new AiCapabilityPolicy();
    expect(policy.decide(undefined)).toMatchObject({ allowed: false });
    expect(policy.decide({ provider: "mock", ready: true, mock: true })).toMatchObject({
      allowed: false,
    });

    const adapter = new AiProviderMainlineAdapter({
      provider: mockProvider(),
      status: { provider: "mock", model: "fake", ready: true, mock: true },
    });

    await expect(
      adapter.generateText({
        task: {
          id: "task-1",
          origin: "content-mining",
          kind: "summarize-evidence",
          title: "Summarize evidence",
          prompt: "Summarize",
        },
      }),
    ).rejects.toThrow("mock");
  });

  it("filters model-specific parameters through ParameterGuard", () => {
    const guarded = ParameterGuard.guard(thinkingModel(), {
      temperature: 0.7,
      toolChoice: "auto",
      reasoningEffort: "maximum",
      maxTokens: 9000,
    });

    expect(guarded.temperature).toBeUndefined();
    expect(guarded.toolChoice).toBeUndefined();
    expect(guarded.reasoningEffort).toBe("high");
    expect(guarded.maxTokens).toBe(4096);
    expect(guarded.filtered.map((entry) => entry.param)).toEqual([
      "temperature",
      "toolChoice",
      "reasoningEffort",
    ]);
  });

  it("marks AI task plans as blocked, degraded, or ready from provider status", () => {
    const planner = new AiTaskPlanner();

    expect(
      planner.planContentMining({
        evidencePackage: evidenceFixture(),
        providerStatus: undefined,
      }),
    ).toMatchObject({
      status: "blocked",
      allowed: false,
      degraded: true,
      tasks: [],
    });

    expect(
      planner.planContentMining({
        evidencePackage: evidenceFixture(),
        providerStatus: {
          provider: "openai",
          model: "gpt-test",
          ready: false,
          mock: false,
          reason: "API key missing.",
        },
      }),
    ).toMatchObject({
      status: "degraded",
      allowed: false,
      degraded: true,
      tasks: [],
    });

    const ready = planner.planContentMining({
      evidencePackage: evidenceFixture(),
      providerStatus: {
        provider: "openai",
        model: "gpt-test",
        ready: true,
        mock: false,
      },
    });
    expect(ready).toMatchObject({
      status: "ready",
      allowed: true,
      degraded: false,
    });
    expect(ready.tasks.map((task) => task.kind)).toEqual([
      "summarize-evidence",
      "propose-recipe-edges",
    ]);
  });
});

function mockProvider(): MainlineAgentAiPort {
  return {
    name: "mock",
    model: "fake",
    async chat() {
      return "should not run";
    },
    async chatWithTools() {
      return { text: "should not run" };
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
