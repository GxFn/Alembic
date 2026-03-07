/**
 * Policies — Agent 执行约束 (横切关注点)
 *
 * Policy 不改变 Agent 做什么，而是约束 Agent 如何做。
 * 多个 Policy 可叠加，形成复合约束。
 *
 * 三类 Policy:
 *   1. BudgetPolicy  — 资源预算 (迭代次数 / Token / 时间)
 *   2. SafetyPolicy  — 安全沙箱 (命令黑名单 / 文件范围 / 发送者鉴权)
 *   3. QualityGatePolicy — 质量门控 (证据数量 / 分析深度)
 *
 * 这就是为什么"飞书远程执行"不需要独立 Agent:
 *   它只是 Conversation + SystemInteraction + SafetyPolicy 的组合。
 *   SafetyPolicy 提供命令沙箱，而不是由 LarkBridgeAgent 硬编码。
 *
 * @module policies
 */

import _path from 'node:path';

// ─── Policy Type Definitions ─────────────────

/** 执行前校验的上下文 */
export interface PolicyContext {
  message?: {
    sender?: {
      id?: string;
    };
  };
  [key: string]: unknown;
}

/** 执行步骤状态 */
export interface StepState {
  iteration: number;
  startTime: number;
  [key: string]: unknown;
}

/** Agent 执行结果 */
export interface PolicyResult {
  reply?: string;
  toolCalls?: unknown[];
  [key: string]: unknown;
}

/** SafetyPolicy 构造选项 */
export interface SafetyPolicyOptions {
  fileScope?: string;
  allowedSenders?: string[];
  commandBlacklist?: RegExp[];
  requireApprovalFor?: string[];
}

/** QualityGatePolicy 构造选项 */
export interface QualityGatePolicyOptions {
  minEvidenceLength?: number;
  minFileRefs?: number;
  minToolCalls?: number;
  customValidator?: (result: PolicyResult) => { ok: boolean; reason?: string };
}

// ─── Base Policy ──────────────────────────────

/**
 * Policy 基类 — 所有约束的抽象接口
 */
export class Policy {
  /** @type {string} 策略名称 */
  get name(): string {
    throw new Error('Subclass must implement name');
  }

  /** 执行前校验 — 拒绝不满足条件的请求 */
  validateBefore(_context: PolicyContext): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  /** 执行中校验 — 每轮 ReAct 步骤后检查 */
  validateDuring(_stepState: StepState): { ok: boolean; action?: string; reason?: string } {
    return { ok: true, action: 'continue' };
  }

  /** 执行后校验 — 对最终结果质量把关 */
  validateAfter(_result: PolicyResult): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  /** 修改配置 — 在执行前注入额外约束 */
  applyToConfig(config: Record<string, unknown>): Record<string, unknown> {
    return config;
  }
}

// ─── BudgetPolicy — 资源预算 ─────────────────

/**
 * 控制 Agent 的资源消耗上限。
 *
 * 适用于所有场景，不同 Preset 配置不同预算:
 *   - 聊天: { maxIterations: 8, timeoutMs: 120_000 }
 *   - 深度分析: { maxIterations: 24, timeoutMs: 300_000 }
 *   - 冷启动: { maxIterations: 24, timeoutMs: 600_000 }
 *   - 远程执行: { maxIterations: 6, timeoutMs: 60_000 }
 */
