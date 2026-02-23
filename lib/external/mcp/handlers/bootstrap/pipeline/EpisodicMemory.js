/**
 * EpisodicMemory — Bootstrap 会话级情景记忆
 *
 * 内部 Agent 和外部 Agent 共享此模块。
 *
 * 提供跨维度上下文:
 *   - 完整的维度分析报告 (含分析文本 + 代码证据)
 *   - 结构化 Evidence Store (文件→发现 的映射)
 *   - 跨维度引用 (CrossReference)
 *   - Tier 级 Reflection (每个 Tier 完成后的综合洞察)
 *
 * 调用方:
 *   - orchestrator.js (内部 Agent) — AnalystAgent 使用 buildContextForDimension()
 *   - BootstrapSession.js (外部 Agent) — 每个 Session 创建独立 EpisodicMemory 实例,
 *     通过 storeDimensionReport() 记录外部 Agent 提交的分析报告
 *
 * 生命周期: 与 Bootstrap 会话一致。
 * 持久化: 通过 saveCheckpoint / loadCheckpoint 实现断点续传。
 *
 * @module EpisodicMemory
 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '../../../../../infrastructure/logging/Logger.js';

// ──────────────────────────────────────────────────────────────
// 数据结构定义
// ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} DimensionReport
 * @property {string}   dimId              — 维度 ID
 * @property {number}   completedAt        — 完成时间戳
 * @property {string}   analysisText       — Analyst 分析全文
 * @property {Array<Finding>} findings     — 结构化发现列表
 * @property {string[]} referencedFiles    — 引用文件清单
 * @property {Array<CandidateSummary>} candidatesSummary — 候选产出汇总
 * @property {object|null} workingMemoryDistilled — WorkingMemory 蒸馏数据
 * @property {object|null} digest          — DimensionDigest (兼容旧格式)
 */

/**
 * @typedef {object} Finding
 * @property {string} finding     — 发现描述
 * @property {string} [evidence]  — 证据 (文件路径:行号)
 * @property {number} importance  — 重要性 1-10
 */

/**
 * @typedef {object} CandidateSummary
 * @property {string} dimId
 * @property {string} title
 * @property {string} subTopic
 * @property {string} summary
 */

/**
 * @typedef {object} CrossReference
 * @property {string} from    — 来源维度 ID
 * @property {string} to      — 目标维度 ID
 * @property {string} relation — 关系类型 (suggests/references/conflicts)
 * @property {string} detail   — 具体内容
 */

/**
 * @typedef {object} TierReflection
 * @property {number}   tierIndex
 * @property {string[]} completedDimensions
 * @property {Array<Finding>} topFindings
 * @property {string[]} crossDimensionPatterns
 * @property {string[]} suggestionsForNextTier
 */

// ──────────────────────────────────────────────────────────────
// EpisodicMemory 类
// ──────────────────────────────────────────────────────────────

export class EpisodicMemory {
  /** @type {Map<string, DimensionReport>} dimId → DimensionReport */
  #dimensionReports = new Map();

  /** @type {Map<string, Finding[]>} filePath → Evidence[] */
  #evidenceStore = new Map();

  /** @type {CrossReference[]} */
  #crossReferences = [];

  /** @type {TierReflection[]} */
  #tierReflections = [];

  /** @type {Map<string, CandidateSummary[]>} dimId → candidates */
  #submittedCandidates = new Map();

  /** @type {object} 项目上下文 (不变信息) */
  #projectContext;

  /** @type {import('../../../../../lib/infrastructure/logging/Logger.js').default} */
  #logger;

  /**
   * @param {object} projectContext - 项目基础信息
   * @param {string} projectContext.projectName
   * @param {string} projectContext.primaryLang
   * @param {number} projectContext.fileCount
   * @param {string[]} [projectContext.modules]
   * @param {object} [projectContext.depGraph]
   * @param {object} [projectContext.astMetrics]
   * @param {object} [projectContext.guardSummary]
   */
  constructor(projectContext = {}) {
    this.#projectContext = projectContext;
    this.#logger = Logger.getInstance();
  }

  // ─── 维度报告 (DimensionReport) ────────────────────────

