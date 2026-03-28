/**
 * ToolForge — 工具锻造主编排器
 *
 * 三级锻造策略：
 *   Reuse (0ms)   → 直接重用注册表中已有工具
 *   Compose (10ms) → 通过 DynamicComposer 组合已有原子工具
 *   Generate (5s)  → LLM 生成工具代码 → SandboxRunner 验证 → 注册
 *
 * 瀑布逻辑：reuse → compose → generate，首个成功即返回。
 */

import Logger from '#infra/logging/Logger.js';

import type { SignalBus } from '#infra/signal/SignalBus.js';

import type { CompositionSpec } from './DynamicComposer.js';
import { DynamicComposer } from './DynamicComposer.js';
import type { SandboxTestCase } from './SandboxRunner.js';
import { SandboxRunner } from './SandboxRunner.js';
import { TemporaryToolRegistry } from './TemporaryToolRegistry.js';
import type { AnalysisResult, ToolRequirement } from './ToolRequirementAnalyzer.js';
import { ToolRequirementAnalyzer } from './ToolRequirementAnalyzer.js';

/* ────────────────────── Types ────────────────────── */

interface ToolRegistryLike {
  has(name: string): boolean;
  getToolNames(): string[];
  execute(
    name: string,
    params: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<unknown>;
  register(toolDef: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
    handler: Function;
  }): void;
  unregister(name: string): boolean;
}

export interface ForgeRequest {
  /** 用户意图 */
  intent: string;
  /** 关键动作 */
  action: string;
  /** 目标对象 */
  target: string;
  /** 约束条件 */
  constraints?: string[];
  /** LLM 代码生成回调 — 仅 generate 模式时调用 */
  codeGenerator?: (requirement: ToolRequirement) => Promise<GeneratedTool | null>;
}

export interface GeneratedTool {
  /** 工具名 */
  name: string;
  /** 描述 */
  description: string;
  /** JSON Schema 参数 */
  parameters: Record<string, unknown>;
  /** 工具代码（需包含 toolHandler 函数） */
  code: string;
  /** 测试用例 */
  testCases: SandboxTestCase[];
}

export interface ForgeResult {
  /** 是否成功 */
  success: boolean;
  /** 使用的模式 */
  mode: 'reuse' | 'compose' | 'generate';
  /** 工具名称 */
  toolName?: string;
  /** 需求分析结果 */
  analysis: AnalysisResult;
  /** 失败原因 */
  error?: string;
}

/* ────────────────────── Options ────────────────────── */

export interface ToolForgeOptions {
  signalBus?: SignalBus;
  /** 生成工具的默认 TTL（ms），默认 30 分钟 */
  defaultTtlMs?: number;
  /** compose 模式下的组合 spec 生成器 */
  compositionSpecBuilder?: (
    analysis: AnalysisResult,
    requirement: ToolRequirement
  ) => CompositionSpec | null;
}

/* ────────────────────── Class ────────────────────── */

export class ToolForge {
  #registry: ToolRegistryLike;
  #analyzer: ToolRequirementAnalyzer;
  #composer: DynamicComposer;
  #sandbox: SandboxRunner;
  #tempRegistry: TemporaryToolRegistry;
  #signalBus: SignalBus | null;
  #logger = Logger.getInstance();
  #defaultTtlMs: number;
  #compositionSpecBuilder: ToolForgeOptions['compositionSpecBuilder'];

