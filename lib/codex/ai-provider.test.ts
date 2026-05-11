import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexEmbeddingProviderFromEnv,
  createCodexRuntimeAiProviderFromEnv,
} from "./ai-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Codex environment AI provider", () => {
  it("creates an OpenAI-compatible RuntimeAiProvider and maps sanitized tool calls back", async () => {
    const requests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)) as unknown);
        return jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "code__search",
                      arguments: JSON.stringify({ pattern: "runtime" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        });
      }),
    );

    const provider = createCodexRuntimeAiProviderFromEnv({
      ALEMBIC_AI_PROVIDER: "openai",
      ALEMBIC_OPENAI_API_KEY: "sk-test",
      ALEMBIC_AI_MODEL: "openai:gpt-5.4-mini",
    });

    expect(provider).not.toBeNull();
    const result = await provider?.chatWithTools("Use tools", {
      tools: [
        {
          name: "code.search",
          description: "Search code",
          parameters: { type: "object", properties: { pattern: { type: "string" } } },
        },
      ],
    });

    expect(result?.functionCalls?.[0]).toMatchObject({
      id: "call-1",
      name: "code.search",
      args: { pattern: "runtime" },
    });
    expect(result?.usage).toMatchObject({ inputTokens: 12, outputTokens: 5 });
    expect(JSON.stringify(requests[0])).toContain("code__search");
  });

  it("returns null without supported real provider configuration", () => {
    expect(createCodexRuntimeAiProviderFromEnv({})).toBeNull();
    expect(
      createCodexRuntimeAiProviderFromEnv({
        ALEMBIC_AI_PROVIDER: "google",
        ALEMBIC_GOOGLE_API_KEY: "key",
      }),
    ).toBeNull();
  });

  it("creates an embedding provider from env and reads vectors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }),
      ),
    );
    const provider = createCodexEmbeddingProviderFromEnv({
      ALEMBIC_EMBED_PROVIDER: "openai",
      ALEMBIC_OPENAI_API_KEY: "sk-test",
      ALEMBIC_EMBED_MODEL: "text-embedding-3-small",
    });

    await expect(provider?.embedBatch(["a", "b"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(provider?.status()).toMatchObject({ provider: "openai", ready: true, mock: false });
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
