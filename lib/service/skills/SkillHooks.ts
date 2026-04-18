/**
 * SkillHooks — Skill 生命周期钩子管理器 (v2)
 *
 * 每个 Skill 目录可以包含一个 hooks.js 文件，导出生命周期回调。
 * SkillHooks 在启动时扫描并注册所有钩子，在特定事件发生时按模式调用。
 *
 * v2 升级:
 *   - 扩展到 16+ 钩子，覆盖知识/Guard/Skill/搜索/推荐/Bootstrap/信号全生命周期
 *   - 4 种执行模式: series / parallel / waterfall / bail
 *   - Handler 支持 priority、timeout、name 元数据
 *   - 完全向后兼容旧版 hooks.js (直接导出函数)
 *   - 新格式支持: export default { hooks: { onXxx: { handler, priority, timeout } } }
 *
 * 加载顺序: 内置 skills/ → 项目级 Alembic/skills/（同名覆盖）
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataRoot } from '#shared/resolveProjectRoot.js';
import { getProjectSkillsPath } from '../../infrastructure/config/Paths.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { SKILLS_DIR } from '../../shared/package-root.js';
import type { HookDefinition, HookHandlerOptions, HookMode, RegisteredHandler } from './types.js';

// ═══════════════════════════════════════════════════════
//  Hook Registry — 声明所有支持的钩子及其执行模式
// ═══════════════════════════════════════════════════════

const HOOK_REGISTRY: HookDefinition[] = [
  // ── 知识生命周期 ──
  { name: 'onKnowledgeSubmit', mode: 'bail', description: '知识提交前拦截' },
  { name: 'onKnowledgeCreated', mode: 'parallel', description: '知识创建后通知' },
  { name: 'onKnowledgeUpdated', mode: 'parallel', description: '知识更新后通知' },
  { name: 'onKnowledgeExpired', mode: 'parallel', description: '知识过期/废弃后通知' },

  // ── Guard ──
  { name: 'onGuardCheck', mode: 'waterfall', description: 'Guard 检查，可修改违规结果' },
  { name: 'onGuardViolation', mode: 'parallel', description: 'Guard 违规后通知' },

  // ── Skill 生命周期 ──
  { name: 'onSkillLoad', mode: 'series', description: 'Skill 被加载时' },
  { name: 'onSkillCreated', mode: 'parallel', description: 'Skill 创建后' },
  { name: 'onSkillExpired', mode: 'parallel', description: 'Skill 过期/删除后' },

  // ── 搜索 ──
  { name: 'onSearch', mode: 'waterfall', description: '搜索结果后处理（可修改排序）' },
  { name: 'onSearchMiss', mode: 'parallel', description: '搜索无结果时' },

  // ── 推荐 ──
  { name: 'onRecommendation', mode: 'waterfall', description: '推荐结果后处理（可过滤/排序）' },
  { name: 'onRecommendFeedback', mode: 'parallel', description: '推荐反馈事件' },

  // ── Bootstrap ──
  { name: 'onBootstrapStart', mode: 'series', description: '冷启动开始前' },
  { name: 'onBootstrapComplete', mode: 'parallel', description: '冷启动完成后' },

  // ── 信号 ──
  { name: 'onSignalCollected', mode: 'parallel', description: '新信号收集完成' },

  // ── 向后兼容 (旧名映射) ──
  { name: 'onCandidateSubmit', mode: 'bail', description: '(compat) 同 onKnowledgeSubmit' },
  { name: 'onRecipeCreated', mode: 'parallel', description: '(compat) Recipe 创建后通知' },
];

/** hookName → HookDefinition 快速查表 */
const HOOK_DEF_MAP = new Map<string, HookDefinition>(HOOK_REGISTRY.map((d) => [d.name, d]));

/** 所有合法 hook 名称集合 */
const HOOK_NAMES = new Set(HOOK_REGISTRY.map((d) => d.name));

/** 默认 handler 超时 (ms) */
const DEFAULT_HANDLER_TIMEOUT = 10_000;
/** 默认 handler 优先级 */
const DEFAULT_HANDLER_PRIORITY = 100;

/**
 * 获取项目级 Skills 目录（运行时动态解析）
 * 路径: {projectRoot}/Alembic/skills/
 */
function _getProjectSkillsDir(container?: { singletons?: { _projectRoot?: unknown } }) {
  const dataRoot = resolveDataRoot(container);
  return getProjectSkillsPath(dataRoot);
}

