/**
 * AI runtime availability helper.
 *
 * Product runtime no longer represents "unconfigured AI" with a mock provider.
 * A missing provider / manager is an explicit unavailable state; callers should
 * stop before constructing AgentRuntime work instead of falling through to fake
 * output.
 */

export interface AiRuntimeStatusContainer {
  singletons?: Record<string, unknown>;
}

export interface AiRuntimeStatus {
  ready: boolean;
  reason: 'not-configured' | 'mock-provider-disabled' | null;
  providerName: string | null;
  model: string | null;
}

interface AiRuntimeProviderLike {
  name?: string;
  model?: string;
}

interface AiRuntimeManagerLike {
  isMock?: boolean;
  isReady?: boolean;
  name?: string;
  model?: string;
}

export function getAiRuntimeStatus(container: AiRuntimeStatusContainer | null): AiRuntimeStatus {
  const singletons = container?.singletons ?? {};
  const manager = singletons._aiProviderManager as AiRuntimeManagerLike | null | undefined;
  const provider = singletons.aiProvider as AiRuntimeProviderLike | null | undefined;
  const providerName = provider?.name ?? manager?.name ?? null;
  const model = provider?.model ?? manager?.model ?? null;
  const mockSelected = providerName === 'mock' || manager?.isMock === true;

  if (mockSelected) {
    return {
      ready: false,
      reason: 'mock-provider-disabled',
      providerName,
      model,
    };
  }

  const ready = Boolean(provider && manager && manager.isReady === true);
  return {
    ready,
    reason: ready ? null : 'not-configured',
    providerName,
    model,
  };
}

export function getAiUnavailableMessage(status: AiRuntimeStatus): string {
  if (status.reason === 'mock-provider-disabled') {
    return 'AI Provider mock 模式已从产品运行态移除。请配置真实 AI Provider 后重试。';
  }
  return 'AI Provider 未配置。请先在 Alembic Dashboard 的 AI Settings 中配置真实 API Key 后重试。';
}
