import type {
  AiProviderStatus,
  MainlineAgentAiPort,
  MainlineAiPort,
  MainlineEmbeddingPort,
} from "./AiPort.js";
import { AiProviderMainlineAdapter, inferProviderStatus } from "./AiProviderAdapter.js";

export interface MainlineAiProviderManagerLike {
  provider: unknown;
  embedProvider?: unknown;
  isReady?: boolean;
  isMock?: boolean;
  name?: string;
  model?: string;
}

/**
 * 从 provider manager 生成主线 AI 端口。
 * manager 仍可负责热切换，但 agent/workflows 只消费 mainlineAi/mainlineEmbedding。
 *
 * 这里刻意只投影 provider/readiness 状态，不迁移旧 provider manager 的平台外壳。
 */
export function createMainlineAiFromManager(
  manager: MainlineAiProviderManagerLike,
): MainlineAiPort & MainlineAgentAiPort {
  return new AiProviderMainlineAdapter({
    provider: () => manager.provider as MainlineAgentAiPort | null,
    status: () => projectMainlineAiStatusFromManager(manager),
  });
}

/**
 * 从 provider manager 生成主线 embedding 端口。
 * embedding provider 可以是独立模型，也可以回退到主 provider；调用侧不再关心这个来源。
 */
export function createMainlineEmbeddingFromManager(
  manager: MainlineAiProviderManagerLike,
): MainlineEmbeddingPort {
  return new AiProviderMainlineAdapter({
    provider: () => (manager.embedProvider ?? manager.provider) as MainlineAgentAiPort | null,
    embeddingProvider: () =>
      (manager.embedProvider ?? manager.provider) as MainlineAgentAiPort | null,
    status: () =>
      inferProviderStatus(
        (manager.embedProvider ?? manager.provider) as MainlineAgentAiPort | null,
      ),
  });
}

export function projectMainlineAiStatusFromManager(
  manager: MainlineAiProviderManagerLike,
): AiProviderStatus {
  const provider = manager.provider as MainlineAgentAiPort | null;
  const fallback = inferProviderStatus(provider);
  const providerName = manager.name ?? fallback.provider;
  // manager 显式声明 mock 时优先相信声明；否则按 provider 名称兜底识别。
  const mock = manager.isMock ?? providerName === "mock";
  const ready = manager.isReady ?? (!!provider && !mock);
  return {
    provider: providerName,
    model: manager.model ?? fallback.model,
    ready,
    mock,
    reason: ready ? undefined : (fallback.reason ?? `AI provider "${providerName}" 尚未 ready。`),
  };
}