  constructor(registry: ToolRegistryLike, options: ToolForgeOptions = {}) {
    this.#registry = registry;
    this.#signalBus = options.signalBus ?? null;
    this.#defaultTtlMs = options.defaultTtlMs ?? 30 * 60 * 1000;
    this.#compositionSpecBuilder = options.compositionSpecBuilder;

    this.#analyzer = new ToolRequirementAnalyzer(registry);
    this.#composer = new DynamicComposer(registry);
    this.#sandbox = new SandboxRunner();
    this.#tempRegistry = new TemporaryToolRegistry(registry, {
      signalBus: this.#signalBus ?? undefined,
    });
  }

  /* ────────── Public API ────────── */

  /**
   * 锻造工具 — 瀑布流：reuse → compose → generate
   */
  async forge(request: ForgeRequest): Promise<ForgeResult> {
    const requirement: ToolRequirement = {
      intent: request.intent,
      action: request.action,
      target: request.target,
      constraints: request.constraints,
    };

    // Step 1: 需求分析
    const analysis = this.#analyzer.analyze(requirement);
    this.#logger.info(
      `ToolForge: analysis for "${request.intent}" → mode=${analysis.mode}, confidence=${analysis.confidence}`
    );

    // Step 2: 按推荐模式尝试，失败则降级
    const result =
      (await this.#tryReuse(analysis, requirement)) ??
      (await this.#tryCompose(analysis, requirement)) ??
      (await this.#tryGenerate(analysis, requirement, request.codeGenerator));

    if (result) {
      this.#emitSignal('forge_complete', {
        mode: result.mode,
        tool: result.toolName,
        analysis,
      });
      return result;
    }

    // 全部失败
    return {
      success: false,
      mode: 'generate',
      analysis,
      error: 'All forge modes exhausted. Cannot satisfy tool requirement.',
    };
  }

  /**
   * 获取临时工具注册表（暴露给 Pipeline 集成用）
   */
  get temporaryRegistry(): TemporaryToolRegistry {
    return this.#tempRegistry;
  }

  /**
   * 获取分析器
   */
  get analyzer(): ToolRequirementAnalyzer {
    return this.#analyzer;
  }

  /**
   * 销毁 Forge（清理临时工具和定时器）
   */
  dispose(): void {
    this.#tempRegistry.dispose();
  }

  /* ────────── Forge Modes ────────── */

  async #tryReuse(
    analysis: AnalysisResult,
    _requirement: ToolRequirement
  ): Promise<ForgeResult | null> {
    if (analysis.mode !== 'reuse' || !analysis.matchedTool) {
      // 即便分析推荐 compose/generate，也尝试检查直接匹配
      if (analysis.matchedTool && this.#registry.has(analysis.matchedTool)) {
        return {
          success: true,
          mode: 'reuse',
          toolName: analysis.matchedTool,
          analysis,
        };
      }
      return null;
    }

    if (!this.#registry.has(analysis.matchedTool)) {
      return null;
    }

    this.#logger.debug(`ToolForge: reuse existing tool "${analysis.matchedTool}"`);
    return {
      success: true,
      mode: 'reuse',
      toolName: analysis.matchedTool,
      analysis,
    };
  }

  async #tryCompose(
    analysis: AnalysisResult,
    requirement: ToolRequirement
  ): Promise<ForgeResult | null> {
    if (!analysis.composableTools || analysis.composableTools.length < 2) {
      return null;
    }

    // 如果有外部 spec builder，使用它
    const spec = this.#compositionSpecBuilder?.(analysis, requirement);
    if (!spec) {
      // 默认构建 sequential 组合
      const defaultSpec = this.#buildDefaultCompositionSpec(analysis, requirement);
      if (!defaultSpec) {
        return null;
      }
      return this.#executeComposition(defaultSpec, analysis);
    }

    return this.#executeComposition(spec, analysis);
  }

  #buildDefaultCompositionSpec(
    analysis: AnalysisResult,
    requirement: ToolRequirement
  ): CompositionSpec | null {
    const tools = analysis.composableTools;
    if (!tools || tools.length < 2) {
      return null;
    }

    const composedName = `composed_${requirement.action}_${requirement.target}`;
    return {
      name: composedName,
      description: `Auto-composed tool for: ${requirement.intent}`,
      steps: tools.map((tool) => ({
        tool,
        args: (prevResult: unknown) => {
          if (typeof prevResult === 'object' && prevResult !== null) {
            return prevResult as Record<string, unknown>;
          }
          return {};
        },
      })),
      mergeStrategy: 'sequential',
    };
  }

  async #executeComposition(
    spec: CompositionSpec,
    analysis: AnalysisResult
  ): Promise<ForgeResult | null> {
    const result = this.#composer.compose(spec);
    if (!result.success || !result.handler) {
      this.#logger.debug(`ToolForge: composition failed — ${result.error}`);
      return null;
    }

    // 注册为临时工具
    this.#tempRegistry.registerTemporary(
      {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters ?? {},
        handler: result.handler,
        forgeMode: 'compose',
      },
      this.#defaultTtlMs
    );

    this.#logger.info(`ToolForge: composed tool "${spec.name}" from ${spec.steps.length} steps`);

    return {
      success: true,
      mode: 'compose',
      toolName: spec.name,
      analysis,
    };
  }

  async #tryGenerate(
    analysis: AnalysisResult,
    requirement: ToolRequirement,
    codeGenerator?: ForgeRequest['codeGenerator']
  ): Promise<ForgeResult | null> {
    if (!codeGenerator) {
      this.#logger.debug('ToolForge: generate mode skipped (no codeGenerator provided)');
      return null;
    }

    // 调用 LLM 生成工具
    const generated = await codeGenerator(requirement);
    if (!generated) {
      return null;
    }

    // 安全检查
    const safety = this.#sandbox.checkSafety(generated.code);
    if (!safety.passed) {
      this.#logger.warn(
        `ToolForge: generated code failed safety check — ${safety.violations.join(', ')}`
      );
      return {
        success: false,
        mode: 'generate',
        analysis,
        error: `Safety violations: ${safety.violations.join(', ')}`,
      };
    }

    // 沙箱测试
    if (generated.testCases.length > 0) {
      const testResult = await this.#sandbox.run(generated.code, generated.testCases);
      if (!testResult.success) {
        const failures = testResult.testResults
          .filter((t) => !t.passed)
          .map((t) => t.description)
          .join(', ');
        this.#logger.warn(`ToolForge: generated code failed tests — ${failures}`);
        return {
          success: false,
          mode: 'generate',
          analysis,
          error: `Test failures: ${failures}`,
        };
      }
    }

    // 构建 handler 包装
    const handler = this.#sandbox.createHandler(generated.code);

    // 注册为临时工具
    this.#tempRegistry.registerTemporary(
      {
        name: generated.name,
        description: generated.description,
        parameters: generated.parameters,
        handler,
        forgeMode: 'generate',
      },
      this.#defaultTtlMs
    );

    this.#logger.info(`ToolForge: generated and registered tool "${generated.name}"`);

    return {
      success: true,
      mode: 'generate',
      toolName: generated.name,
      analysis,
    };
  }

  /* ────────── Signal ────────── */

  #emitSignal(action: string, data: Record<string, unknown>): void {
    if (this.#signalBus) {
      this.#signalBus.send('forge', 'ToolForge', 1, {
        metadata: { action, ...data },
      });
    }
  }
}
