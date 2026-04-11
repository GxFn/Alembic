/**
 * SignalCollector — AI 驱动的后台行为分析与 Skill 推荐引擎
 *
 * 在 `asd ui` 运行时作为后台守护进程运行，周期性收集多维度信号并
 * 通过 AgentFactory（统一 Agent 系统）进行深度分析，生成 Skill 推荐。
 *
 * 三种工作模式：
 *   - off      — 不收集，不推荐
 *   - suggest  — 收集信号 → AI 分析 → 推送推荐（默认）
 *   - auto     — 收集信号 → AI 分析 → 推送推荐 + AI 自动创建 Skill
 *
 * 核心架构：
 *   每次 tick → 收集 6 维度信号 → 构造分析 prompt → AgentFactory.createChat()
 *   → Agent 执行（可调用 suggest_skills / create_skill 等工具）
 *   → 解析 AI 响应（suggestions + nextIntervalMinutes + summary）
 *   → 推送建议 → 动态调整下次执行间隔
 *
 * 6 大信号维度：
 *   1. Guard 冲突信号 — 当前错误/冲突检测
 *   2. 对话记忆信号 — 用户近期对话主题
 *   3. Recipe 健康信号 — 模板使用情况与质量
 *   4. Candidate 堆积信号 — 待处理候选 Skill 分析
 *   5. 操作日志信号 — 近期用户操作模式
 *   6. 代码变更信号 — 项目 git diff 分析
 *
 * 设计原则：
 *   1. 静默 — 不打断用户，后台运行，所有错误降级
 *   2. 增量 — 只分析上次快照以来的新数据
 *   3. 去重 — 同一推荐仅推送一次
 *   4. AI 驱动 — 所有分析决策由 AgentRuntime 完成
 *   5. 自适应 — AI 根据信号密度动态调整执行频率
 *
 * 前提条件：
 *   需要可用的 AI Provider
 *
 * 生命周期：
 *   new SignalCollector(opts) → instance.start() → ... → instance.stop()
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Logger from '../../infrastructure/logging/Logger.js';
import type { AuditRepositoryImpl } from '../../repository/audit/AuditRepository.js';
import type { KnowledgeRepositoryImpl } from '../../repository/knowledge/KnowledgeRepository.impl.js';
import pathGuard from '../../shared/PathGuard.js';
import { EventAggregator } from './EventAggregator.js';
import { SkillAdvisor } from './SkillAdvisor.js';

interface SignalCollectorOpts {
  projectRoot: string;
  knowledgeRepo?: KnowledgeRepositoryImpl | null;
  auditRepo?: AuditRepositoryImpl | null;
  agentFactory?: AgentFactoryLike | null;
  container?: ContainerLike | null;
  signalBus?: import('../../infrastructure/signal/SignalBus.js').SignalBus | null;
  mode?: string;
  intervalMs?: number;
  onSuggestions?: ((suggestions: Record<string, unknown>[]) => void) | null;
}

interface AgentResult {
  reply?: string;
  text?: string;
  toolCalls?: Array<{ tool: string; params?: Record<string, unknown> }>;
  [key: string]: unknown;
}

interface AgentFactoryLike {
  createChat(opts: Record<string, unknown>): { execute(msg: unknown): Promise<AgentResult> };
}

interface ContainerService {
  name?: string;
  extractJSON?: (text: string, open: string, close: string) => Record<string, unknown> | null;
  [key: string]: unknown;
}

interface ContainerLike {
  get(name: string): ContainerService | null;
  singletons?: Record<string, unknown>;
}

interface SignalSnapshot {
  lastRun: string | null;
  totalRuns: number;
  pushedNames: string[];
  lastResult: Record<string, unknown> | null;
  lastAiSummary: string;
  autoCreated: Array<{ name: string; createdAt: string }>;
  pendingSuggestions: Record<string, unknown>[];
}

interface CollectedSignals {
  guard: Record<string, unknown>[];
  memory: Record<string, unknown>[];
  recipes: Record<string, unknown>[];
  candidates: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  codeChanges: string[];
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 小时（初始值，AI 可动态调整）
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 最短 5 分钟
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // 最长 24 小时
const SNAPSHOT_FILE = 'signal-snapshot.json';

export class SignalCollector {
  #projectRoot: string;
  #knowledgeRepo: KnowledgeRepositoryImpl | null;
  #auditRepo: AuditRepositoryImpl | null;
  #agentFactory: AgentFactoryLike | null;
  #container: ContainerLike | null;
  #mode: string;
  #intervalMs;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #logger;
  #snapshotPath;
  #snapshot: SignalSnapshot;
  #onSuggestions: ((suggestions: Record<string, unknown>[]) => void) | null;
  /** 信号聚类引擎 */
  #aggregator;
  /** 各维度最新信号快照（由 SignalBus 实时更新） */
  #dimensionSignals: Record<string, unknown> = {};

  /**
   * @param opts.projectRoot 用户项目根目录
   * @param [opts.database] better-sqlite3 实例
   * @param [opts.agentFactory] AgentFactory 实例
   * @param [opts.container] ServiceContainer 实例
   * @param [opts.signalBus] SignalBus 实例（实时信号订阅）
   * @param [opts.mode] 'off' | 'suggest' | 'auto'
   * @param [opts.intervalMs] 初始收集间隔（毫秒），后续由 AI 动态调整
   * @param [opts.onSuggestions] 新建议回调 (suggestions[]) => void
   */
  constructor({
    projectRoot,
    knowledgeRepo = null,
    auditRepo = null,
    agentFactory = null,
    container = null,
    signalBus = null,
    mode = 'auto',
    intervalMs = DEFAULT_INTERVAL_MS,
    onSuggestions = null as ((suggestions: Record<string, unknown>[]) => void) | null,
  }: SignalCollectorOpts) {
    this.#projectRoot = projectRoot;
    this.#knowledgeRepo = knowledgeRepo;
    this.#auditRepo = auditRepo;
    this.#agentFactory = agentFactory;
    this.#container = container;
    this.#mode = ['off', 'suggest', 'auto'].includes(mode) ? mode : 'auto';
    this.#intervalMs = Math.max(Math.min(intervalMs, MAX_INTERVAL_MS), MIN_INTERVAL_MS);
    this.#logger = Logger.getInstance();
    this.#onSuggestions = onSuggestions;

    const dotDir = path.join(projectRoot, '.autosnippet');
    this.#snapshotPath = path.join(dotDir, SNAPSHOT_FILE);
    this.#snapshot = this.#loadSnapshot();

    // 信号聚类引擎: 外部推送的事件（file_change, guard_violation 等）
    // 在时间窗口内聚合，避免高频操作重复触发 AI 分析
    this.#aggregator = new EventAggregator({ windowMs: 10_000, dedupeMs: 120_000 });
    this.#aggregator.on('batch', (key: string, events: Record<string, unknown>[]) => {
      this.#logger.info(`[SignalCollector] aggregated batch: ${key} × ${events.length}`);
      // 有聚合事件时提前触发 tick（取消当前定时器，立即执行）
      if (this.#timer && !this.#running) {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.#tick(), 3000); // 3 秒后执行，留出更多聚合时间
      }
    });

    // Phase 2: 订阅 SignalBus 全量信号，维护维度快照
    if (signalBus) {
      signalBus.subscribe('*', (signal) => {
        this.#updateDimension(signal);
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  //  公共 API
  // ═══════════════════════════════════════════════════════

  start() {
    if (this.#mode === 'off') {
      this.#logger.info('[SignalCollector] mode=off, skipping start');
      return;
    }
    const manager = this.#container?.singletons?._aiProviderManager as
      | { isMock: boolean }
      | undefined;
    if (manager?.isMock) {
      this.#logger.info(
        '[SignalCollector] no AI provider available, starting in rule-fallback mode'
      );
    }
    if (this.#timer) {
      this.#logger.warn('[SignalCollector] already running, ignoring start()');
      return;
    }

    this.#logger.info(
      `[SignalCollector] started — mode=${this.#mode}, initialInterval=${this.#intervalMs}ms, AI-driven`
    );

    // 首次按正常间隔执行（不立即触发，避免启动时消耗 AI token）
    // 如果有事件推送（EventAggregator batch），会提前触发
    this.#timer = setTimeout(() => this.#tick(), this.#intervalMs);
  }

  stop() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#running = false;
    this.#aggregator.destroy();
    this.#logger.info('[SignalCollector] stopped');
  }

  /**
   * 外部事件推送入口（由 FileWatcher / Guard / CLI 等调用）
   *
   * 事件会经过 EventAggregator 聚合后触发提前分析。
   * @param key 事件类型（如 'file_change', 'guard_violation', 'candidate_submit'）
   * @param event 事件数据
   */
  pushEvent(key: string, event: Record<string, unknown>) {
    if (this.#mode === 'off') {
      return;
    }
    this.#aggregator.push(key, event);
  }

  async collect() {
    return this.#tick();
  }

  getSnapshot() {
    return { ...this.#snapshot };
  }

  /** 由 SignalBus 实时更新的维度信号快照 */
  #updateDimension(signal: import('../../infrastructure/signal/SignalBus.js').Signal): void {
    switch (signal.type) {
      case 'guard':
      case 'guard_blind_spot':
        this.#dimensionSignals.compliance = signal;
        break;
      case 'usage':
        this.#dimensionSignals.adoption = signal;
        break;
      case 'quality':
        this.#dimensionSignals.quality = signal;
        break;
      case 'decay':
        this.#dimensionSignals.decay = signal;
        break;
      case 'lifecycle':
        this.#dimensionSignals.evolution = signal;
        break;
    }
  }
  getMode() {
    return this.#mode;
  }

  /** 从 pendingSuggestions 中移除已创建的 Skill */
  removePendingSuggestion(name: string) {
    if (!this.#snapshot.pendingSuggestions?.length) {
      return;
    }
    this.#snapshot.pendingSuggestions = this.#snapshot.pendingSuggestions.filter(
      (s: Record<string, unknown>) => s.name !== name
    );
    if (this.#snapshot.lastResult) {
      this.#snapshot.lastResult.newSuggestions = this.#snapshot.pendingSuggestions.length;
    }
    this.#saveSnapshot();
  }

  setMode(mode: string) {
    if (!['off', 'suggest', 'auto'].includes(mode)) {
      return;
    }
    this.#mode = mode;
    this.#logger.info(`[SignalCollector] mode changed to ${mode}`);
    if (mode === 'off') {
      this.stop();
    }
  }

  // ═══════════════════════════════════════════════════════
  //  核心 AI 分析循环
  // ═══════════════════════════════════════════════════════

  async #tick() {
    if (this.#running) {
      return null;
    }
    this.#running = true;

    try {
      // 1. 多维度收集信号
      const signals: CollectedSignals = {
        guard: await this.#collectGuardSignals(),
        memory: this.#collectMemorySignals(),
        recipes: await this.#collectRecipeSignals(),
        candidates: await this.#collectCandidateSignals(),
        actions: await this.#collectRecentActions(),
        codeChanges: this.#collectCodeChangeSignals(),
      };

      // ── 离线 Fallback: 当 AI 不可用时，降级到 SkillAdvisor 规则引擎 ──
      const isMock =
        (this.#container?.singletons?._aiProviderManager as { isMock: boolean } | undefined)
          ?.isMock ?? true;
      if (!this.#agentFactory || isMock) {
        this.#logger.info('[SignalCollector] AI unavailable, falling back to rule-based analysis');
        return await this.#ruleFallback();
      }

      // 2. 构造分析 prompt
      const prompt = this.#buildAnalysisPrompt(signals);

      // 3. 调用 Agent 系统进行 AI 分析
      this.#logger.debug('[SignalCollector] invoking Agent for analysis...');
      const agent = this.#agentFactory?.createChat({ lang: 'en' });
      const { AgentMessage } = await import('#agent/AgentMessage.js');
      const message = AgentMessage.internal(prompt, { source: 'signal_collector' });
      const result = await agent.execute(message);
      const reply = result?.reply ?? result?.text ?? '';
      const toolCalls = result?.toolCalls ?? [];

      // 4. 解析 AI 响应 — 使用 AiProvider.extractJSON 统一 structured output 解析
      const parsed = this.#parseStructuredReply(reply as string);
      const suggestions = parsed.suggestions || [];

      // 5. 过滤已推送
      const newSuggestions = suggestions.filter(
        (s: Record<string, unknown>) => !this.#snapshot.pushedNames.includes(s.name as string)
      );

      // 6. 更新快照
      this.#snapshot.lastRun = new Date().toISOString();
      this.#snapshot.totalRuns = (this.#snapshot.totalRuns || 0) + 1;
      this.#snapshot.lastAiSummary = parsed.summary || '';
      this.#snapshot.lastResult = {
        totalSuggestions: suggestions.length,
        newSuggestions: newSuggestions.length,
        aiToolCalls: toolCalls?.length || 0,
      };
      // 持久化 AI 生成的建议，供前端直接读取
      if (newSuggestions.length > 0) {
        this.#snapshot.pendingSuggestions = newSuggestions.map((s: Record<string, unknown>) => ({
          name: (s.name as string) || '',
          description: (s.description as string) || (s.reason as string) || '',
          rationale: (s.rationale as string) || (s.reason as string) || '',
          body: (s.body as string) || '',
          source: (s.source as string) || 'signal-collector',
          priority: (s.priority as string) || 'medium',
        }));
      }

      if (newSuggestions.length > 0) {
        for (const s of newSuggestions) {
          if (!this.#snapshot.pushedNames.includes(s.name as string)) {
            this.#snapshot.pushedNames.push(s.name as string);
          }
        }

        // 推送建议
        if (this.#onSuggestions) {
          try {
            this.#onSuggestions(newSuggestions);
          } catch (err: unknown) {
            this.#logger.warn(
              `[SignalCollector] onSuggestions callback error: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        // 检测 AI 是否在 auto 模式下自主调用了 create_skill
        if (this.#mode === 'auto' && toolCalls?.length) {
          const created = toolCalls.filter(
            (tc: Record<string, unknown>) => tc.tool === 'create_skill'
          );
          if (created.length > 0) {
            if (!this.#snapshot.autoCreated) {
              this.#snapshot.autoCreated = [];
            }
            for (const tc of created) {
              this.#snapshot.autoCreated.push({
                name: ((tc.params as Record<string, unknown>)?.name as string) || 'unknown',
                createdAt: new Date().toISOString(),
              });
            }
            this.#logger.info(`[SignalCollector] AI auto-created ${created.length} skill(s)`);
          }
        }

        this.#logger.info(`[SignalCollector] tick done — ${newSuggestions.length} new suggestions`);
      } else {
        this.#logger.debug('[SignalCollector] tick done — no new suggestions');
      }

      // 7. AI 动态调节下次间隔
      if (parsed.nextIntervalMinutes && typeof parsed.nextIntervalMinutes === 'number') {
        const aiMs = parsed.nextIntervalMinutes * 60 * 1000;
        this.#intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(aiMs, MAX_INTERVAL_MS));
        this.#logger.info(
          `[SignalCollector] AI adjusted next interval to ${parsed.nextIntervalMinutes}min`
        );
      }

      // 8. 持久化快照
      this.#saveSnapshot();

      // 9. 调度下次执行
      this.#scheduleNext(this.#intervalMs);

      return { suggestions: newSuggestions, stats: this.#snapshot.lastResult };
    } catch (err: unknown) {
      this.#logger.warn(
        `[SignalCollector] tick error: ${err instanceof Error ? err.message : String(err)}`
      );
      // 出错后也要调度下次（间隔加倍退避）
      this.#scheduleNext(Math.min(this.#intervalMs * 2, MAX_INTERVAL_MS));
      return { suggestions: [], stats: null };
    } finally {
      this.#running = false;
    }
  }

  #scheduleNext(delayMs: number) {
    if (this.#mode === 'off') {
      return;
    }
    this.#timer = setTimeout(() => this.#tick(), delayMs);
  }

  // ═══════════════════════════════════════════════════════
  //  离线 Fallback — 无 AI 时降级到规则引擎
  // ═══════════════════════════════════════════════════════

  /**
   * 当 AI Provider 不可用时，使用 SkillAdvisor 规则引擎生成推荐
   *
   * 零延迟、零 token 消耗 — 确保推荐系统始终有输出
   */
  async #ruleFallback(): Promise<{
    suggestions: Record<string, unknown>[];
    stats: Record<string, unknown> | null;
  }> {
    try {
      const advisor = new SkillAdvisor(this.#projectRoot, {
        knowledgeRepo: this.#knowledgeRepo,
        auditRepo: this.#auditRepo,
      });
      const result = await advisor.suggest();

      const newSuggestions = result.suggestions.filter(
        (s: { name: string }) => !this.#snapshot.pushedNames.includes(s.name)
      );

      // 更新快照
      this.#snapshot.lastRun = new Date().toISOString();
      this.#snapshot.totalRuns = (this.#snapshot.totalRuns || 0) + 1;
      this.#snapshot.lastAiSummary = '[offline] Rule-based analysis (AI unavailable)';
      this.#snapshot.lastResult = {
        totalSuggestions: result.suggestions.length,
        newSuggestions: newSuggestions.length,
        aiToolCalls: 0,
        fallback: true,
      };

      if (newSuggestions.length > 0) {
        this.#snapshot.pendingSuggestions = newSuggestions.map((s) => ({
          name: s.name,
          description: s.description,
          rationale: s.rationale,
          body: '',
          source: `rule-fallback:${s.source}`,
          priority: s.priority,
        }));

        for (const s of newSuggestions) {
          if (!this.#snapshot.pushedNames.includes(s.name)) {
            this.#snapshot.pushedNames.push(s.name);
          }
        }

        if (this.#onSuggestions) {
          try {
            this.#onSuggestions(newSuggestions as unknown as Record<string, unknown>[]);
          } catch (err: unknown) {
            this.#logger.warn(
              `[SignalCollector] onSuggestions callback error (fallback): ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        this.#logger.info(
          `[SignalCollector] rule fallback done — ${newSuggestions.length} new suggestions`
        );
      }

      this.#saveSnapshot();
      // 离线模式使用较长间隔（减少无意义的重复分析）
      this.#scheduleNext(Math.min(this.#intervalMs * 2, MAX_INTERVAL_MS));
      return {
        suggestions: newSuggestions as unknown as Record<string, unknown>[],
        stats: this.#snapshot.lastResult,
      };
    } catch (err: unknown) {
      this.#logger.warn(
        `[SignalCollector] rule fallback error: ${err instanceof Error ? err.message : String(err)}`
      );
      this.#scheduleNext(Math.min(this.#intervalMs * 2, MAX_INTERVAL_MS));
      return { suggestions: [], stats: null };
    } finally {
      this.#running = false;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  信号收集器（6 维度）
  // ═══════════════════════════════════════════════════════

  async #collectGuardSignals(): Promise<Record<string, unknown>[]> {
    try {
      if (!this.#auditRepo) {
        return [];
      }
      const rows = await this.#auditRepo.findGuardViolationSignals(20);
      return rows;
    } catch {
      return [];
    }
  }

  #collectMemorySignals() {
    try {
      const memoryFile = path.join(this.#projectRoot, '.autosnippet', 'memory.jsonl');
      if (!fs.existsSync(memoryFile)) {
        return [];
      }
      const lines = fs.readFileSync(memoryFile, 'utf-8').trim().split('\n');
      return lines
        .slice(-20)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async #collectRecipeSignals(): Promise<Record<string, unknown>[]> {
    try {
      if (!this.#knowledgeRepo) {
        return [];
      }
      const rows = await this.#knowledgeRepo.findActiveRecipeSignals(30);
      return rows;
    } catch {
      return [];
    }
  }

  async #collectCandidateSignals(): Promise<Record<string, unknown>[]> {
    try {
      if (!this.#knowledgeRepo) {
        return [];
      }
      const rows = await this.#knowledgeRepo.findPendingCandidates(30);
      return rows;
    } catch {
      return [];
    }
  }

  async #collectRecentActions(): Promise<Record<string, unknown>[]> {
    try {
      if (!this.#auditRepo) {
        return [];
      }
      const sinceStr = this.#snapshot.lastRun;
      const sinceTs = sinceStr
        ? Math.floor(new Date(sinceStr).getTime() / 1000)
        : Math.floor((Date.now() - 24 * 3600 * 1000) / 1000);
      const rows = await this.#auditRepo.findRecentActions(sinceTs, 50);
      return rows;
    } catch {
      return [];
    }
  }

  #collectCodeChangeSignals() {
    try {
      const diff = execSync('git diff --stat HEAD~1 2>/dev/null || echo ""', {
        cwd: this.#projectRoot,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      if (!diff) {
        return [];
      }
      return diff.split('\n').slice(0, 20);
    } catch {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════
  //  AI Prompt 构建
  // ═══════════════════════════════════════════════════════

  #buildAnalysisPrompt(signals: CollectedSignals) {
    const modeInstruction =
      this.#mode === 'auto'
        ? '你处于 auto 模式：除了推荐之外，对于高优先级的建议，请直接调用 create_skill 工具自动创建 Skill。'
        : '你处于 suggest 模式：只输出推荐，不要自动创建 Skill。';

    return `你是 AutoSnippet 的后台行为分析 AI。你的任务是分析以下多维度信号，判断用户当前的开发状态，并给出 Skill 推荐建议。

${modeInstruction}

## 信号数据

### 1. Guard 冲突信号
${JSON.stringify(signals.guard, null, 2)}

### 2. 对话记忆（近期对话主题）
${JSON.stringify(signals.memory, null, 2)}

### 3. Recipe 模板健康度
${JSON.stringify(signals.recipes, null, 2)}

### 4. 待处理 Candidate
${JSON.stringify(signals.candidates, null, 2)}

### 5. 近期操作日志
${JSON.stringify(signals.actions, null, 2)}

### 6. 代码变更（git diff --stat）
${JSON.stringify(signals.codeChanges, null, 2)}

## 分析要求

1. 综合分析以上 6 个维度的信号
2. 识别重复模式、高频错误、未覆盖的操作
3. **只推荐项目特有的知识模式**，不要推荐通用编程知识（如 Git 基础、语言语法等）
4. 推荐的 Skill 应该能固化团队/项目的独有约定、架构决策或反复出现的问题解决方案
5. 根据信号密度判断下次分析应间隔多久（5-1440 分钟）
6. 给出简要分析摘要
7. 如果没有发现值得推荐的项目特有模式，返回空的 suggestions 数组

## 输出格式

在你的回复最后一行，输出一个 JSON 对象（不要包在 markdown code block 中）：
{"suggestions":[{"name":"skill-name","description":"一句话中文描述","reason":"推荐原因","priority":"high|medium|low","body":"推荐的 Skill 内容"}],"nextIntervalMinutes":60,"summary":"一句话分析摘要"}`;
  }

  // ═══════════════════════════════════════════════════════
  //  AI 响应解析 — 统一使用 AiProvider.extractJSON (Structured Output)
  // ═══════════════════════════════════════════════════════

  /**
   * 从 AgentRuntime ReAct 回复中提取结构化 JSON
   *
   * 优先级链:
   *   1. AiProvider.extractJSON (支持 markdown 清理、截断修复、trailing comma 等)
   *   2. 最后一行 JSON 回退 (兼容 prompt 要求的 "最后一行输出 JSON" 格式)
   *
   * @param reply AgentRuntime.execute() 的回复文本
   * @returns }
   */
  #parseStructuredReply(reply: string) {
    const defaultResult = { suggestions: [], nextIntervalMinutes: null, summary: '' };
    if (!reply) {
      return defaultResult;
    }

    try {
      // 策略 1: 通过 AiProvider.extractJSON 统一解析
      const aiProvider = this.#container?.get('aiProvider');
      if (aiProvider && typeof aiProvider.extractJSON === 'function') {
        const obj = aiProvider.extractJSON(reply, '{', '}');
        if (obj && Array.isArray(obj.suggestions)) {
          return obj;
        }
      }

      // 策略 2: 回退 — 从最后一行提取 JSON (兼容 prompt 指令)
      const lines = reply.trim().split('\n');
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
        const line = lines[i].trim();
        if (line.startsWith('{') && line.endsWith('}')) {
          try {
            const obj = JSON.parse(line);
            if (obj.suggestions) {
              return obj;
            }
          } catch {
            /* 继续 */
          }
        }
      }
    } catch {
      this.#logger.warn('[SignalCollector] failed to parse structured reply');
    }

    return defaultResult;
  }

  // ═══════════════════════════════════════════════════════
  //  快照持久化
  // ═══════════════════════════════════════════════════════

  #loadSnapshot() {
    try {
      if (fs.existsSync(this.#snapshotPath)) {
        const raw = fs.readFileSync(this.#snapshotPath, 'utf-8');
        const data = JSON.parse(raw);
        return {
          lastRun: data.lastRun || null,
          totalRuns: data.totalRuns || 0,
          pushedNames: Array.isArray(data.pushedNames) ? data.pushedNames : [],
          lastResult: data.lastResult || null,
          lastAiSummary: data.lastAiSummary || '',
          autoCreated: Array.isArray(data.autoCreated) ? data.autoCreated : [],
          pendingSuggestions: Array.isArray(data.pendingSuggestions) ? data.pendingSuggestions : [],
        };
      }
    } catch {
      /* corrupt — reset */
    }

    return {
      lastRun: null,
      totalRuns: 0,
      pushedNames: [],
      lastResult: null,
      lastAiSummary: '',
      autoCreated: [],
      pendingSuggestions: [],
    };
  }

  #saveSnapshot() {
    try {
      // 自动截断无限增长的数组
      const MAX_PUSHED = 200;
      const MAX_AUTO_CREATED = 100;
      if (this.#snapshot.pushedNames.length > MAX_PUSHED) {
        this.#snapshot.pushedNames = this.#snapshot.pushedNames.slice(-MAX_PUSHED);
      }
      if (this.#snapshot.autoCreated && this.#snapshot.autoCreated.length > MAX_AUTO_CREATED) {
        this.#snapshot.autoCreated = this.#snapshot.autoCreated.slice(-MAX_AUTO_CREATED);
      }

      const dir = path.dirname(this.#snapshotPath);
      pathGuard.assertProjectWriteSafe(dir);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.#snapshotPath, JSON.stringify(this.#snapshot, null, 2), 'utf-8');
    } catch (err: unknown) {
      this.#logger.warn(
        `[SignalCollector] snapshot save failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ═══════════════════════════════════════════════════════
  //  重置
  // ═══════════════════════════════════════════════════════

  resetPushed() {
    this.#snapshot.pushedNames = [];
    this.#snapshot.autoCreated = [];
    this.#saveSnapshot();
    this.#logger.info('[SignalCollector] pushed history reset');
  }
}

export default SignalCollector;
