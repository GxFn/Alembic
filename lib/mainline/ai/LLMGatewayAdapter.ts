import { AiCapabilityPolicy } from "./AiCapabilityPolicy.js";
import type {
  AiGatewayChatRequest,
  AiJsonRequest,
  AiJsonResult,
  AiProviderStatus,
  AiTextRequest,
  AiTextResult,
  MainlineAiPort,
  MainlineLLMGatewayPort,
} from "./AiPort.js";

export type MainlineLLMGatewayLike = Pick<MainlineLLMGatewayPort, "chat" | "chatStructured">;

export interface LLMGatewayMainlineAdapterOptions {
  gateway: MainlineLLMGatewayLike;
  status: AiProviderStatus;
  modelRef: string;
  systemPrompt?: string;
}

/**
 * LLMGatewayMainlineAdapter 把 Gateway 形态的 AI 调用收束为 MainlineAiPort。
 * 这个类属于新主线，不再放在 legacy；旧 Gateway 只是一个可替换实现来源。
 */
export class LLMGatewayMainlineAdapter implements MainlineAiPort {
  readonly #gateway: MainlineLLMGatewayLike;
  readonly #status: AiProviderStatus;
  readonly #modelRef: string;
  readonly #systemPrompt: string | undefined;
  readonly #policy: AiCapabilityPolicy;

  constructor(options: LLMGatewayMainlineAdapterOptions, policy = new AiCapabilityPolicy()) {
    this.#gateway = options.gateway;
    this.#status = options.status;
    this.#modelRef = options.modelRef;
    this.#systemPrompt = options.systemPrompt;
    this.#policy = policy;
  }

  status(): AiProviderStatus {
    return { ...this.#status };
  }

  async generateText(request: AiTextRequest): Promise<AiTextResult> {
    this.#assertReady();
    const text = await this.#gateway.chat(this.#buildChatRequest(request, "text"));

    return {
      text,
      provider: this.#status.provider,
      model: this.#status.model,
    };
  }

  #buildChatRequest(
    request: AiTextRequest,
    responseFormat: AiGatewayChatRequest["responseFormat"],
  ): AiGatewayChatRequest {
    return {
      modelRef: this.#modelRef,
      prompt: request.task.prompt,
      systemPrompt: this.#systemPrompt,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      responseFormat,
      abortSignal: request.abortSignal,
    };
  }

  async generateJson(request: AiJsonRequest): Promise<AiJsonResult> {
    this.#assertReady();
    const value =
      this.#gateway.chatStructured !== undefined
        ? await this.#gateway.chatStructured({
            modelRef: this.#modelRef,
            prompt: request.task.prompt,
            systemPrompt: this.#systemPrompt,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            responseFormat: "json",
            abortSignal: request.abortSignal,
          })
        : await this.#generateJsonViaText(request);

    return {
      value,
      provider: this.#status.provider,
      model: this.#status.model,
    };
  }

  async #generateJsonViaText(request: AiJsonRequest): Promise<unknown> {
    const text = await this.#gateway.chat(this.#buildChatRequest(request, "json"));

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(
        `LLMGatewayMainlineAdapter expected JSON output but received invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  #assertReady(): void {
    const decision = this.#policy.decide(this.#status);
    if (!decision.allowed) {
      throw new Error(`Mainline AI call blocked: ${decision.reason}`);
    }
  }
}