export class BudgetPolicy extends Policy {
  #maxIterations;
  #maxTokens;
  #timeoutMs;
  #temperature;

  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxIterations=20]
   * @param {number} [opts.maxTokens=4096]
   * @param {number} [opts.timeoutMs=300000]
   * @param {number} [opts.temperature=0.7]
   */
  constructor({
    maxIterations = 20,
    maxTokens = 4096,
    timeoutMs = 300_000,
    temperature = 0.7,
  } = {}) {
    super();
    this.#maxIterations = maxIterations;
    this.#maxTokens = maxTokens;
    this.#timeoutMs = timeoutMs;
    this.#temperature = temperature;
  }

  get name() {
    return 'budget';
  }

  get maxIterations() {
    return this.#maxIterations;
  }
  get maxTokens() {
    return this.#maxTokens;
  }
  get timeoutMs() {
    return this.#timeoutMs;
  }
  get temperature() {
    return this.#temperature;
  }

  validateDuring(stepState: StepState) {
    if (stepState.iteration >= this.#maxIterations) {
      return {
        ok: false,
        action: 'stop',
        reason: `Budget: max iterations (${this.#maxIterations}) reached`,
      };
    }
    if (Date.now() - stepState.startTime > this.#timeoutMs) {
      return {
        ok: false,
        action: 'stop',
        reason: `Budget: timeout (${this.#timeoutMs}ms) exceeded`,
      };
    }
    return { ok: true, action: 'continue' };
  }

  applyToConfig(config: Record<string, unknown>) {
    return {
      ...config,
      budget: {
        maxIterations: this.#maxIterations,
        maxTokens: this.#maxTokens,
        timeoutMs: this.#timeoutMs,
        temperature: this.#temperature,
      },
    };
  }
}

// ─── SafetyPolicy — 安全沙箱 ────────────────

/**
 * 安全约束: 命令过滤、文件范围限制、发送者鉴权。
 *
 * 这取代了旧 LarkBridgeAgent 中硬编码的安全逻辑:
 *   - SafetyPolicy 是可组合的、可配置的、可复用的
 *   - 任何需要安全约束的场景都可以叠加这个 Policy
 *   - 不局限于飞书场景 — CLI 远程执行同样适用
 */
export class SafetyPolicy extends Policy {
  /** 危险命令正则黑名单 */
  static DANGEROUS_COMMANDS = Object.freeze([
    /\brm\s+-rf\s+[/~]/,
    /\bsudo\b/,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /\b(shutdown|reboot|halt)\b/,
    />\s*\/dev\//,
    /\bcurl\b.*\|\s*(bash|sh)/,
    /\bchmod\s+777/,
    /\bpasswd\b/,
    /\bkillall\b/,
  ]);

  /** 安全命令前缀白名单 */
  static SAFE_COMMANDS = Object.freeze([
    'ls',
    'cat',
    'head',
    'tail',
    'grep',
    'find',
    'wc',
    'echo',
    'pwd',
    'date',
    'which',
    'file',
    'stat',
    'git log',
    'git status',
    'git diff',
    'git branch',
    'npm list',
    'npm outdated',
    'node -v',
    'npm -v',
  ]);

  #fileScope;
  #allowedSenders;
  #commandBlacklist;
  #requireApprovalFor;

  /**
   * @param {Object} [opts]
   * @param {string} [opts.fileScope] 文件操作范围 (目录路径)
   * @param {string[]} [opts.allowedSenders] 允许的发送者 ID (空=不限制)
   * @param {RegExp[]} [opts.commandBlacklist] 额外命令黑名单
   * @param {string[]} [opts.requireApprovalFor] 需要人工确认的工具名
   */
  constructor({
    fileScope,
    allowedSenders = [],
    commandBlacklist = [],
    requireApprovalFor = [],
  }: SafetyPolicyOptions = {}) {
    super();
    this.#fileScope = fileScope || null;
    this.#allowedSenders = allowedSenders;
    this.#commandBlacklist = [...SafetyPolicy.DANGEROUS_COMMANDS, ...commandBlacklist];
    this.#requireApprovalFor = requireApprovalFor;
  }

  get name() {
    return 'safety';
  }

  validateBefore(context: PolicyContext) {
    // 发送者鉴权
    if (this.#allowedSenders.length > 0) {
      const senderId = context.message?.sender?.id;
      if (!senderId || !this.#allowedSenders.includes(senderId)) {
        return { ok: false, reason: `Safety: sender "${senderId}" not in allowlist` };
      }
    }
    return { ok: true };
  }

