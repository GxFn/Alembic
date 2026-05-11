/**
 * ModelRegistry — 模型能力注册中心
 *
 * 统一管理所有 LLM 模型的能力声明、约束条件和容量信息。
 * 替代 ContextWindow.MODEL_CONTEXT_WINDOWS 正则表和各 Provider 中的硬编码判断。
 *
 * 消费方:
 *   - ContextWindow: 查询上下文窗口
 *   - ParameterGuard: 查询参数约束
 *   - Dashboard/Routes: 查询可用模型列表
 *   - Provider: 查询模型推理能力
 */

import type { ModelDef, ProviderId } from './model-defs.js';
import { CLAUDE_MODELS } from './models/claude.js';
import { DEEPSEEK_MODELS } from './models/deepseek.js';
import { GOOGLE_MODELS } from './models/google.js';
import { OLLAMA_MODELS } from './models/ollama.js';
import { OPENAI_MODELS } from './models/openai.js';

const ALL_BUILTIN_MODELS: ModelDef[] = [
  ...OPENAI_MODELS,
  ...CLAUDE_MODELS,
  ...DEEPSEEK_MODELS,
  ...GOOGLE_MODELS,
  ...OLLAMA_MODELS,
];

export class ModelRegistry {
  #models = new Map<string, ModelDef>();

  constructor() {
    for (const def of ALL_BUILTIN_MODELS) {
      this.#models.set(def.id, def);
    }
  }

  /** 精确查找: 'openai:gpt-5.5' */
  get(modelRef: string): ModelDef | undefined {
    return this.#models.get(modelRef);
  }

  /** 模糊查找: (provider='openai', apiModelId='gpt-5.5') → ModelDef */
  resolve(provider: string, apiModelId: string): ModelDef | undefined {
    // 先尝试直接组合
    const direct = this.#models.get(`${provider}:${apiModelId}`);
    if (direct) {
      return direct;
    }
    // 回退到遍历匹配
    for (const m of this.#models.values()) {
      if (m.provider === provider && m.apiModelId === apiModelId) {
        return m;
      }
    }
    return undefined;
  }

  /**
   * 智能解析 — 兼容旧配置
   *
   * 优先级: 精确匹配 → provider+model 组合 → 动态定义
   */
  resolveOrCreate(provider: string, apiModelId: string): ModelDef {
    return (
      this.resolve(provider, apiModelId) ??
      this.createDynamicDef(provider as ProviderId, apiModelId)
    );
  }

  /** 列出指定 provider 的所有模型 */
  listByProvider(provider: string): ModelDef[] {
    return [...this.#models.values()].filter((m) => m.provider === provider && !m.deprecated);
  }

  /** 列出所有非废弃模型 */
  listActive(): ModelDef[] {
    return [...this.#models.values()].filter((m) => !m.deprecated);
  }

  /** 按能力查询 */
  findByCapability(cap: keyof ModelDef['capabilities']): ModelDef[] {
    return [...this.#models.values()].filter((m) => m.capabilities[cap] && !m.deprecated);
  }

  /** 获取上下文窗口 (替代 ContextWindow.MODEL_CONTEXT_WINDOWS) */
  getContextWindow(provider: string, apiModelId: string): number | undefined {
    return this.resolve(provider, apiModelId)?.contextWindow;
  }

  /** 运行时注册自定义模型 */
  register(def: ModelDef): void {
    this.#models.set(def.id, def);
  }

  /** 注册数量 */
  get size(): number {
    return this.#models.size;
  }

  /** 为未注册模型创建保守的默认定义 */
  createDynamicDef(provider: ProviderId, apiModelId: string): ModelDef {
    return {
      id: `${provider}:${apiModelId}`,
      displayName: apiModelId,
      provider,
      apiModelId,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: {
        toolCalling: true,
        vision: false,
        embedding: false,
        jsonMode: false,
        streaming: true,
      },
      reasoning: { supported: false },
      parameterConstraints: {
        temperature: { allowed: true, min: 0, max: 2 },
        toolChoice: { allowed: true },
      },
    };
  }
}

/** 全局单例 */
let _instance: ModelRegistry | null = null;

export function getModelRegistry(): ModelRegistry {
  if (!_instance) {
    _instance = new ModelRegistry();
  }
  return _instance;
}