/** 带超时的 Promise 包装 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Hook handler "${label}" timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// ═══════════════════════════════════════════════════════
//  SkillHooks 主类
// ═══════════════════════════════════════════════════════

export class SkillHooks {
  hooks: Map<string, RegisteredHandler[]>;
  logger: ReturnType<typeof Logger.getInstance>;

  constructor() {
    this.logger = Logger.getInstance();
    this.hooks = new Map<string, RegisteredHandler[]>([...HOOK_NAMES].map((n) => [n, []]));
  }

  // ─── 公共 API ──────────────────────────────────────────

  /**
   * 扫描 skills 目录，加载所有 hooks.js
   * 项目级 hooks 覆盖同名内置 hooks
   */
  async load(container?: { singletons?: { _projectRoot?: unknown } }) {
    const loaded = new Map<string, Record<string, unknown>>();

    // 1. 内置 skills
    await this.#loadFromDir(SKILLS_DIR, loaded);

    // 2. 项目级 skills（覆盖同名）
    await this.#loadFromDir(_getProjectSkillsDir(container), loaded);

    // 3. 注册所有钩子
    for (const [skillName, mod] of loaded) {
      this.#registerModule(skillName, mod);
    }

    // 4. 按优先级排序所有 hook 列表
    for (const handlers of this.hooks.values()) {
      handlers.sort((a, b) => a.priority - b.priority);
    }

    const totalHooks = [...this.hooks.values()].reduce((s, a) => s + a.length, 0);
    if (totalHooks > 0) {
      this.logger.info(`SkillHooks: loaded ${totalHooks} hooks from ${loaded.size} skills`);
    }
  }

  /** 手动注册 handler (用于代码级注册，非 hooks.js) */
  tap(
    hookName: string,
    handler: (...args: unknown[]) => Promise<unknown> | unknown,
    options?: Partial<HookHandlerOptions>
  ) {
    if (!HOOK_NAMES.has(hookName)) {
      this.logger.warn(`SkillHooks.tap: unknown hook "${hookName}", registering dynamically`);
      this.hooks.set(hookName, []);
    }

    const registered: RegisteredHandler = {
      fn: handler,
      name: options?.name ?? 'anonymous',
      priority: options?.priority ?? DEFAULT_HANDLER_PRIORITY,
      timeout: options?.timeout ?? DEFAULT_HANDLER_TIMEOUT,
    };

    const handlers = this.hooks.get(hookName)!;
    handlers.push(registered);
    // 保持优先级排序
    handlers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 触发钩子 — 根据 hook 定义的模式自动选择执行策略
   *
   * 向后兼容: 旧版 run() 签名不变，行为维持一致。
   * - bail 模式: 首个返回 { block: true } 的 handler 立即终止
   * - waterfall 模式: 前一个 handler 的返回值传给下一个
   * - parallel 模式: 所有 handler 并行执行 (fire-and-forget)
   * - series 模式: 按优先级顺序串行执行，忽略返回值
   */
  async run(hookName: string, ...args: unknown[]): Promise<unknown> {
    const handlers = this.hooks.get(hookName);
    if (!handlers || handlers.length === 0) {
      return undefined;
    }

    const def = HOOK_DEF_MAP.get(hookName);
    const mode: HookMode = def?.mode ?? 'bail'; // 未知 hook 默认 bail (兼容旧行为)

    switch (mode) {
      case 'bail':
        return this.#runBail(hookName, handlers, args);
      case 'waterfall':
        return this.#runWaterfall(hookName, handlers, args);
      case 'parallel':
        return this.#runParallel(hookName, handlers, args);
      case 'series':
        return this.#runSeries(hookName, handlers, args);
      default:
        return this.#runBail(hookName, handlers, args);
    }
  }

  /** 检查是否有任何钩子注册 */
  has(hookName: string): boolean {
    const handlers = this.hooks.get(hookName);
    return handlers !== undefined && handlers.length > 0;
  }

  /** 获取指定 hook 的 handler 数量 */
  count(hookName: string): number {
    return this.hooks.get(hookName)?.length ?? 0;
  }

  /** 获取已注册的所有 hook 名称 */
  getRegisteredHooks(): string[] {
    return [...this.hooks.entries()]
      .filter(([, handlers]) => handlers.length > 0)
      .map(([name]) => name);
  }

  /** 获取 Hook Registry 信息 (用于 Dashboard / 调试) */
  static getHookRegistry(): ReadonlyArray<HookDefinition> {
    return HOOK_REGISTRY;
  }

  // ─── 执行模式实现 ─────────────────────────────────────

  /** Bail 模式: 串行执行，首个返回 truthy/{block:true} 的 handler 终止链 */
  async #runBail(
    hookName: string,
    handlers: RegisteredHandler[],
    args: unknown[]
  ): Promise<unknown> {
    let result: unknown;
    for (const h of handlers) {
      try {
        const promise = Promise.resolve(h.fn(...args));
        result = await withTimeout(promise, h.timeout, h.name);

        // block 短路
        if (
          result &&
          typeof result === 'object' &&
          'block' in result &&
          (result as Record<string, unknown>).block
        ) {
          return result;
        }
      } catch (err: unknown) {
        this.logger.warn(`SkillHook error in ${hookName} (handler: ${h.name})`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }

  /** Waterfall 模式: 串行传值，前一个返回值替换 args[0] */
  async #runWaterfall(
    hookName: string,
    handlers: RegisteredHandler[],
    args: unknown[]
  ): Promise<unknown> {
    let current = args[0];
    const rest = args.slice(1);

    for (const h of handlers) {
      try {
        const promise = Promise.resolve(h.fn(current, ...rest));
        const result = await withTimeout(promise, h.timeout, h.name);
        // 只有返回了有效值才替换
        if (result !== undefined && result !== null) {
          current = result;
        }
      } catch (err: unknown) {
        this.logger.warn(`SkillHook waterfall error in ${hookName} (handler: ${h.name})`, {
          error: err instanceof Error ? err.message : String(err),
        });
        // waterfall 模式下出错继续传递当前值
      }
    }
    return current;
  }

  /** Parallel 模式: 所有 handler 并行执行 (fire-and-forget) */
  async #runParallel(
    hookName: string,
    handlers: RegisteredHandler[],
    args: unknown[]
  ): Promise<unknown> {
    const results = await Promise.allSettled(
      handlers.map((h) => {
        const promise = Promise.resolve(h.fn(...args));
        return withTimeout(promise, h.timeout, h.name);
      })
    );

    // 记录失败但不阻塞
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        this.logger.warn(`SkillHook parallel error in ${hookName} (handler: ${handlers[i].name})`, {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }

    return undefined;
  }

  /** Series 模式: 按优先级顺序串行执行，忽略返回值 */
  async #runSeries(
    hookName: string,
    handlers: RegisteredHandler[],
    args: unknown[]
  ): Promise<unknown> {
    for (const h of handlers) {
      try {
        const promise = Promise.resolve(h.fn(...args));
        await withTimeout(promise, h.timeout, h.name);
      } catch (err: unknown) {
        this.logger.warn(`SkillHook series error in ${hookName} (handler: ${h.name})`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return undefined;
  }

  // ─── 模块注册 ─────────────────────────────────────────

  /**
   * 注册一个 skill 模块的钩子 — 支持新旧两种格式
   *
   * 旧格式 (v1):
   *   export function onGuardCheck(violation, ctx) { ... }
   *
   * 新格式 (v2):
   *   export default { hooks: { onGuardCheck: { handler, priority, timeout } } }
   */
  #registerModule(skillName: string, mod: Record<string, unknown>) {
    // 尝试新格式: mod.hooks 是一个对象
    const hooksObj = mod.hooks as Record<string, unknown> | undefined;
    if (hooksObj && typeof hooksObj === 'object') {
      for (const [hookName, config] of Object.entries(hooksObj)) {
        if (!this.hooks.has(hookName)) {
          this.logger.warn(`SkillHooks: ${skillName} exports unknown hook "${hookName}", skipping`);
          continue;
        }
        if (typeof config === 'function') {
          // 新格式但直接是函数: { hooks: { onXxx: fn } }
          this.#addHandler(hookName, config as (...args: unknown[]) => unknown, skillName);
        } else if (config && typeof config === 'object' && 'handler' in config) {
          // 新格式含元数据: { hooks: { onXxx: { handler, priority, timeout } } }
          const cfg = config as {
            handler: (...args: unknown[]) => unknown;
            priority?: number;
            timeout?: number;
          };
          this.#addHandler(hookName, cfg.handler, skillName, cfg.priority, cfg.timeout);
        }
      }
      return;
    }

    // 旧格式: module 顶层直接导出函数
    for (const hookName of HOOK_NAMES) {
      if (typeof mod[hookName] === 'function') {
        this.#addHandler(hookName, mod[hookName] as (...args: unknown[]) => unknown, skillName);
      }
    }
  }

  #addHandler(
    hookName: string,
    fn: (...args: unknown[]) => unknown,
    skillName: string,
    priority?: number,
    timeout?: number
  ) {
    const handler: RegisteredHandler = {
      fn,
      name: `${skillName}.${hookName}`,
      priority: priority ?? DEFAULT_HANDLER_PRIORITY,
      timeout: timeout ?? DEFAULT_HANDLER_TIMEOUT,
    };
    this.hooks.get(hookName)!.push(handler);
    this.logger.debug(`SkillHook registered: ${handler.name} (priority=${handler.priority})`);
  }

  // ─── 目录扫描 ─────────────────────────────────────────

  async #loadFromDir(dir: string, loaded: Map<string, Record<string, unknown>>) {
    let dirs: string[];
    try {
      dirs = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return; // 目录不存在
    }

    for (const name of dirs) {
      const hooksPath = path.join(dir, name, 'hooks.js');
      if (!fs.existsSync(hooksPath)) {
        continue;
      }
      try {
        const mod = await import(hooksPath);
        loaded.set(name, mod.default || mod);
      } catch (err: unknown) {
        this.logger.warn(`SkillHooks: failed to load ${name}/hooks.js`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export default SkillHooks;
