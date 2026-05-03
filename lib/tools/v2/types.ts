/**
 * @module tools/v2/types
 *
 * V2 工具系统核心类型定义 — 所有 handler、router、capability 的类型基础。
 */

/** JSON Schema 类型简化定义，避免外部依赖 */
export type JSONSchema4 = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/*  Tool Spec & Registry                                               */
/* ------------------------------------------------------------------ */

/** 单个 action 的完整定义 */
export interface ToolAction {
  /** 一行描述 — 用于轻量 schema（首轮发给 LLM） */
  summary: string;
  /** 完整描述 — meta.tools 展开时返回 */
  description: string;
  /** 参数 JSON Schema */
  params: JSONSchema4;
  /** 实际执行函数 */
  handler: ActionHandler;
  /** 缓存策略: none=不缓存, session=会话级, delta=文件hash增量 */
  cache?: 'none' | 'session' | 'delta';
  /** 并发模式: parallel=并行, single=同工具互斥, exclusive=全局独占 */
  concurrency?: 'parallel' | 'single' | 'exclusive';
  /** 风险等级 */
  risk?: 'read-only' | 'write' | 'side-effect';
  /** 输出 token 上限（超出由 compressor 截断） */
  maxOutputTokens?: number;
}

/** 一个工具的完整规格（包含多个 action） */
export interface ToolSpec {
  name: string;
  description: string;
  actions: Record<string, ToolAction>;
}

/** 工具注册表类型 */
export type ToolRegistry = Record<string, ToolSpec>;

/* ------------------------------------------------------------------ */
/*  Tool Call & Result                                                 */
/* ------------------------------------------------------------------ */

/** LLM 发出的工具调用（router 解析后） */
export interface ToolCallV2 {
  tool: string;
  action: string;
  params: Record<string, unknown>;
}

/** 结果元信息 — 对 LLM 不可见，供 ContextWindow 消费 */
export interface ToolResultMeta {
  cached: boolean;
  compression?: { parser: string; ratio: number };
  tokensEstimate: number;
  durationMs: number;
}

/** 工具返回值统一结构 */
export interface ToolResult {
  ok: boolean;
  data: unknown;
  error?: string;
  _meta?: ToolResultMeta;
}

/* ------------------------------------------------------------------ */
/*  Handler Context (DI)                                               */
/* ------------------------------------------------------------------ */

/**
 * Handler 执行上下文 — 通过 DI 注入外部依赖。
 *
 * 设计约束:
 * - 各字段为可选（不是所有 handler 都需要全部依赖），由 ToolContextFactory 在调用前按需组装
 * - 重量级服务 (projectGraph/searchEngine 等) 使用 `unknown` 类型是有意为之:
 *   这些服务的真实接口定义在各自的 handler 文件中（duck typing），
 *   避免 types.ts 反向依赖 handler 或外部服务模块
 * - 轻量级工具组件 (deltaCache/searchCache 等) 通过 DI 接口 (*Like) 定义最小契约
 */
export interface ToolContext {
  /** 项目根目录绝对路径 */
  projectRoot: string;

  // ── 重量级 DI 服务 (duck-typed, 真实接口见各 handler) ──

  /** AST 图谱 — graph handler 内部 cast 为 ProjectGraphLike */
  projectGraph?: unknown;

  /** 代码实体图谱 — graph handler 内部 cast 为 CodeEntityGraphLike */
  codeEntityGraph?: unknown;

  /** 知识搜索引擎 — knowledge handler 内部 cast 为 SearchEngineLike */
  searchEngine?: unknown;

  /** 知识提交网关 — knowledge handler 内部 cast 为 RecipeGatewayLike */
  recipeGateway?: unknown;

  /** 知识仓库 — knowledge handler 内部 cast 为 KnowledgeRepoLike */
  knowledgeRepo?: unknown;

  /** AST 分析器 — code handler 内部 cast 为 AstAnalyzerLike */
  astAnalyzer?: unknown;

  /** 安全策略 — terminal handler 可选引用 */
  safetyPolicy?: unknown;

  /** Seatbelt 沙箱执行器 — terminal handler 通过 DI 注入，未注入时降级为 plain exec */
  sandboxExecutor?: unknown;

  // ── 轻量级工具组件 (通过 DI 接口约束) ──

  /** 文件读取增量缓存 */
  deltaCache?: DeltaCacheLike;

  /** 搜索结果缓存 */
  searchCache?: SearchCacheLike;

  /** 会话记忆存储 */
  sessionStore?: SessionStoreLike;

  /** 终端输出压缩器 */
  compressor?: OutputCompressorLike;

  // ── 运行时参数 ──

  /** 本次调用 token 预算 (影响输出截断) */
  tokenBudget: number;

  /** 取消信号 */
  abortSignal?: AbortSignal;

  /** 工具注册表引用 (meta.tools 自省需要，由 router 自动注入) */
  toolRegistry?: ToolRegistry;

  /** Agent 记忆协调器 — memory.note_finding 桥接到 ActiveContext.#scratchpad */
  memoryCoordinator?: MemoryCoordinatorLike;
}

/** action handler 函数签名 */
export type ActionHandler = (
  params: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolResult>;

/* ------------------------------------------------------------------ */
/*  Capability V2                                                      */
/* ------------------------------------------------------------------ */

/** V2 Capability 定义 — tool → 允许的 action 列表 */
export interface CapabilityV2Def {
  name: string;
  description: string;
  promptFragment?: string;
  allowedTools: Record<string, string[]>;
}

/* ------------------------------------------------------------------ */
/*  DI 接口 (Lightweight)                                              */
/* ------------------------------------------------------------------ */

/** MemoryCoordinator 最小接口 — memory.note_finding 通过此接口写入 ActiveContext */
export interface MemoryCoordinatorLike {
  noteFinding(
    finding: string,
    evidence: string,
    importance: number,
    round: number,
    scopeId?: string
  ): string;
}

/** DeltaCache 最小接口 */
export interface DeltaCacheLike {
  get(path: string): { hash: string; content: string } | undefined;
  set(path: string, hash: string, content: string): void;
  check(
    path: string,
    currentContent: string
  ): { mode: 'unchanged' | 'delta' | 'full'; content: string; lineCount: number };
}

/** SearchCache 最小接口 */
export interface SearchCacheLike {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
}

/** SessionStore 最小接口 */
export interface SessionStoreLike {
  save(key: string, content: string, meta?: Record<string, unknown>): void;
  recall(
    query?: string,
    opts?: { tags?: string[]; limit?: number }
  ): Array<{
    key: string;
    content: string;
    meta?: Record<string, unknown>;
  }>;
}

/** OutputCompressor 最小接口 */
export interface OutputCompressorLike {
  compress(raw: string, opts: CompressOpts): string | Promise<string>;
}

export interface CompressOpts {
  command?: string;
  tokenBudget?: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** 快速构建成功结果 */
export function ok(data: unknown, meta?: Partial<ToolResultMeta>): ToolResult {
  return {
    ok: true,
    data,
    _meta: {
      cached: false,
      tokensEstimate: 0,
      durationMs: 0,
      ...meta,
    },
  };
}

/** 快速构建失败结果 */
export function fail(error: string): ToolResult {
  return { ok: false, data: null, error };
}

/** 简易 token 估算（1 token ≈ 4 chars） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
