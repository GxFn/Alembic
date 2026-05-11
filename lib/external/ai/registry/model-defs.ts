/**
 * ModelDef — LLM 模型能力声明式定义
 *
 * 所有模型的能力、约束、容量信息集中在此接口描述。
 * 消费方（ContextWindow、ParameterGuard、Gateway、Dashboard）
 * 统一从 ModelRegistry 查询，而非各自硬编码。
 */

export type ProviderId = 'openai' | 'deepseek' | 'claude' | 'google' | 'ollama' | 'mock';

export interface ModelDef {
  /** 唯一标识: provider:apiModelId */
  id: string;
  displayName: string;
  provider: ProviderId;
  /** 实际 API 调用使用的模型 ID */
  apiModelId: string;

  // ── 容量 ──
  contextWindow: number;
  maxOutputTokens: number;

  // ── 能力标记 ──
  capabilities: ModelCapabilities;

  // ── 推理/思维 ──
  reasoning: ReasoningSpec;

  // ── 参数约束 ──
  parameterConstraints: ParameterConstraints;

  /** 废弃标记 */
  deprecated?: { retireDate: string; migrateToId: string };
}

export interface ModelCapabilities {
  toolCalling: boolean;
  vision: boolean;
  embedding: boolean;
  jsonMode: boolean;
  streaming: boolean;
}

export interface ReasoningSpec {
  supported: boolean;
  /** thinking: DeepSeek/Claude extended, adaptive: Opus 4.7, reasoning_effort: OpenAI */
  mode?: 'thinking' | 'adaptive' | 'reasoning_effort';
  /** 多轮对话需要回传 reasoning_content (DeepSeek V4) */
  requiresContentPassback?: boolean;
  defaultEffort?: string;
  effortLevels?: string[];
}

export interface ParameterConstraints {
  temperature?: ParameterRule<number>;
  topP?: ParameterRule<number>;
  topK?: ParameterRule<number>;
  toolChoice?: ParameterRule<string>;
  reasoningEffort?: ParameterRule<string>;
}

export interface ParameterRule<T> {
  allowed: boolean;
  /** 条件禁用 (如 'thinking' = thinking 模式下不允许) */
  disabledWhen?: string;
  defaultValue?: T;
  min?: T;
  max?: T;
  allowedValues?: T[];
}

/** Provider 配置 */
export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  /** 默认模型的 ModelDef.id */
  defaultModelId: string;
  keyEnvVar: string;
  baseUrlEnvVar?: string;
  baseUrl: string;
}
