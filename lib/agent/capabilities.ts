/**
 * Capabilities — 可组合的 Agent 技能模块
 *
 * 核心思想: Agent 的能力不由"类型"决定，而由加载了哪些 Capability 模块决定。
 *
 * 每个 Capability 提供:
 *   1. promptFragment — 系统提示词片段 (告诉 LLM 它能做什么)
 *   2. tools — 工具白名单 (该能力需要哪些工具)
 *   3. hooks — 生命周期钩子 (可选的前/后处理)
 *
 * 组合示例:
 *   - 用户聊天 = Conversation + CodeAnalysis
 *   - 冷启动分析 = CodeAnalysis + KnowledgeProduction
 *   - 飞书远程执行 = Conversation + SystemInteraction
 *   - 智能全能 = Conversation + CodeAnalysis + KnowledgeProduction + SystemInteraction
 *
 * 这就是为什么"飞书聊天"和"前端聊天"是同一个概念:
 *   它们加载相同的 Capability，只是到达方式 (Transport) 不同。
 *
 * @module capabilities
 */

import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '#shared/package-root.js';

// ─── Types ──────────────────────────────────────────

/** Context input for buildContext method */
interface ContextInput {
  projectBriefing?: string | null;
  memoryMode?: string;
  [key: string]: unknown;
}

/** Step result from ReAct loop */
interface StepResult {
  toolCalls?: Array<{ tool: string; args: unknown; result: unknown }>;
  [key: string]: unknown;
}

/** Memory coordinator interface (subset used by Conversation) */
interface MemoryCoordinator {
  buildPromptInjection(mode: string): string | null;
  cacheToolResult?(tool: string, args: unknown, result: unknown): void;
}

/** Conversation capability constructor options */
interface ConversationOpts {
  memoryCoordinator?: MemoryCoordinator | null;
  soulPath?: string;
  projectBriefing?: string | null;
}

/** SystemInteraction capability constructor options */
interface SystemInteractionOpts {
  projectRoot?: string;
}

// ─── Base Capability ─────────────────────────────────────

/** Capability 基类 — 所有技能模块的抽象接口 */
export class Capability {
  /** 能力名称 */
  get name(): string {
    throw new Error('Subclass must implement name');
  }

  /** 系统提示词片段 */
  get promptFragment(): string {
    throw new Error('Subclass must implement promptFragment');
  }

  /** 工具白名单 */
  get tools(): string[] {
    return [];
  }

  /** 构建 prompt 时调用，可注入动态上下文 */
  buildContext(_context: unknown): string | null {
    return null;
  }

  /** 每轮 ReAct 步骤前的钩子 */
  onBeforeStep(_stepState: unknown) {}

  /** 每轮 ReAct 步骤后的钩子 */
  onAfterStep(_stepResult: unknown) {}
}

// ─── Conversation — 对话能力 ─────────────────────

/**
 * 对话能力: 多轮问答、知识检索、记忆管理
 *
 * 核心工具: 知识库搜索、语义搜索
 * 用于: 用户聊天、飞书聊天、任何需要对话的场景
 */
export class Conversation extends Capability {
  #memoryCoordinator;
  #soulContent;
  #projectBriefing;

  /**
   * @param [opts.memoryCoordinator] MemoryCoordinator 实例
   * @param [opts.soulPath] SOUL.md 路径
   * @param [opts.projectBriefing] 项目概况文本
   */
  constructor(opts: ConversationOpts = {}) {
    super();
    this.#memoryCoordinator = opts.memoryCoordinator || null;
    this.#projectBriefing = opts.projectBriefing || null;

    // 加载 SOUL.md (人格定义)
    const soulPath = opts.soulPath || path.resolve(PACKAGE_ROOT, 'SOUL.md');
    try {
      this.#soulContent = fs.existsSync(soulPath)
        ? fs.readFileSync(soulPath, 'utf-8').trim()
        : null;
    } catch {
      this.#soulContent = null;
    }
  }

  get name() {
    return 'conversation';
  }

