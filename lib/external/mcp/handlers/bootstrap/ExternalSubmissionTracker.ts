/**
 * ExternalSubmissionTracker — 外部 Agent 提交追踪与质量评估
 *
 * 质量门控的外部 Agent 对应模块。
 * 内部 Agent 使用 EvidenceCollector 从 toolCall 中收集证据 (bootstrap-gate.js)，
 * 外部 Agent 使用 ExternalSubmissionTracker 从 submit_knowledge 调用中积累证据。
 *
 * 职责:
 *   - 追踪每个维度的 submit_knowledge 提交 (recipe 元数据 + 引用文件)
 *   - 从提交内容构建 evidenceMap (filePath → 引用摘要)
 *   - 从 dimension_complete 的 analysisText 提取负空间信号
 *   - 计算维度级质量评分 (对应 bootstrap-gate.js 的 buildQualityScores)
 *   - 为下游维度提供结构化跨维度证据
 *
 * 设计对应关系:
 *   内部 Agent                          外部 Agent
 *   ─────────────────                  ─────────────────
 *   EvidenceCollector.processToolCall  → recordSubmission
 *   evidenceMap (代码片段)              → evidenceMap (提交引用)
 *   negativeSignals (搜索未命中)        → negativeSignals (analysisText 提取)
 *   buildQualityScores (4维评分)        → buildQualityReport (4维评分)
 *   explorationLog (工具序列)           → submissionLog (提交序列)
 *
 * @module bootstrap/ExternalSubmissionTracker
 */

// ── 常量 ────────────────────────────────────────────────────

/** 单个维度最大追踪提交数 */
const MAX_SUBMISSIONS_PER_DIM = 20;

/** 负空间信号最大数量 */
const MAX_NEGATIVE_SIGNALS = 30;

// ── 类型定义 ────────────────────────────────────────────────

/** 一次 submit_knowledge 的提交记录 */
interface SubmissionRecord {
  recipeId: string;
  title: string;
  knowledgeType: string;
  kind: string;
  category: string;
  sources: string[];
  coreCodePreview: string;
  contentLength: number;
  confidence: number;
  submittedAt: number;
}

/** 负空间信号 */
interface NegativeSignal {
  pattern: string;
  source: string;
  dimId?: string;
}

/** submit_knowledge 原始参数中需要的字段 */
interface SubmissionArgs {
  title?: string;
  knowledgeType?: string;
  kind?: string;
  category?: string;
  trigger?: string;
  coreCode?: string;
  content?: { markdown?: string; [key: string]: unknown };
  reasoning?: { sources?: string[]; confidence?: number; [key: string]: unknown };
  [key: string]: unknown;
}

/** 质量评分 4 维度 */
interface QualityScores {
  coverageScore: number;
  evidenceScore: number;
  diversityScore: number;
  coherenceScore: number;
}

/** 维度级质量报告 */
export interface DimensionQualityReport {
  scores: QualityScores;
  totalScore: number;
  suggestions: string[];
  pass: boolean;
}

/** 跨维度文件共享信息 */
interface SharedFileInfo {
  filePath: string;
  dimensions: string[];
}

/** 已完成维度摘要（供跨维度证据使用） */
interface CompletedDimSummary {
  dimId: string;
  submissionCount: number;
  titles: string[];
  knowledgeTypes: string[];
  referencedFiles: string[];
}

/** getAccumulatedEvidence 返回值 */
export interface AccumulatedEvidence {
  completedDimSummaries: CompletedDimSummary[];
  sharedFiles: SharedFileInfo[];
  negativeSignals: NegativeSignal[];
  usedTriggers: string[];
}

// ── 主类 ────────────────────────────────────────────────────

export class ExternalSubmissionTracker {
  /** dimId → 提交记录列表 */
  #dimensionSubmissions = new Map<string, SubmissionRecord[]>();

  /** filePath → 引用此文件的 dimId 集合 */
  #fileEvidenceMap = new Map<string, Set<string>>();

  /** 负空间信号 */
  #negativeSignals: NegativeSignal[] = [];