  /**
   * 维度完成后存储完整报告
   *
   * @param {string} dimId
   * @param {object} report
   * @param {string} report.analysisText — Analyst 分析全文
   * @param {Array<Finding>} [report.findings] — 结构化发现
   * @param {string[]} [report.referencedFiles] — 引用文件
   * @param {Array<CandidateSummary>} [report.candidatesSummary] — 候选汇总
   * @param {object} [report.workingMemoryDistilled] — WorkingMemory 蒸馏
   * @param {object} [report.digest] — DimensionDigest (兼容)
   */
  storeDimensionReport(dimId, report) {
    this.#dimensionReports.set(dimId, {
      dimId,
      completedAt: Date.now(),
      analysisText: report.analysisText || '',
      findings: report.findings || [],
      referencedFiles: report.referencedFiles || [],
      candidatesSummary: report.candidatesSummary || [],
      workingMemoryDistilled: report.workingMemoryDistilled || null,
      digest: report.digest || null,
    });

    // 自动提取文件级 Evidence
    for (const f of report.findings || []) {
      if (f.evidence) {
        const filePath = f.evidence.split(':')[0]; // "file.m:123" → "file.m"
        this.addEvidence(filePath, {
          dimId,
          finding: f.finding,
          importance: f.importance,
        });
      }
    }

    // 从 digest 中提取 crossRefs
    if (report.digest?.crossRefs) {
      for (const [targetDim, detail] of Object.entries(report.digest.crossRefs)) {
        if (detail) {
          this.#crossReferences.push({
            from: dimId,
            to: targetDim,
            relation: 'suggests',
            detail: String(detail),
          });
        }
      }
    }

    this.#logger.info(
      `[EpisodicMemory] Stored report for "${dimId}": ` +
        `${report.findings?.length || 0} findings, ` +
        `${report.referencedFiles?.length || 0} files`
    );
  }

  /**
   * 获取维度报告
   * @param {string} dimId
   * @returns {DimensionReport|undefined}
   */
  getDimensionReport(dimId) {
    return this.#dimensionReports.get(dimId);
  }

  // ─── Evidence Store (文件→发现 映射) ───────────────────

  /**
   * 记录代码证据
   * @param {string} filePath
   * @param {object} evidence
   * @param {string} evidence.dimId
   * @param {string} evidence.finding
   * @param {number} [evidence.importance]
   */
  addEvidence(filePath, evidence) {
    if (!this.#evidenceStore.has(filePath)) {
      this.#evidenceStore.set(filePath, []);
    }
    this.#evidenceStore.get(filePath).push({
      ...evidence,
      timestamp: Date.now(),
    });
  }

  /**
   * 获取指定文件的所有证据
   * @param {string} filePath
   * @returns {Finding[]}
   */
  getEvidenceForFile(filePath) {
    return this.#evidenceStore.get(filePath) || [];
  }

  /**
   * 搜索证据 — 模糊匹配文件名和发现内容
   * @param {string} query
   * @param {string} [dimId] — 限定维度
   * @returns {Array<{filePath: string, evidence: object}>}
   */
  searchEvidence(query, dimId) {
    const results = [];
    const lowerQuery = query.toLowerCase();

    for (const [filePath, evidences] of this.#evidenceStore) {
      for (const ev of evidences) {
        if (dimId && ev.dimId !== dimId) {
          continue;
        }

        const matchesFile = filePath.toLowerCase().includes(lowerQuery);
        const matchesFinding = (ev.finding || '').toLowerCase().includes(lowerQuery);

        if (matchesFile || matchesFinding) {
          results.push({ filePath, evidence: ev });
        }
      }
    }

    return results.sort((a, b) => (b.evidence.importance || 5) - (a.evidence.importance || 5));
  }

  // ─── 已提交候选 (兼容 DimensionContext) ────────────────

  /**
   * 记录已提交的候选 (兼容 DimensionContext.addSubmittedCandidate)
   * @param {string} dimId
   * @param {CandidateSummary} candidate
   */
  addSubmittedCandidate(dimId, candidate) {
    if (!this.#submittedCandidates.has(dimId)) {
      this.#submittedCandidates.set(dimId, []);
    }
    this.#submittedCandidates.get(dimId).push({
      dimId,
      title: candidate.title || '',
      subTopic: candidate.subTopic || '',
      summary: candidate.summary || '',
    });
  }

  // ─── DimensionDigest 兼容层 ───────────────────────────

  /**
   * 添加维度摘要 (兼容 DimensionContext.addDimensionDigest)
   * 如果已有 DimensionReport 则合并 digest；否则创建最小 Report
   *
   * @param {string} dimId
   * @param {object} digest
   */
  addDimensionDigest(dimId, digest) {
    const existing = this.#dimensionReports.get(dimId);
    if (existing) {
      existing.digest = digest;
    } else {
      this.#dimensionReports.set(dimId, {
        dimId,
        completedAt: Date.now(),
        analysisText: digest.summary || '',
        findings: (digest.keyFindings || []).map((f) => ({
          finding: typeof f === 'string' ? f : f.finding || '',
          evidence: '',
          importance: 5,
        })),
        referencedFiles: [],
        candidatesSummary: [],
        workingMemoryDistilled: null,
        digest,
      });
    }

    // 提取 crossRefs
    if (digest.crossRefs) {
      for (const [targetDim, detail] of Object.entries(digest.crossRefs)) {
        if (detail) {
          // 避免重复
          const exists = this.#crossReferences.some(
            (cr) => cr.from === dimId && cr.to === targetDim
          );
          if (!exists) {
            this.#crossReferences.push({
              from: dimId,
              to: targetDim,
              relation: 'suggests',
              detail: String(detail),
            });
          }
        }
      }
    }
  }

  // ─── Tier Reflection ──────────────────────────────────

  /**
   * 添加 Tier 级 Reflection
   * @param {number} tierIndex
   * @param {TierReflection} reflection
   */
  addTierReflection(tierIndex, reflection) {
    this.#tierReflections.push(reflection);
    this.#logger.info(
      `[EpisodicMemory] Tier ${tierIndex + 1} reflection: ` +
        `${reflection.topFindings?.length || 0} top findings, ` +
        `${reflection.crossDimensionPatterns?.length || 0} patterns`
    );
  }

  /**
   * 获取与当前维度相关的 Tier Reflections
   * @param {string} currentDimId
   * @returns {string|null} - 格式化的 Markdown 文本
   */
  getRelevantReflections(currentDimId) {
    if (this.#tierReflections.length === 0) {
      return null;
    }

    const parts = [];
    for (const ref of this.#tierReflections) {
      parts.push(`### Tier ${ref.tierIndex + 1} 综合洞察`);

      if (ref.topFindings?.length > 0) {
        parts.push('**核心发现**:');
        for (const f of ref.topFindings.slice(0, 5)) {
          parts.push(`- [${f.importance || 5}/10] ${f.finding}`);
        }
      }

      if (ref.crossDimensionPatterns?.length > 0) {
        parts.push('**跨维度模式**:');
        for (const p of ref.crossDimensionPatterns) {
          parts.push(`- ${p}`);
        }
      }

      if (ref.suggestionsForNextTier?.length > 0) {
        parts.push('**对后续维度的建议**:');
        for (const s of ref.suggestionsForNextTier) {
          parts.push(`- ${s}`);
        }
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  // ─── 上下文构建 (核心: 替代 DimensionContext) ──────────

  /**
   * 构建给 Analyst 的跨维度上下文 (替代 DimensionContext.buildContextForDimension)
   *
   * 比 DimensionContext 更丰富:
   *   - 注入具体 findings (而非仅 summary)
   *   - 汇总已读文件清单 (避免重复读取)
   *   - 注入跨维度引用建议
   *   - 注入 Tier Reflection 洞察
   *
   * @param {string} currentDimId — 当前正在分析的维度 ID
   * @param {string[]} [focusAreas] — 当前维度的关注领域 (用于过滤相关发现)
   * @returns {string} Markdown 格式的上下文块
   */
  buildContextForDimension(currentDimId, focusAreas = []) {
    const parts = [];
    const completedDims = [...this.#dimensionReports.entries()].filter(
      ([id]) => id !== currentDimId
    );

    if (completedDims.length === 0 && this.#tierReflections.length === 0) {
      return '';
    }

    parts.push('## 前序维度分析成果（避免重复探索）');

    // §1: 前序维度的关键发现 (比 summary 更具体)
    for (const [dimId, report] of completedDims) {
      parts.push(`### ${dimId}`);

      // 摘要
      if (report.digest?.summary) {
        parts.push(report.digest.summary);
      } else if (report.analysisText) {
        parts.push(`${report.analysisText.substring(0, 300)}…`);
      }

      // 选择与当前维度相关的 findings
      const relevantFindings = this.#selectRelevantFindings(report.findings, focusAreas, 5);
      if (relevantFindings.length > 0) {
        parts.push('**具体发现**:');
        for (const f of relevantFindings) {
          let line = `- [${f.importance}/10] ${f.finding}`;
          if (f.evidence) {
            line += ` _(${f.evidence})_`;
          }
          parts.push(line);
        }
      }

      // 候选数量
      const candidates = this.#submittedCandidates.get(dimId) || [];
      if (candidates.length > 0) {
        parts.push(
          `已提交 ${candidates.length} 个候选: ${candidates.map((c) => c.title).join(', ')}`
        );
      }
    }

    // §2: 已读文件汇总 (帮助下游维度避免重复读取)
    const allReadFiles = new Set();
    for (const report of this.#dimensionReports.values()) {
      for (const f of report.referencedFiles) {
        allReadFiles.add(f);
      }
    }
    if (allReadFiles.size > 0) {
      parts.push(`### 前序维度已扫描的文件 (${allReadFiles.size} 个)`);
      const fileList = [...allReadFiles].slice(0, 30).join(', ');
      parts.push(fileList);
      if (allReadFiles.size > 30) {
        parts.push(`…还有 ${allReadFiles.size - 30} 个文件`);
      }
    }

    // §3: 跨维度引用建议
    const relevantCrossRefs = this.#crossReferences.filter((cr) => cr.to === currentDimId);
    if (relevantCrossRefs.length > 0) {
      parts.push(`### 其他维度对 ${currentDimId} 的建议`);
      for (const cr of relevantCrossRefs) {
        parts.push(`- [来自 ${cr.from}] ${cr.detail}`);
      }
    }

    // §4: Tier Reflection 洞察
    const reflections = this.getRelevantReflections(currentDimId);
    if (reflections) {
      parts.push(reflections);
    }

    return parts.join('\n');
  }

  /**
   * 兼容 DimensionContext.buildContextForDimension 返回格式
   * 返回 { previousDimensions, submittedCandidates } 对象
   *
   * @param {string} currentDimId
   * @returns {object}
   */
  buildContextSnapshot(currentDimId) {
    const previousDimensions = {};
    for (const [dimId, report] of this.#dimensionReports) {
      if (dimId === currentDimId) {
        continue;
      }
      previousDimensions[dimId] = report.digest || {
        summary: report.analysisText?.substring(0, 300) || '',
        candidateCount: report.candidatesSummary?.length || 0,
        keyFindings: report.findings?.map((f) => f.finding) || [],
        crossRefs: {},
        gaps: [],
      };
    }

    const submittedCandidates = [];
    for (const [, candidates] of this.#submittedCandidates) {
      submittedCandidates.push(...candidates);
    }

    return { previousDimensions, submittedCandidates };
  }

  // ─── 持久化 (断点续传) ────────────────────────────────

  /**
   * 保存到磁盘 (断点续传)
   * @param {string} projectRoot
   */
  async saveCheckpoint(projectRoot) {
    const checkpointDir = path.join(projectRoot, '.autosnippet', 'bootstrap-checkpoint');
    try {
      fs.mkdirSync(checkpointDir, { recursive: true });

      const data = {
        version: 1,
        savedAt: Date.now(),
        dimensionReports: Object.fromEntries(
          [...this.#dimensionReports].map(([k, v]) => [
            k,
            {
              ...v,
              // 不保存 analysisText 全文 (太大), 只保存 digest + findings
              analysisText: v.analysisText?.substring(0, 500) || '',
            },
          ])
        ),
        crossReferences: this.#crossReferences,
        tierReflections: this.#tierReflections,
        submittedCandidates: Object.fromEntries(this.#submittedCandidates),
        evidenceIndex: [...this.#evidenceStore.keys()],
      };

      fs.writeFileSync(
        path.join(checkpointDir, 'episodic-memory.json'),
        JSON.stringify(data, null, 2),
        'utf-8'
      );

      this.#logger.info(
        `[EpisodicMemory] Checkpoint saved: ${this.#dimensionReports.size} reports`
      );
    } catch (err) {
      this.#logger.warn(`[EpisodicMemory] Failed to save checkpoint: ${err.message}`);
    }
  }

  /**
   * 从磁盘加载 (断点恢复)
   * @param {string} projectRoot
   * @returns {boolean} 是否成功加载
   */
  async loadCheckpoint(projectRoot) {
    const checkpointPath = path.join(
      projectRoot,
      '.autosnippet',
      'bootstrap-checkpoint',
      'episodic-memory.json'
    );

    try {
      if (!fs.existsSync(checkpointPath)) {
        return false;
      }

      const raw = fs.readFileSync(checkpointPath, 'utf-8');
      const data = JSON.parse(raw);

      // 版本检查
      if (data.version !== 1) {
        this.#logger.warn(`[EpisodicMemory] Unsupported checkpoint version: ${data.version}`);
        return false;
      }

      // 有效期检查 (1 小时)
      if (Date.now() - data.savedAt > 3600_000) {
        this.#logger.info(`[EpisodicMemory] Checkpoint expired (>1h), ignoring`);
        return false;
      }

      // 恢复数据
      if (data.dimensionReports) {
        for (const [dimId, report] of Object.entries(data.dimensionReports)) {
          this.#dimensionReports.set(dimId, report);
        }
      }
      if (data.crossReferences) {
        this.#crossReferences = data.crossReferences;
      }
      if (data.tierReflections) {
        this.#tierReflections = data.tierReflections;
      }
      if (data.submittedCandidates) {
        for (const [dimId, candidates] of Object.entries(data.submittedCandidates)) {
          this.#submittedCandidates.set(dimId, candidates);
        }
      }

      this.#logger.info(
        `[EpisodicMemory] Checkpoint loaded: ${this.#dimensionReports.size} reports`
      );
      return true;
    } catch (err) {
      this.#logger.warn(`[EpisodicMemory] Failed to load checkpoint: ${err.message}`);
      return false;
    }
  }

  // ─── 序列化 (兼容 DimensionContext.toJSON/fromJSON) ────

  /**
   * 序列化为 JSON
   * @returns {object}
   */
  toJSON() {
    return {
      dimensionReports: Object.fromEntries(this.#dimensionReports),
      crossReferences: this.#crossReferences,
      tierReflections: this.#tierReflections,
      submittedCandidates: Object.fromEntries(this.#submittedCandidates),
      projectContext: this.#projectContext,
    };
  }

  /**
   * 从 JSON 恢复
   * @param {object} json
   * @returns {EpisodicMemory}
   */
  static fromJSON(json) {
    const em = new EpisodicMemory(json.projectContext || {});
    if (json.dimensionReports) {
      for (const [k, v] of Object.entries(json.dimensionReports)) {
        em.#dimensionReports.set(k, v);
      }
    }
    if (json.crossReferences) {
      em.#crossReferences = json.crossReferences;
    }
    if (json.tierReflections) {
      em.#tierReflections = json.tierReflections;
    }
    if (json.submittedCandidates) {
      for (const [k, v] of Object.entries(json.submittedCandidates)) {
        em.#submittedCandidates.set(k, v);
      }
    }
    return em;
  }

  // ─── 统计 ─────────────────────────────────────────────

  /**
   * 获取已完成的维度列表
   * @returns {string[]}
   */
  getCompletedDimensions() {
    return [...this.#dimensionReports.keys()];
  }

  /**
   * 获取所有已引用文件 (去重)
   * @returns {Set<string>}
   */
  getAllReferencedFiles() {
    const files = new Set();
    for (const report of this.#dimensionReports.values()) {
      for (const f of report.referencedFiles) {
        files.add(f);
      }
    }
    return files;
  }

  /**
   * 获取统计数据
   * @returns {object}
   */
  getStats() {
    const totalFindings = [...this.#dimensionReports.values()].reduce(
      (sum, r) => sum + r.findings.length,
      0
    );
    const totalEvidence = [...this.#evidenceStore.values()].reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    const totalCandidates = [...this.#submittedCandidates.values()].reduce(
      (sum, arr) => sum + arr.length,
      0
    );

    return {
      completedDimensions: this.#dimensionReports.size,
      totalFindings,
      totalEvidence,
      totalCandidates,
      crossReferences: this.#crossReferences.length,
      tierReflections: this.#tierReflections.length,
      referencedFiles: this.getAllReferencedFiles().size,
    };
  }

  // ─── 内部 ─────────────────────────────────────────────

  /**
   * 从 findings 中选择与当前焦点最相关的
   * @param {Finding[]} findings
   * @param {string[]} focusAreas
   * @param {number} limit
   * @returns {Finding[]}
   */
  #selectRelevantFindings(findings, focusAreas, limit) {
    if (!findings || findings.length === 0) {
      return [];
    }

    if (!focusAreas || focusAreas.length === 0) {
      // 无焦点领域: 按重要性排序
      return [...findings]
        .sort((a, b) => (b.importance || 5) - (a.importance || 5))
        .slice(0, limit);
    }

    // 有焦点领域: 综合重要性 + 关键词匹配
    return [...findings]
      .map((f) => {
        const relevance = focusAreas.some((area) =>
          (f.finding || '').toLowerCase().includes(area.toLowerCase())
        )
          ? 1
          : 0;
        return { ...f, _score: relevance * 10 + (f.importance || 5) };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, limit)
      .map(({ _score, ...rest }) => rest); // 移除临时 _score
  }
}

export default EpisodicMemory;