  /**
   * 检查命令是否安全
   * @param {string} command
   * @returns {{ safe: boolean, reason?: string }}
   */
  checkCommand(command: string) {
    for (const pattern of this.#commandBlacklist) {
      if (pattern.test(command)) {
        return { safe: false, reason: `Blocked: matches dangerous pattern ${pattern}` };
      }
    }
    return { safe: true };
  }

  /**
   * 检查文件路径是否在允许范围内
   * @param {string} filePath
   * @returns {{ safe: boolean, reason?: string }}
   */
  checkFilePath(filePath: string) {
    if (!this.#fileScope) {
      return { safe: true };
    }
    const resolved = _path.resolve(filePath);
    const scope = _path.resolve(this.#fileScope);
    if (!resolved.startsWith(scope)) {
      return {
        safe: false,
        reason: `File path "${filePath}" outside allowed scope "${this.#fileScope}"`,
      };
    }
    return { safe: true };
  }

  /**
   * 是否需要人工确认
   * @param {string} toolName
   */
  needsApproval(toolName: string) {
    return this.#requireApprovalFor.includes(toolName);
  }

  applyToConfig(config: Record<string, unknown>): Record<string, unknown> {
    return {
      ...config,
      safetyPolicy: this,
    };
  }
}

// ─── QualityGatePolicy — 质量门控 ────────────

/**
 * 评估 Agent 输出质量，决定是否接受结果。
 *
 * 用于 Pipeline 的 gate 阶段，也可用于最终结果校验。
 * 取代了旧 BootstrapOrchestrator 中硬编码的 qualityCheck。
 */
export class QualityGatePolicy extends Policy {
  #minEvidenceLength;
  #minFileRefs;
  #minToolCalls;
  #customValidator;

  /**
   * @param {Object} [opts]
   * @param {number} [opts.minEvidenceLength=500] 分析文本最小长度
   * @param {number} [opts.minFileRefs=3] 最少文件引用数
   * @param {number} [opts.minToolCalls=2] 最少工具调用数
   * @param {Function} [opts.customValidator] 自定义校验 (result) => { ok, reason }
   */
  constructor({
    minEvidenceLength = 500,
    minFileRefs = 3,
    minToolCalls = 2,
    customValidator,
  }: QualityGatePolicyOptions = {}) {
    super();
    this.#minEvidenceLength = minEvidenceLength;
    this.#minFileRefs = minFileRefs;
    this.#minToolCalls = minToolCalls;
    this.#customValidator = customValidator || null;
  }

  get name() {
    return 'quality_gate';
  }

  validateAfter(result: PolicyResult) {
    const reasons: string[] = [];

    if (result.reply && result.reply.length < this.#minEvidenceLength) {
      reasons.push(`分析长度不足: ${result.reply.length} < ${this.#minEvidenceLength}`);
    }

    if (result.reply) {
      const fileRefCount = (result.reply.match(/[\w/-]+\.\w{1,6}/g) || []).length;
      if (fileRefCount < this.#minFileRefs) {
        reasons.push(`文件引用不足: ${fileRefCount} < ${this.#minFileRefs}`);
      }
    }

    if ((result.toolCalls?.length || 0) < this.#minToolCalls) {
      reasons.push(`工具调用不足: ${result.toolCalls?.length || 0} < ${this.#minToolCalls}`);
    }

    if (this.#customValidator) {
      const custom = this.#customValidator(result);
      if (!custom.ok && custom.reason) {
        reasons.push(custom.reason);
      }
    }

    return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('; ') };
  }

  /** 导出为 PipelineStrategy gate 配置格式 */
  toGateConfig() {
    return {
      minEvidenceLength: this.#minEvidenceLength,
      minFileRefs: this.#minFileRefs,
      minToolCalls: this.#minToolCalls,
      custom: this.#customValidator,
    };
  }
}