  /** dimId → 被拒绝的提交标题列表 */
  #rejections = new Map<string, string[]>();

  /** 已使用的唯一 trigger 集合 (跨维度) */
  #usedTriggers = new Set<string>();

  // ─── 提交记录 ─────────────────────────────────────────

  /**
   * 记录一次成功的 submit_knowledge 提交
   *
   * @param dimId 当前活跃维度 (由调用方根据 session 进度推断)
   * @param submissionArgs submit_knowledge 的原始参数
   * @param recipeId 提交成功后返回的 recipe ID
   */
  recordSubmission(dimId: string, submissionArgs: SubmissionArgs, recipeId: string) {
    if (!this.#dimensionSubmissions.has(dimId)) {
      this.#dimensionSubmissions.set(dimId, []);
    }

    const submissions = this.#dimensionSubmissions.get(dimId)!;
    if (submissions.length >= MAX_SUBMISSIONS_PER_DIM) {
      // 超过追踪上限，记录警告信息而非静默丢弃
      this.#addNegativeSignal(
        `Dimension "${dimId}" exceeded ${MAX_SUBMISSIONS_PER_DIM} submissions tracking limit — quality scoring may be lower than actual`,
        'tracker-overflow',
        dimId
      );
      return;
    }

    const record = {
      recipeId,
      title: submissionArgs.title || '',
      knowledgeType: submissionArgs.knowledgeType || '',
      kind: submissionArgs.kind || '',
      category: submissionArgs.category || '',
      sources: submissionArgs.reasoning?.sources || [],
      coreCodePreview: (submissionArgs.coreCode || '').substring(0, 200),
      contentLength: submissionArgs.content?.markdown?.length || 0,
      confidence: submissionArgs.reasoning?.confidence || 0,
      submittedAt: Date.now(),
    };

    submissions.push(record);

    // 记录 trigger
    if (submissionArgs.trigger) {
      this.#usedTriggers.add(submissionArgs.trigger);
    }

