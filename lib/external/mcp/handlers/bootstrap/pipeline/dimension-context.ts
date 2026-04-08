/**
 * pipeline/dimension-context.js — 跨维度上下文管理 (v6)
 *
 * ⚠️ 内部 Agent 专用 — 被 orchestrator.js 的 PipelineStrategy analyze 阶段调用。
 *    外部 Agent 不使用此模块（外部 Agent 的跨维度上下文由 BootstrapSession.js + EpisodicMemory 管理）。
 *
 * 在 PipelineStrategy 按维度分批执行时，维护跨维度的上下文:
 *   - 项目基础信息 (不变)
 *   - 已完成维度的 DimensionDigest (累积)
 *   - 已提交候选的摘要列表 (累积)
 *
 * 确保每个维度的 Analyst 阶段都能看到前序维度的分析结论，
 * 实现跨维度透明互补。
 *
 * @module pipeline/dimension-context
 */

// ─── Local type definitions ──────────────────────────────

/** Project base info (immutable during a bootstrap session) */
interface ProjectContext {
  projectName: string;
  primaryLang: string;
  fileCount: number;
  targetCount: number;
  modules: string[];
  depGraph?: Record<string, unknown>;
  astMetrics?: Record<string, unknown>;
  guardSummary?: Record<string, unknown>;
}

/** Summary of a completed dimension's analysis */
interface DimensionDigest {
  summary?: string;
  candidateCount?: number;
  candidateTitles?: string[];
  keyFindings?: string[];
  crossRefs?: Record<string, string>;
  gaps?: string[];
  remainingTasks?: Array<{ signal?: string } | string>;
  dimId?: string;
  completedAt?: number;
}

/** Summary of a submitted candidate */
interface CandidateSummary {
  dimId: string;
  title: string;
  subTopic: string;
  summary?: string;
}

/** Serialized form of DimensionContext (for checkpoint restore) */
interface DimensionContextJSON {
  projectContext: ProjectContext;
  completedDimensions?: Record<string, DimensionDigest>;
  submittedCandidates?: CandidateSummary[];
}

/**
 * DimensionContext — 跨维度上下文容器
 *
 * 在单次 bootstrap 会话中创建一次，按维度累积上下文。
 */
export class DimensionContext {
  completedDimensions: Map<string, DimensionDigest>;
  projectContext: ProjectContext;
  submittedCandidates: CandidateSummary[];
  /** @param projectContext 项目基础信息 (全程不变) */
  constructor(projectContext: ProjectContext) {
    /** 项目基础信息 */
    this.projectContext = projectContext;

    /** 已完成维度的摘要 */
    this.completedDimensions = new Map();

    /** 已提交候选的摘要 */
    this.submittedCandidates = [];
  }

  /**
   * 维度完成后存储其摘要
   *
   * @param dimId 维度 ID
   * @param digest 维度分析摘要
   */
  addDimensionDigest(dimId: string, digest: DimensionDigest) {
    this.completedDimensions.set(dimId, {
      ...digest,
      dimId,
      completedAt: Date.now(),
    });
  }

  /**
   * 记录已提交的候选
   *
   * @param candidateInfo { title, subTopic, summary }
   */
  addSubmittedCandidate(
    dimId: string,
    candidateInfo: { title?: string; subTopic?: string; summary?: string }
  ) {
    this.submittedCandidates.push({
      dimId,
      title: candidateInfo.title || '',
      subTopic: candidateInfo.subTopic || '',
      summary: candidateInfo.summary || '',
    });
  }

  /**
   * 构建给 Agent 的上下文快照
   *
   * @param currentDimId 当前维度 ID
   */
  buildContextForDimension(currentDimId: string) {
    const previousDimensions: Record<string, Partial<DimensionDigest>> = {};
    for (const [id, digest] of this.completedDimensions) {
      previousDimensions[id] = {
        summary: digest.summary,
        candidateCount: digest.candidateCount,
        keyFindings: digest.keyFindings || [],
        crossRefs: digest.crossRefs || {},
        gaps: digest.gaps || [],
        remainingTasks: digest.remainingTasks || [],
      };
    }

    return {
      project: this.projectContext,
      previousDimensions,
      existingCandidates: this.submittedCandidates.map((c) => ({
        dimId: c.dimId,
        title: c.title,
        subTopic: c.subTopic,
      })),
      currentDimension: currentDimId,
    };
  }