// ─── PolicyEngine — 策略引擎 ─────────────────

/**
 * 组合多个 Policy 并统一执行校验。
 *
 * @example
 * const engine = new PolicyEngine([
 *   new BudgetPolicy({ maxIterations: 8 }),
 *   new SafetyPolicy({ fileScope: '/project' }),
 * ]);
 * engine.validateBefore(context); // 所有 policy 依次检查
 */
export class PolicyEngine {
  /** @type {Policy[]} */
  #policies;

  constructor(policies: Policy[] = []) {
    this.#policies = policies;
  }

  get policies() {
    return [...this.#policies];
  }

  /**
   * 获取特定类型的 Policy
   * @template T
   * @param {new (...args: unknown[]) => T} PolicyClass
   * @returns {T|null}
   */
  get<T extends Policy>(PolicyClass: abstract new (...args: never[]) => T): T | null {
    return this.#policies.find((p): p is T => p instanceof PolicyClass) ?? null;
  }

  validateBefore(context: PolicyContext) {
    for (const policy of this.#policies) {
      const result = policy.validateBefore(context);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  }

  validateDuring(stepState: StepState) {
    for (const policy of this.#policies) {
      const result = policy.validateDuring(stepState);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true, action: 'continue' };
  }

  validateAfter(result: PolicyResult) {
    for (const policy of this.#policies) {
      const val = policy.validateAfter(result);
      if (!val.ok) {
        return val;
      }
    }
    return { ok: true };
  }

  applyToConfig(config: Record<string, unknown>) {
    let result = config;
    for (const policy of this.#policies) {
      result = policy.applyToConfig(result);
    }
    return result;
  }

  /**
   * 获取合并后的 Budget (从 BudgetPolicy)
   */
  getBudget() {
    const bp = this.get(BudgetPolicy);
    return bp
      ? {
          maxIterations: bp.maxIterations,
          maxTokens: bp.maxTokens,
          timeoutMs: bp.timeoutMs,
          temperature: bp.temperature,
        }
      : null;
  }

  /**
   * 工具执行前的安全校验 — 在 reactLoop 中每次工具调用前自动触发
   *
   * 对有副作用的工具 (run_safe_command, write_project_file) 执行安全检查。
   * 委托给 SafetyPolicy，如果没有加载 SafetyPolicy 则放行。
   *
   * @param {string} toolName 工具名称
   * @param {Object} args 工具参数
   * @returns {{ ok: boolean, reason?: string }}
   */
  validateToolCall(toolName: string, args: Record<string, unknown>) {
    const safety = this.get(SafetyPolicy);
    if (!safety) {
      return { ok: true };
    }

    // 终端命令安全检查
    if (toolName === 'run_safe_command' && args?.command) {
      const check = safety.checkCommand(args.command as string);
      if (!check.safe) {
        return { ok: false, reason: `[SafetyPolicy] 命令拦截: ${check.reason}` };
      }
    }

    // 文件写入路径检查
    if (toolName === 'write_project_file' && args?.filePath) {
      const check = safety.checkFilePath(args.filePath as string);
      if (!check.safe) {
        return { ok: false, reason: `[SafetyPolicy] 路径拦截: ${check.reason}` };
      }
    }

    // 文件读取路径检查
    if (toolName === 'read_project_file' && args?.filePath) {
      const check = safety.checkFilePath(args.filePath as string);
      if (!check.safe) {
        return { ok: false, reason: `[SafetyPolicy] 路径拦截: ${check.reason}` };
      }
    }

    // 需要人工确认的工具
    if (safety.needsApproval(toolName)) {
      return { ok: false, reason: `[SafetyPolicy] 工具 "${toolName}" 需要人工确认` };
    }

    return { ok: true };
  }
}

export default { Policy, BudgetPolicy, SafetyPolicy, QualityGatePolicy, PolicyEngine };
