import type { AiProviderStatus } from "./AiPort.js";

export interface AiCapabilityDecision {
  allowed: boolean;
  reason: string;
}

/**
 * AiCapabilityPolicy 负责把 provider 状态转成主线是否允许调用 AI 的决策。
 * 它的核心原则很硬：没有真实 provider 就显式 blocked，不用 mock 顶替。
 *
 * 注意：mock 只能出现在单元测试自己的替身对象里，不能通过这个策略进入
 * mainline 运行路径。这样失败会停在 readiness 边界，而不是悄悄产出假知识。
 */
export class AiCapabilityPolicy {
  decide(status: AiProviderStatus | null | undefined): AiCapabilityDecision {
    if (!status) {
      return {
        allowed: false,
        reason: "AI provider 状态缺失，主线不会使用 mock fallback。",
      };
    }

    if (status.mock) {
      return {
        allowed: false,
        reason: `AI provider "${status.provider}" 是 mock，不能进入新主线。`,
      };
    }

    if (!status.ready) {
      return {
        allowed: false,
        reason: status.reason ?? `AI provider "${status.provider}" 尚未 ready。`,
      };
    }

    return {
      allowed: true,
      reason: `AI provider "${status.provider}" 可用于 mainline AI task。`,
    };
  }
}