  get promptFragment() {
    return `## 对话能力
你是 Alembic 知识管理助手。

行为规则:
1. 回答问题时优先从知识库搜索相关知识
2. 用户要求编辑/创建知识时，通过工具完成
3. 每轮至少调用一个工具获取信息（除非纯闲聊）
4. 保持对话连贯性，引用之前的上下文`;
  }

  get tools() {
    return [
      // 知识检索 (内部 ToolRegistry 名称)
      'search_knowledge',
      'search_recipes',
      'get_recipe_detail',
      'get_related_recipes',
      // 语义搜索
      'semantic_search_code',
      // 知识管理
      'submit_knowledge',
      'knowledge_overview',
      // 项目统计
      'get_project_stats',
    ];
  }

  buildContext(context: ContextInput) {
    const parts: string[] = [];

    // SOUL.md 人格注入
    if (this.#soulContent) {
      parts.push(this.#soulContent);
    }

    // 项目概况 (优先用 context 传入的, 回退到构造器注入的)
    const briefing = context.projectBriefing || this.#projectBriefing;
    if (briefing) {
      parts.push(`## 项目概况\n${briefing}`);
    }

    // 记忆注入
    if (this.#memoryCoordinator) {
      try {
        const memoryContext = this.#memoryCoordinator.buildPromptInjection(
          context.memoryMode || 'user'
        );
        if (memoryContext) {
          parts.push(`## 记忆上下文\n${memoryContext}`);
        }
      } catch {
        /* non-critical */
      }
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  onAfterStep(stepResult: StepResult) {
    // 缓存工具结果到记忆
    if (this.#memoryCoordinator && stepResult.toolCalls?.length) {
      try {
        for (const tc of stepResult.toolCalls) {
          this.#memoryCoordinator.cacheToolResult?.(tc.tool, tc.args, tc.result);
        }
      } catch {
        /* non-critical */
      }
    }
  }
}

// ─── CodeAnalysis — 代码分析能力 ─────────────────

/**
 * 代码分析能力: AST 解析、代码搜索、结构理解
 *
 * 核心工具: AST 工具集 + 文件读取 + 代码搜索
 * 用于: 用户聊天中的代码问题、冷启动分析、目标扫描
 */
export class CodeAnalysis extends Capability {
  get name() {
    return 'code_analysis';
  }

  get promptFragment() {
    return `## 代码分析能力
你是高级软件架构师，可以深度分析代码结构。

分析策略:
| 阶段 | 目标 |
|------|------|
| 全局扫描 | get_project_overview + list_project_structure |
| 结构化探索 | get_class_hierarchy / search_project_code 批量搜索 |
| 深度验证 | read_project_file 阅读关键实现 |
| 输出总结 | 停止工具调用，输出分析 |

关键规则:
- 批量搜索: search_project_code({ patterns: [...] })
- 批量读文件: read_project_file({ filePaths: [...] })
- 不要重复搜索相同关键词
- 输出时包含具体文件路径和代码位置`;
  }

  get tools() {
    return [
      // AST 结构
      'get_project_overview',
      'get_class_hierarchy',
      'get_class_info',
      'get_protocol_info',
      'get_method_overrides',
      'get_category_map',
      // 搜索与读取
      'search_project_code',
      'read_project_file',
      'list_project_structure',
      'get_file_summary',
      'semantic_search_code',
      // 图谱
      'query_code_graph',
      // 探索追踪
      'get_previous_analysis',
      'note_finding',
      'get_previous_evidence',
    ];
  }
}

// ─── KnowledgeProduction — 知识生产能力 ─────────

/**
 * 知识生产能力: 将分析结果转化为结构化知识候选
 *
 * 核心工具: 知识提交 + Guard 检查
 * 用于: 冷启动提交、扫描后提交、用户主动创建知识
 */
export class KnowledgeProduction extends Capability {
  get name() {
    return 'knowledge_production';
  }

  get promptFragment() {
    return `## 知识生产能力
你是知识管理专家，将代码分析转化为结构化知识候选。

每个候选必须有:
1. 清晰的标题 (使用项目真实类名/模块名，不以项目名开头)
2. 项目特写风格的正文 (content.markdown)
3. 相关文件路径
4. 正确的 kind (rule / pattern / fact)
5. 完整的 Cursor 交付字段

工作流:
1. 识别分析中的知识点
2. read_project_file 批量获取代码片段 (如需)
3. submit_knowledge 或 submit_with_check 提交
4. 提交优先于完美 — 文件读取失败时用已有信息直接提交`;
  }

  get tools() {
    // 与 PRODUCER_TOOLS 保持一致: 提交 + 文件读取
    // guard_check_code / validate_candidate 不需要：提交时 UnifiedValidator 已自动校验
    return [
      'submit_knowledge',
      'submit_with_check',
      'read_project_file', // 获取代码片段用于知识正文
    ];
  }
}

// ─── SystemInteraction — 系统交互能力 ────────────

/**
 * 系统交互能力: 结构化终端执行、文件写入、环境探测、项目探索
 *
 * 核心工具: 终端执行 + 文件写入 + 环境信息 + 项目读取
 * 用于: 飞书远程执行、自动化脚本、任何需要操作本地系统的场景
 *
 * ⚙️ 安全设计 (3 层防护):
 *   1. 工具层: terminal_run / write_project_file 内置硬编码安全边界
 *   2. Policy 层: SafetyPolicy.checkCommand() / checkFilePath() 动态拦截
 *   3. Runtime 层: reactLoop 工具执行前自动调用 PolicyEngine.validateToolCall()
 *
 * ⚠️ 该能力通常搭配 SafetyPolicy 使用
 */
export class SystemInteraction extends Capability {
  #projectRoot;

  /** @param [opts.projectRoot] 项目根目录 (限制操作范围) */
  constructor(opts: SystemInteractionOpts = {}) {
    super();
    this.#projectRoot = opts.projectRoot || process.cwd();
  }

  get name() {
    return 'system_interaction';
  }

  get promptFragment() {
    return `## 系统交互能力
你可以在本地环境中执行结构化终端命令、写入文件、探索项目，并读取受治理的本机 macOS 状态。

能力:
1. **终端命令**: terminal_run 执行结构化命令，参数为 { bin, args, env, cwd, timeoutMs, network, filesystem, interactive, session }
   - interactive 默认为 "never"；当前不开放需要人工输入的交互式命令
   - env 默认为单次命令作用域；只有 persistent session 显式声明 envPersistence="explicit" 时才复用显式 env metadata
   - terminal_session_close / terminal_session_cleanup 可显式关闭或清理 persistent session metadata
2. **文件写入**: write_project_file 创建/覆盖项目内文件
3. **环境探测**: get_environment_info 获取 OS/Node/Git/项目信息
4. **项目探索**: 搜索代码、读取文件、列出目录结构
5. **macOS 本机能力**: mac_system_info / mac_permission_status / mac_window_list / mac_screenshot
   - permission status 只报告已知状态，不触发 TCC 授权请求，不绕过系统权限
   - window list 和 screenshot 使用 ScreenCaptureKit helper；窗口标题和图片按敏感 artifact/resource ref 处理

安全规则:
- 所有操作限制在项目目录 (${this.#projectRoot}) 内
- 终端命令必须拆成 bin + args，不接受自由 shell、管道、重定向或命令替换
- 危险可执行文件 (sudo, dd, mkfs, shutdown 等) 和 rm -rf 会被自动拦截
- 受保护文件 (.git/, node_modules/, .env) 不可写入
- SafetyPolicy 可进一步约束可执行命令和可访问路径

最佳实践:
- 执行命令前先 get_environment_info 了解环境
- git 命令用于查看状态、diff、log，不建议执行 push/commit
- 需要执行命令时优先使用明确的 bin 和 args，例如 { "bin": "git", "args": ["status"] }

项目路径: ${this.#projectRoot}`;
  }

  get tools() {
    return [
      // 结构化终端执行
      'terminal_run',
      'terminal_session_close',
      'terminal_session_cleanup',
      // macOS 本机能力
      'mac_system_info',
      'mac_permission_status',
      'mac_window_list',
      'mac_screenshot',
      // 文件写入
      'write_project_file',
      // 环境探测
      'get_environment_info',
      // 项目探索 (只读)
      'search_project_code',
      'read_project_file',
      'list_project_structure',
      'get_project_overview',
      'get_file_summary',
    ];
  }
}

// ─── ScanProduction — 扫描知识生产能力 ─────────

/**
 * 扫描知识生产能力: 将分析结果转化为标准 Recipe
 *
 * 与冷启动 KnowledgeProduction 的区别:
 *   - 使用 collect_scan_recipe 工具（内存收集，不入库）
 *   - 冷启动用 submit_knowledge（直接入库）
 *   - 字段 schema 完全一致 — 产出质量相同
 *
 * 用于: scanKnowledge produce 阶段
 */
export class ScanProduction extends Capability {
  get name() {
    return 'scan_production';
  }

  get promptFragment() {
    return `## 知识生产能力
你是知识管理专家，将代码分析转化为结构化知识候选。

每个候选必须有:
1. 清晰的标题 (使用项目真实类名/模块名，不以项目名开头)
2. 项目特写风格的正文 (content.markdown ≥200字)
3. 设计原理说明 (content.rationale)
4. 相关文件路径 (reasoning.sources)
5. 正确的 kind (rule / pattern / fact)
6. 完整的 Cursor 交付字段 (trigger, doClause, whenClause 等)

工作流:
1. 识别分析中的知识点
2. read_project_file 获取代码片段 (如需)
3. collect_scan_recipe 逐个提交每个知识点
4. 每个独立模式/发现单独提交 — 不要合并`;
  }

  get tools() {
    return [
      'collect_scan_recipe', // 扫描专用 Recipe 收集
      'read_project_file', // 获取代码片段
    ];
  }
}

// ─── Evolution Analysis ─────────────────────────

/**
 * Evolution Analysis — 现有 Recipe 进化决策能力
 *
 * 用于: evolution preset 的 evolve 阶段
 */
export class EvolutionAnalysis extends Capability {
  get name() {
    return 'evolution_analysis';
  }

  get promptFragment() {
    return '你是知识进化专家，负责验证现有 Recipe 真实性并通过提案推动知识演化。';
  }

  get tools() {
    return [
      'read_project_file',
      'search_project_code',
      'propose_evolution',
      'confirm_deprecation',
      'skip_evolution',
    ];
  }
}

// ─── Capability 注册表 ─────────────────────────

/**
 * 所有内置 Capability 的注册表
 *
 * 用于按名称查找和实例化:
 *   const cap = CapabilityRegistry.create('conversation', { memoryCoordinator });
 */
export const CapabilityRegistry = {
  _registry: new Map<string, typeof Capability>([
    ['conversation', Conversation],
    ['code_analysis', CodeAnalysis],
    ['knowledge_production', KnowledgeProduction],
    ['scan_production', ScanProduction],
    ['system_interaction', SystemInteraction],
    ['evolution_analysis', EvolutionAnalysis],
  ]),

  /** 按名称创建 Capability 实例 */
  create(name: string, opts: Record<string, unknown> = {}) {
    const Cls = this._registry.get(name);
    if (!Cls) {
      throw new Error(`Unknown capability: ${name}`);
    }
    return new (Cls as new (opts: Record<string, unknown>) => Capability)(opts);
  },

  /** 注册自定义 Capability */
  register(name: string, cls: typeof Capability) {
    this._registry.set(name, cls);
  },

  /** 所有注册名 */
  get names() {
    return [...this._registry.keys()];
  },
};

export default {
  Capability,
  Conversation,
  CodeAnalysis,
  KnowledgeProduction,
  SystemInteraction,
  EvolutionAnalysis,
  CapabilityRegistry,
};