  /** 重算某维度时，获取该维度已有候选 */
  getExistingCandidatesForDimension(dimId: string) {
    return this.submittedCandidates.filter((c) => c.dimId === dimId);
  }

  /**
   * 获取所有维度摘要的紧凑文本表示
   * 用于 Agent prompt 中注入
   */
  getDigestsSummaryText() {
    if (this.completedDimensions.size === 0) {
      return '(尚无已完成维度)';
    }

    const lines: string[] = [];
    for (const [id, digest] of this.completedDimensions) {
      lines.push(`### ${id}`);
      lines.push(`- 摘要: ${digest.summary || '(无)'}`);
      lines.push(`- 产出候选: ${digest.candidateCount || 0} 条`);
      if (digest.keyFindings?.length) {
        lines.push(`- 关键发现: ${digest.keyFindings.join('; ')}`);
      }
      if (digest.crossRefs && Object.keys(digest.crossRefs).length > 0) {
        for (const [targetDim, suggestion] of Object.entries(digest.crossRefs)) {
          lines.push(`- → ${targetDim}: ${suggestion}`);
        }
      }
      if (digest.gaps?.length) {
        lines.push(`- 缺口: ${digest.gaps.join('; ')}`);
      }
      if (digest.remainingTasks?.length) {
        lines.push(
          `- 遗留任务: ${digest.remainingTasks.map((t) => (typeof t === 'string' ? t : t.signal) || String(t)).join('; ')}`
        );
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /** 将完整上下文序列化为 JSON (用于断点恢复) */
  toJSON() {
    return {
      projectContext: this.projectContext,
      completedDimensions: Object.fromEntries(this.completedDimensions),
      submittedCandidates: this.submittedCandidates,
    };
  }

  /** 从 JSON 恢复上下文 (断点恢复) */
  static fromJSON(json: DimensionContextJSON) {
    const ctx = new DimensionContext(json.projectContext);
    for (const [id, digest] of Object.entries(json.completedDimensions || {})) {
      ctx.completedDimensions.set(id, digest);
    }
    ctx.submittedCandidates = json.submittedCandidates || [];
    return ctx;
  }
}

/**
 * 从 Agent 的最终回复中解析 DimensionDigest
 *
 * Agent 被要求在回复末尾包含 JSON 格式的 dimensionDigest。
 * 此函数从自由格式文本中提取该 JSON 块。
 *
 * @param reply Agent 的完整回复文本
 */
export function parseDimensionDigest(reply: string | null | undefined): DimensionDigest | null {
  if (!reply || typeof reply !== 'string') {
    return null;
  }

  // 尝试匹配 {"dimensionDigest": {...}} 格式
  const jsonBlockRe = /```(?:json)?\s*\n?\s*(\{[\s\S]*?"dimensionDigest"[\s\S]*?\})\s*\n?\s*```/;
  let match = reply.match(jsonBlockRe);

  // 备选: 没有 code fence 的裸 JSON
  if (!match) {
    const bareRe = /(\{"dimensionDigest"\s*:\s*\{[\s\S]*?\}\s*\})/;
    match = reply.match(bareRe);
  }

  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]);
    const digest = parsed.dimensionDigest || parsed;

    // 验证必要字段
    if (!digest.summary && !digest.candidateCount) {
      return null;
    }

    return {
      summary: digest.summary || '',
      candidateCount: digest.candidateCount || 0,
      candidateTitles: digest.candidateTitles || [],
      keyFindings: digest.keyFindings || [],
      crossRefs: digest.crossRefs || {},
      gaps: digest.gaps || [],
      remainingTasks: digest.remainingTasks || [],
    };
  } catch {
    return null;
  }
}
