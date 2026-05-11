/**
 * UncertaintyCollector — Guard uncertain 三态收集器
 *
 * 当 Guard 各层检测遇到能力边界（AST 不可用、跨文件缺失、正则冲突等）时，
 * 收集 skip 原因并产出结构化的 uncertain 结果。
 *
 * 设计原则:
 *   - uncertain 不是"错误"，是"承认能力边界"
 *   - Guard 不调用 AI，uncertain 是确定性输出
 *   - 保持 <10ms 性能
 */

/* ────────────────────── Types ────────────────────── */

export type SkipLayer = 'regex' | 'code_level' | 'ast' | 'cross_file';
export type SkipReason =
  | 'invalid_regex'
  | 'lang_unsupported'
  | 'ast_unavailable'
  | 'file_missing'
  | 'scope_mismatch'
  | 'layer_conflict';
export type SkipImpact = 'high' | 'medium' | 'low';

export interface SkippedCheck {
  layer: SkipLayer;
  ruleId?: string;
  reason: SkipReason;
  detail: string;
  impact: SkipImpact;
}

export type BoundaryType =
  | 'ast_language_gap'
  | 'cross_file_incomplete'
  | 'rule_regex_invalid'
  | 'scope_unchecked'
  | 'transitive_cycle';

export interface CapabilityBoundary {
  type: BoundaryType;
  description: string;
  affectedRules: string[];
  suggestedAction: string;
}

export interface UncertainResult {
  ruleId: string;
  message: string;
  layer: SkipLayer;
  reason: SkipReason;
  detail: string;
}

export interface GuardCapabilityReport {
  executedChecks: {
    regex: { total: number; executed: number; skipped: number };
    codeLevel: { total: number; executed: number; skipped: number };
    ast: { total: number; executed: number; skipped: number };
    crossFile: { total: number; executed: number; skipped: number };
  };
  skippedChecks: SkippedCheck[];
  boundaries: CapabilityBoundary[];
  uncertainResults: UncertainResult[];
  checkCoverage: number; // 0-100
}

/* ────────────────────── Collector ────────────────────── */

export class UncertaintyCollector {
  #skippedChecks: SkippedCheck[] = [];
  #uncertainResults: UncertainResult[] = [];
  #layerCounts = {
    regex: { total: 0, executed: 0, skipped: 0 },
    codeLevel: { total: 0, executed: 0, skipped: 0 },
    ast: { total: 0, executed: 0, skipped: 0 },
    crossFile: { total: 0, executed: 0, skipped: 0 },
  };

  /** 记录某个规则在某层被跳过 */
  recordSkip(
    layer: SkipLayer,
    reason: SkipReason,
    detail: string,
    options: { ruleId?: string; impact?: SkipImpact } = {}
  ) {
    const impact = options.impact ?? this.#inferImpact(layer, reason);
    this.#skippedChecks.push({
      layer,
      ruleId: options.ruleId,
      reason,
      detail,
      impact,
    });

    const key = layer === 'code_level' ? 'codeLevel' : layer === 'cross_file' ? 'crossFile' : layer;
    this.#layerCounts[key].skipped++;
  }

  /** 追加一条 uncertain 结果 */
  addUncertain(
    ruleId: string,
    message: string,
    layer: SkipLayer,
    reason: SkipReason,
    detail: string
  ) {
    this.#uncertainResults.push({ ruleId, message, layer, reason, detail });
  }

  /** 记录各层的检查总数和执行数 */
  recordLayerStats(layer: SkipLayer, total: number, executed: number) {
    const key = layer === 'code_level' ? 'codeLevel' : layer === 'cross_file' ? 'crossFile' : layer;
    this.#layerCounts[key].total += total;
    this.#layerCounts[key].executed += executed;
  }

  /** 生成能力报告 */
  buildReport(): GuardCapabilityReport {
    const boundaries = this.#detectBoundaries();
    const totalChecks =
      this.#layerCounts.regex.total +
      this.#layerCounts.codeLevel.total +
      this.#layerCounts.ast.total +
      this.#layerCounts.crossFile.total;
    const executedChecks =
      this.#layerCounts.regex.executed +
      this.#layerCounts.codeLevel.executed +
      this.#layerCounts.ast.executed +
      this.#layerCounts.crossFile.executed;
    const checkCoverage = totalChecks > 0 ? Math.round((executedChecks / totalChecks) * 100) : 100;

    return {
      executedChecks: { ...this.#layerCounts },
      skippedChecks: [...this.#skippedChecks],
      boundaries,
      uncertainResults: [...this.#uncertainResults],
      checkCoverage,
    };
  }

  /** 获取 uncertain 结果数量 */
  get uncertainCount(): number {
    return this.#uncertainResults.length;
  }

  /** 获取 skipped 总数 */
  get skippedCount(): number {
    return this.#skippedChecks.length;
  }

  /** 重置状态（供多文件审计复用） */
  reset() {
    this.#skippedChecks = [];
    this.#uncertainResults = [];
    this.#layerCounts = {
      regex: { total: 0, executed: 0, skipped: 0 },
      codeLevel: { total: 0, executed: 0, skipped: 0 },
      ast: { total: 0, executed: 0, skipped: 0 },
      crossFile: { total: 0, executed: 0, skipped: 0 },
    };
  }

  /* ── 内部 ── */

  #inferImpact(layer: SkipLayer, reason: SkipReason): SkipImpact {
    // AST 和跨文件中的结构化检查更重要
    if (layer === 'ast' && reason === 'ast_unavailable') {
      return 'high';
    }
    if (layer === 'cross_file' && reason === 'file_missing') {
      return 'medium';
    }
    if (reason === 'invalid_regex') {
      return 'medium';
    }
    if (reason === 'layer_conflict') {
      return 'high';
    }
    return 'low';
  }

  #detectBoundaries(): CapabilityBoundary[] {
    const boundaries: CapabilityBoundary[] = [];

    // 按层+原因分组
    const groups = new Map<string, SkippedCheck[]>();
    for (const skip of this.#skippedChecks) {
      const key = `${skip.layer}:${skip.reason}`;
      const list = groups.get(key) || [];
      list.push(skip);
      groups.set(key, list);
    }

    for (const [key, skips] of groups) {
      const [layer, reason] = key.split(':') as [SkipLayer, SkipReason];
      const affectedRules = [...new Set(skips.map((s) => s.ruleId).filter(Boolean))] as string[];

      if (reason === 'ast_unavailable') {
        boundaries.push({
          type: 'ast_language_gap',
          description: `AST 检查因 tree-sitter 不可用被跳过 (${skips.length} 条规则)`,
          affectedRules,
          suggestedAction: '确认 tree-sitter 支持该语言，或降级为正则匹配',
        });
      } else if (reason === 'file_missing' && layer === 'cross_file') {
        boundaries.push({
          type: 'cross_file_incomplete',
          description: `跨文件检查因文件缺失被跳过 (${skips.length} 次)`,
          affectedRules,
          suggestedAction: '确保审计时传入完整文件列表',
        });
      } else if (reason === 'invalid_regex') {
        boundaries.push({
          type: 'rule_regex_invalid',
          description: `${skips.length} 条规则的正则表达式编译失败`,
          affectedRules,
          suggestedAction: '修复或替换无效的正则表达式',
        });
      } else if (reason === 'layer_conflict') {
        boundaries.push({
          type: 'scope_unchecked',
          description: `${skips.length} 个检查结果因层间冲突存疑`,
          affectedRules,
          suggestedAction: '人工审核冲突规则',
        });
      }
    }

    return boundaries;
  }
}