    // 更新 fileEvidenceMap
    for (const source of record.sources) {
      const filePath = source.split(':')[0]; // "file.m:123" → "file.m"
      if (!this.#fileEvidenceMap.has(filePath)) {
        this.#fileEvidenceMap.set(filePath, new Set());
      }
      this.#fileEvidenceMap.get(filePath)!.add(dimId);
    }
  }

  /**
   * 记录被拒绝的提交 (RecipeReadiness 或 dedup 拒绝)
   *
   * @param title 被拒绝候选的标题
   * @param reason 拒绝原因
   */
  recordRejection(dimId: string, title: string, reason: string) {
    if (!this.#rejections.has(dimId)) {
      this.#rejections.set(dimId, []);
    }
    this.#rejections.get(dimId)!.push(`${title}: ${reason}`);

    // 拒绝也是一种负空间信号
    this.#addNegativeSignal(`Rejected submission "${title}": ${reason}`, 'rejection', dimId);
  }

  // ─── 负空间信号 ───────────────────────────────────────

  /**
   * 从 dimension_complete 的 analysisText 中提取负空间信号
   *
   * 识别模式:
   * - "未找到..." / "不存在..." / "没有发现..."
   * - "Not found" / "No evidence of" / "does not use"
   * - "项目未使用..." / "没有使用..."
   */
  extractNegativeSignals(analysisText: string, dimId: string) {
    if (!analysisText) {
      return;
    }

    const negativePatterns = [
      // 中文负空间
      /(?:未找到|不存在|没有发现|没有使用|未使用|未见|项目未采用|项目不使用|缺少)\s*[^。\n]{5,60}/g,
      // 英文负空间
      /(?:not found|no evidence of|does not use|no instances? of|absence of|missing|not implemented|not detected)\s+[^.\n]{5,80}/gi,
      // 明确的反面结论
      /(?:与预期不同|contrary to|unlike|despite|although)[^。.\n]{10,80}/gi,
    ];

    for (const pattern of negativePatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(analysisText)) !== null) {
        this.#addNegativeSignal(match[0].trim(), 'analysisText', dimId);
      }
    }
  }

  /** 添加负空间信号 (去重) */
  #addNegativeSignal(pattern: string, source: string, dimId?: string) {
    if (this.#negativeSignals.length >= MAX_NEGATIVE_SIGNALS) {
      return;
    }

    // 去重: 相同 pattern 不重复添加
    const normalized = pattern.toLowerCase().substring(0, 80);
    const exists = this.#negativeSignals.some(
      (s) => s.pattern.toLowerCase().substring(0, 80) === normalized
    );
    if (!exists) {
      this.#negativeSignals.push({ pattern, source, dimId });
    }
  }

  // ─── 质量评估 ─────────────────────────────────────────

  /**
   * 计算维度级质量报告
   *
   * 4 维度评分 (各 0-100, 加权总分):
   *   coverageScore  (30%) — 提交数量 + 引用文件覆盖
   *   evidenceScore  (30%) — 提交内容丰富度 (长度 + coreCode + confidence)
   *   diversityScore (20%) — 知识类型 + category 多样性
   *   coherenceScore (20%) — analysisText 结构化程度
   *
   * 与内部 Agent 的 buildQualityScores 对齐:
   *   内部 depthScore    → 外部 coverageScore
   *   内部 evidenceScore → 外部 evidenceScore
   *   内部 breadthScore  → 外部 diversityScore
   *   内部 coherenceScore → 外部 coherenceScore
   *
   * @param [analysisText] dimension_complete 提供的分析文本
   * @param [referencedFiles] 引用文件列表
   */
  buildQualityReport(
    dimId: string,
    analysisText = '',
    referencedFiles: string[] = []
  ): DimensionQualityReport {
    const submissions: SubmissionRecord[] = this.#dimensionSubmissions.get(dimId) || [];
    const rejections: string[] = this.#rejections.get(dimId) || [];
    const scores = {} as QualityScores;
    const suggestions: string[] = [];

    // §1: coverageScore — 提交数量 + 引用文件覆盖
    const submissionCount = submissions.length;
    const uniqueSources = new Set(submissions.flatMap((s) => s.sources));
    const fileCount = new Set([...uniqueSources, ...referencedFiles]).size;
    scores.coverageScore = Math.min(100, submissionCount * 20 + fileCount * 8);
    if (submissionCount < 3) {
      suggestions.push(`只提交了 ${submissionCount} 条候选，建议至少 3 条以充分覆盖维度`);
    }
    if (fileCount < 3) {
      suggestions.push(`引用文件仅 ${fileCount} 个，建议引用更多源码文件作为证据`);
    }

    // §2: evidenceScore — 提交内容丰富度
    const avgContentLen =
      submissions.length > 0
        ? submissions.reduce((sum: number, s) => sum + s.contentLength, 0) / submissions.length
        : 0;
    const hasCoreCode = submissions.filter((s) => s.coreCodePreview.length > 0).length;
    const avgConfidence =
      submissions.length > 0
        ? submissions.reduce((sum: number, s) => sum + s.confidence, 0) / submissions.length
        : 0;
    scores.evidenceScore = Math.min(
      100,
      (avgContentLen > 400 ? 40 : avgContentLen / 10) +
        (hasCoreCode / Math.max(submissions.length, 1)) * 30 +
        avgConfidence * 30
    );
    if (avgContentLen < 200) {
      suggestions.push('候选内容平均长度偏短，建议包含更多代码引用和项目上下文');
    }
    if (rejections.length > 0) {
      suggestions.push(`有 ${rejections.length} 条提交被拒绝，请检查字段完整性`);
    }

    // §3: diversityScore — 知识类型 + category 多样性
    const uniqueTypes = new Set(submissions.map((s) => s.knowledgeType));
    const uniqueCategories = new Set(submissions.map((s) => s.category));
    const uniqueKinds = new Set(submissions.map((s) => s.kind));
    scores.diversityScore = Math.min(
      100,
      uniqueTypes.size * 25 + uniqueCategories.size * 15 + uniqueKinds.size * 20
    );

    // §4: coherenceScore — analysisText 结构化程度
    const textLen = analysisText.length;
    const hasHeaders = /#{1,3}\s/.test(analysisText);
    const hasLists = /\d+\.\s|[-•]\s/.test(analysisText);
    const hasCodeBlocks = /```[\s\S]*?```/.test(analysisText);
    scores.coherenceScore = Math.min(
      100,
      (textLen > 500 ? 30 : textLen / 17) +
        (hasHeaders ? 25 : 0) +
        (hasLists ? 20 : 0) +
        (hasCodeBlocks ? 25 : 0)
    );
    if (textLen < 200) {
      suggestions.push('分析文本过短，建议包含更详细的代码分析过程');
    }

    // 加权总分
    const totalScore = Math.round(
      scores.coverageScore * 0.3 +
        scores.evidenceScore * 0.3 +
        scores.diversityScore * 0.2 +
        scores.coherenceScore * 0.2
    );

    // 门控阈值
    const pass = totalScore >= 50;
    if (!pass) {
      suggestions.unshift(`质量评分 ${totalScore}/100 未达标 (≥50)，建议补充更多高质量候选`);
    }

    return { scores, totalScore, suggestions, pass };
  }

  // ─── 跨维度证据 ───────────────────────────────────────

  /**
   * 获取跨维度累积证据摘要 — 供下一维度参考
   *
   * @param currentDimId 当前维度 (将排除在结果之外)
   * @returns { completedDimSummaries, sharedFiles, negativeSignals, usedTriggers }
   */
  getAccumulatedEvidence(currentDimId: string): AccumulatedEvidence {
    const completedDimSummaries: CompletedDimSummary[] = [];

    for (const [dimId, submissions] of this.#dimensionSubmissions) {
      if (dimId === currentDimId) {
        continue;
      }

      completedDimSummaries.push({
        dimId,
        submissionCount: submissions.length,
        titles: submissions.map((s: SubmissionRecord) => s.title),
        knowledgeTypes: [...new Set(submissions.map((s: SubmissionRecord) => s.knowledgeType))],
        referencedFiles: [
          ...new Set(submissions.flatMap((s: SubmissionRecord) => s.sources)),
        ].slice(0, 15),
      });
    }

    // 多维度引用的文件 (交叉点)
    const sharedFiles: SharedFileInfo[] = [];
    for (const [filePath, dimIds] of this.#fileEvidenceMap) {
      if (dimIds.size > 1) {
        sharedFiles.push({ filePath, dimensions: [...dimIds] });
      }
    }

    return {
      completedDimSummaries,
      sharedFiles,
      negativeSignals: this.#negativeSignals.filter((s) => s.dimId !== currentDimId),
      usedTriggers: [...this.#usedTriggers],
    };
  }

  // ─── 查询 API ─────────────────────────────────────────

  /** 获取指定维度的提交列表 */
  getSubmissions(dimId: string): SubmissionRecord[] {
    return this.#dimensionSubmissions.get(dimId) || [];
  }

  /** 获取所有负空间信号 */
  getNegativeSignals() {
    return [...this.#negativeSignals];
  }

  /** 获取全局文件证据地图 */
  getFileEvidenceMap() {
    return new Map(this.#fileEvidenceMap);
  }

  /** 获取追踪统计 */
  getStats() {
    let totalSubmissions = 0;
    let totalRejections = 0;
    for (const subs of this.#dimensionSubmissions.values()) {
      totalSubmissions += subs.length;
    }
    for (const rejs of this.#rejections.values()) {
      totalRejections += rejs.length;
    }

    return {
      dimensions: this.#dimensionSubmissions.size,
      totalSubmissions,
      totalRejections,
      uniqueFiles: this.#fileEvidenceMap.size,
      negativeSignals: this.#negativeSignals.length,
      usedTriggers: this.#usedTriggers.size,
    };
  }
}

export default ExternalSubmissionTracker;
