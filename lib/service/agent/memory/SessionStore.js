/**
 * SessionStore — Bootstrap 会话级存储 (合并 EpisodicMemory + ToolResultCache)
 *
 * 设计来源: docs/copilot/memory-system-redesign.md §4.4, §6.3
 *
 * 内部子系统:
 *   1. DimensionReports — 跨维度分析报告 + 结构化证据 + 交叉引用 (from EpisodicMemory)
 *   2. ReadOnlyCache — 只读工具结果缓存 (from ToolResultCache, 排除副作用工具 B3 fix)
 *
 * 替代关系:
 *   EpisodicMemory.js → 全部维度报告/证据/反思逻辑
 *   ToolResultCache.js → LRU 缓存逻辑 (仅只读工具)
 *
 * 新增能力 (vs 原模块):
 *   - getDistilledForProducer(dimId): Producer 专用蒸馏上下文 (B2 fix)
 *   - NON_CACHEABLE 内置: 副作用工具自动排除 (B3 fix)
 *   - buildContextForDimension 增强: 消费 workingMemoryDistilled (B1 fix, 已在 EpisodicMemory 修复)
 *   - 统一的 getStats(): 合并维度 + 缓存统计
 *
 * 生命周期: 与 Bootstrap 会话一致。
 * 持久化: 通过 saveCheckpoint / loadCheckpoint 实现断点续传。
 *
 * @module SessionStore
 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '../../../infrastructure/logging/Logger.js';
import { CACHE } from '../../../shared/constants.js';

// ── 常量 ──

/** 副作用工具 — 不缓存结果 (B3 fix) */
const NON_CACHEABLE = new Set([
  'submit_knowledge',
  'submit_with_check',
  'note_finding',
  'get_previous_analysis',
  'get_previous_evidence',
]);

/** 缓存上限 */
const MAX_FILE_CACHE = CACHE.MAX_FILE_ENTRIES;
const MAX_SEARCH_CACHE = CACHE.MAX_SEARCH_ENTRIES;
const DEFAULT_TTL_MS = CACHE.DEFAULT_TTL_MS;

// ── 类型定义 ──

/**
 * @typedef {object} DimensionReport
 * @property {string}   dimId
 * @property {number}   completedAt
 * @property {string}   analysisText
 * @property {Array<Finding>} findings
 * @property {string[]} referencedFiles
 * @property {Array<CandidateSummary>} candidatesSummary
 * @property {object|null} workingMemoryDistilled
 * @property {object|null} digest
 */

/**
 * @typedef {object} Finding
 * @property {string} finding
 * @property {string} [evidence]
 * @property {number} importance
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
 * @property {string} from
 * @property {string} to
 * @property {string} relation
 * @property {string} detail
 */

/**
 * @typedef {object} TierReflection
 * @property {number}   tierIndex
 * @property {string[]} completedDimensions
 * @property {Array<Finding>} topFindings
 * @property {string[]} crossDimensionPatterns
 * @property {string[]} suggestionsForNextTier
 */

// ═══════════════════════════════════════════════════════════
export class SessionStore {
  // ── 子系统 1: DimensionReports (from EpisodicMemory) ──
  /** @type {Map<string, DimensionReport>} */
  #dimensionReports = new Map();
  /** @type {Map<string, Finding[]>} filePath → Evidence[] */
  #evidenceStore = new Map();
  /** @type {CrossReference[]} */
  #crossReferences = [];
  /** @type {TierReflection[]} */
  #tierReflections = [];
  /** @type {Map<string, CandidateSummary[]>} dimId → candidates */
  #submittedCandidates = new Map();
  /** @type {object} */
  #projectContext;

  // ── 子系统 2: ReadOnlyCache (from ToolResultCache) ──
  /** @type {Map<string, {result: any, cachedAt: number, hitCount: number}>} */
  #searchCache = new Map();
  /** @type {Map<string, {content: string, cachedAt: number, hitCount: number}>} */
  #fileCache = new Map();
  /** @type {{hits: number, misses: number, evictions: number}} */
  #cacheStats = { hits: 0, misses: 0, evictions: 0 };
  /** @type {number} */
  #ttlMs;
  /** @type {ReturnType<typeof setInterval>|null} */
  #cleanupTimer = null;

  /** @type {import('../../../infrastructure/logging/Logger.js').default} */
  #logger;

  /**
   * @param {object} [config]
   * @param {object} [config.projectContext] - 项目基础信息
   * @param {number} [config.ttlMs] - 缓存 TTL（毫秒）
   * @param {number} [config.cleanupIntervalMs] - 清理周期
   */
  constructor(config = {}) {
    this.#projectContext = config.projectContext || {};
    this.#ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.#logger = Logger.getInstance();

    // 定期清理过期缓存条目
    const cleanupInterval = config.cleanupIntervalMs ?? 5 * 60 * 1000;
    if (this.#ttlMs > 0 && cleanupInterval > 0) {
      this.#cleanupTimer = setInterval(() => this.#evictExpired(), cleanupInterval);
      if (this.#cleanupTimer.unref) {
        this.#cleanupTimer.unref();
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // §1: 维度报告 (from EpisodicMemory)
  // ═══════════════════════════════════════════════════════

  /**
   * 维度完成后存储完整报告
   * @param {string} dimId
   * @param {object} report
   */
  storeDimensionReport(dimId, report) {
    // findings 统一形状: { finding: string, evidence: string, importance: number }
    // P0 Fix: evidence 可能是 array/object，强制 string
    const findings = (report.findings || []).map((f) => ({
      finding: f.finding || '',
      evidence: typeof f.evidence === 'string' ? f.evidence : Array.isArray(f.evidence) ? f.evidence.join(', ') : f.evidence ? String(f.evidence) : '',
      importance: f.importance || 5,
    }));

    this.#dimensionReports.set(dimId, {
      dimId,
      completedAt: Date.now(),
      analysisText: report.analysisText || '',
      findings,
      referencedFiles: report.referencedFiles || [],
      candidatesSummary: report.candidatesSummary || [],
      workingMemoryDistilled: report.workingMemoryDistilled || null,
      digest: report.digest || null,
    });

    // 自动提取文件级 Evidence
    for (const f of findings) {
      if (f.evidence) {
        const ev = typeof f.evidence === 'string' ? f.evidence : String(f.evidence);
        const filePath = ev.split(':')[0];
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
      `[SessionStore] Stored report for "${dimId}": ` +
        `${report.findings?.length || 0} findings, ` +
        `${report.referencedFiles?.length || 0} files`
    );
  }

  /**
   * @param {string} dimId
   * @returns {DimensionReport|undefined}
   */
  getDimensionReport(dimId) {
    return this.#dimensionReports.get(dimId);
  }

  /**
   * @returns {string[]}
   */
  getCompletedDimensions() {
    return [...this.#dimensionReports.keys()];
  }

  // ═══════════════════════════════════════════════════════
  // §2: Evidence Store
  // ═══════════════════════════════════════════════════════

  /**
   * @param {string} filePath
   * @param {object} evidence
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
   * @param {string} filePath
   * @returns {Finding[]}
   */
  getEvidenceForFile(filePath) {
    return this.#evidenceStore.get(filePath) || [];
  }

  /**
   * @param {string} query
   * @param {string} [dimId]
   * @returns {Array<{filePath: string, evidence: object}>}
   */
  searchEvidence(query, dimId) {
    const results = [];
    const lowerQuery = query.toLowerCase();
    for (const [filePath, evidences] of this.#evidenceStore) {
      for (const ev of evidences) {
        if (dimId && ev.dimId !== dimId) continue;
        const matchesFile = filePath.toLowerCase().includes(lowerQuery);
        const matchesFinding = (ev.finding || '').toLowerCase().includes(lowerQuery);
        if (matchesFile || matchesFinding) {
          results.push({ filePath, evidence: ev });
        }
      }
    }
    return results.sort((a, b) => (b.evidence.importance || 5) - (a.evidence.importance || 5));
  }

  // ═══════════════════════════════════════════════════════
  // §3: 已提交候选
  // ═══════════════════════════════════════════════════════

  /**
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

  // ═══════════════════════════════════════════════════════
  // §4: DimensionDigest 兼容层
  // ═══════════════════════════════════════════════════════

  /**
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

  // ═══════════════════════════════════════════════════════
  // §5: Tier Reflection
  // ═══════════════════════════════════════════════════════

  /**
   * @param {number} tierIndex
   * @param {TierReflection} reflection
   */
  addTierReflection(tierIndex, reflection) {
    this.#tierReflections.push(reflection);
    this.#logger.info(
      `[SessionStore] Tier ${tierIndex + 1} reflection: ` +
        `${reflection.topFindings?.length || 0} top findings, ` +
        `${reflection.crossDimensionPatterns?.length || 0} patterns`
    );
  }

  /**
   * 获取所有 TierReflection (F17: EpisodicConsolidator 需要)
   * @returns {TierReflection[]}
   */
  getTierReflections() {
    return [...this.#tierReflections];
  }

  /**
   * @param {string} currentDimId
   * @returns {string|null}
   */
  getRelevantReflections(currentDimId) {
    if (this.#tierReflections.length === 0) return null;
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
        for (const p of ref.crossDimensionPatterns) parts.push(`- ${p}`);
      }
      if (ref.suggestionsForNextTier?.length > 0) {
        parts.push('**对后续维度的建议**:');
        for (const s of ref.suggestionsForNextTier) parts.push(`- ${s}`);
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  // ═══════════════════════════════════════════════════════
  // §6: 上下文构建 (核心: 替代 DimensionContext)
  // ═══════════════════════════════════════════════════════

  /**
   * 构建给 Analyst 的跨维度上下文
   *
   * @param {string} currentDimId
   * @param {string[]|object} [focusKeywordsOrOpts] — 关键词数组或 options 对象
   * @returns {string}
   */
  buildContextForDimension(currentDimId, focusKeywordsOrOpts = []) {
    // 兼容两种调用方式: (dimId, keywords[]) 或 (dimId, { focusKeywords, tokenBudget })
    let focusKeywords = [];
    let tokenBudget = Infinity;
    if (Array.isArray(focusKeywordsOrOpts)) {
      focusKeywords = focusKeywordsOrOpts;
    } else if (typeof focusKeywordsOrOpts === 'object') {
      focusKeywords = focusKeywordsOrOpts.focusKeywords || [];
      tokenBudget = focusKeywordsOrOpts.tokenBudget || Infinity;
    }

    const parts = [];
    const completedDims = [...this.#dimensionReports.entries()].filter(
      ([id]) => id !== currentDimId
    );

    if (completedDims.length === 0 && this.#tierReflections.length === 0) return '';

    parts.push('## 前序维度分析成果（避免重复探索）');

    // §1: 前序维度的关键发现
    for (const [dimId, report] of completedDims) {
      parts.push(`### ${dimId}`);

      if (report.digest?.summary) {
        parts.push(report.digest.summary);
      } else if (report.analysisText) {
        parts.push(`${report.analysisText.substring(0, 300)}…`);
      }

      // B1 fix: 优先 findings，为空时从 workingMemoryDistilled 补充
      let findings = report.findings;
      if ((!findings || findings.length === 0) && report.workingMemoryDistilled?.keyFindings) {
        findings = report.workingMemoryDistilled.keyFindings.map((f) => ({
          finding: f.finding || '',
          evidence: f.evidence || '',
          importance: f.importance || 5,
        }));
      }

      const relevantFindings = this.#selectRelevantFindings(findings, focusKeywords, 5);
      if (relevantFindings.length > 0) {
        parts.push('**具体发现**:');
        for (const f of relevantFindings) {
          let line = `- [${f.importance}/10] ${f.finding}`;
          if (f.evidence) line += ` _(${f.evidence})_`;
          parts.push(line);
        }
      }

      const candidates = this.#submittedCandidates.get(dimId) || [];
      if (candidates.length > 0) {
        parts.push(
          `已提交 ${candidates.length} 个候选: ${candidates.map((c) => c.title).join(', ')}`
        );
      }
    }

    // §2: 已读文件汇总
    const allReadFiles = this.getAllReferencedFiles();
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

    // §4: Tier Reflection
    const reflections = this.getRelevantReflections(currentDimId);
    if (reflections) parts.push(reflections);

    // Token 预算裁剪
    let result = parts.join('\n');
    if (tokenBudget < Infinity) {
      const estimatedTokens = Math.ceil(result.length / 4);
      if (estimatedTokens > tokenBudget) {
        // 粗略裁剪
        const maxChars = tokenBudget * 4;
        result = result.substring(0, maxChars) + '\n…(truncated due to budget)';
      }
    }

    return result;
  }

  /**
   * 兼容 DimensionContext.buildContextForDimension 返回格式
   * @param {string} currentDimId
   * @returns {object}
   */
  buildContextSnapshot(currentDimId) {
    const previousDimensions = {};
    for (const [dimId, report] of this.#dimensionReports) {
      if (dimId === currentDimId) continue;
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

  // ═══════════════════════════════════════════════════════
  // §7: 蒸馏上下文 (for PipelineStrategy produce 阶段)
  // ═══════════════════════════════════════════════════════

  /**
   * 获取维度的蒸馏上下文 (供 Producer 使用)
   * @param {string} dimId
   * @returns {{ keyFindings: Array, toolCallSummary: Array, referencedFiles: string[] }|null}
   */
  getDistilledForProducer(dimId) {
    const report = this.#dimensionReports.get(dimId);
    if (!report) return null;

    return {
      keyFindings: report.workingMemoryDistilled?.keyFindings || [],
      toolCallSummary: report.workingMemoryDistilled?.toolCallSummary || [],
      referencedFiles: report.referencedFiles || [],
    };
  }

  // ═══════════════════════════════════════════════════════
  // §8: 只读缓存 (from ToolResultCache, B3 fix)
  // ═══════════════════════════════════════════════════════

  /**
   * 获取缓存的工具结果
   * @param {string} toolName
   * @param {object} args
   * @returns {*|null}
   */
  getCachedResult(toolName, args) {
    if (NON_CACHEABLE.has(toolName)) return null;

    if (toolName === 'search_project_code') {
      const pattern = args?.pattern || '';
      if (pattern) {
        const entry = this.#searchCache.get(pattern);
        if (entry) {
          if (this.#ttlMs > 0 && Date.now() - entry.cachedAt > this.#ttlMs) {
            this.#searchCache.delete(pattern);
            this.#cacheStats.evictions++;
            this.#cacheStats.misses++;
            return null;
          }
          entry.hitCount++;
          this.#cacheStats.hits++;
          return entry.result;
        }
      }
    }
    if (toolName === 'read_project_file') {
      const filePath = args?.filePath || '';
      if (filePath) {
        const entry = this.#fileCache.get(filePath);
        if (entry) {
          if (this.#ttlMs > 0 && Date.now() - entry.cachedAt > this.#ttlMs) {
            this.#fileCache.delete(filePath);
            this.#cacheStats.evictions++;
            this.#cacheStats.misses++;
            return null;
          }
          entry.hitCount++;
          this.#cacheStats.hits++;
          return { content: entry.content, path: filePath, cached: true };
        }
      }
    }
    this.#cacheStats.misses++;
    return null;
  }

  /**
   * 缓存工具结果 (自动排除副作用工具)
   * @param {string} toolName
   * @param {object} args
   * @param {*} result
   */
  cacheToolResult(toolName, args, result) {
    if (NON_CACHEABLE.has(toolName)) return;

    if (toolName === 'search_project_code') {
      const pattern = args?.pattern || '';
      if (pattern) {
        if (this.#searchCache.size >= MAX_SEARCH_CACHE) {
          const oldestKey = this.#searchCache.keys().next().value;
          this.#searchCache.delete(oldestKey);
        }
        this.#searchCache.set(pattern, { result, cachedAt: Date.now(), hitCount: 0 });
      }
    }
    if (toolName === 'read_project_file') {
      const filePath = args?.filePath || '';
      const content = typeof result === 'object' ? result.content : String(result);
      if (filePath && content) {
        if (this.#fileCache.size >= MAX_FILE_CACHE) {
          const oldestKey = this.#fileCache.keys().next().value;
          this.#fileCache.delete(oldestKey);
        }
        this.#fileCache.set(filePath, { content, cachedAt: Date.now(), hitCount: 0 });
      }
    }
  }

  /**
   * 兼容 ToolResultCache.get()
   * @param {string} toolName
   * @param {object} args
   * @returns {*|null}
   */
  get(toolName, args) {
    return this.getCachedResult(toolName, args);
  }

  /**
   * 兼容 ToolResultCache.set()
   * @param {string} toolName
   * @param {object} args
   * @param {*} result
   */
  set(toolName, args, result) {
    this.cacheToolResult(toolName, args, result);
  }

  // ═══════════════════════════════════════════════════════
  // §9: 持久化 (断点续传)
  // ═══════════════════════════════════════════════════════

  /**
   * @param {string} projectRoot
   */
  async saveCheckpoint(projectRoot) {
    const checkpointDir = path.join(projectRoot, '.autosnippet', 'bootstrap-checkpoint');
    try {
      fs.mkdirSync(checkpointDir, { recursive: true });
      const data = {
        version: 2,
        savedAt: Date.now(),
        dimensionReports: Object.fromEntries(
          [...this.#dimensionReports].map(([k, v]) => [
            k,
            {
              ...v,
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
        path.join(checkpointDir, 'session-store.json'),
        JSON.stringify(data, null, 2),
        'utf-8'
      );
      this.#logger.info(
        `[SessionStore] Checkpoint saved: ${this.#dimensionReports.size} reports`
      );
    } catch (err) {
      this.#logger.warn(`[SessionStore] Failed to save checkpoint: ${err.message}`);
    }
  }

  /**
   * @param {string} projectRoot
   * @returns {boolean}
   */
  async loadCheckpoint(projectRoot) {
    // Try new format first, then legacy
    const newPath = path.join(projectRoot, '.autosnippet', 'bootstrap-checkpoint', 'session-store.json');
    const legacyPath = path.join(projectRoot, '.autosnippet', 'bootstrap-checkpoint', 'episodic-memory.json');
    const checkpointPath = fs.existsSync(newPath) ? newPath : legacyPath;

    try {
      if (!fs.existsSync(checkpointPath)) return false;

      const raw = fs.readFileSync(checkpointPath, 'utf-8');
      const data = JSON.parse(raw);

      if (data.version !== 1 && data.version !== 2) {
        this.#logger.warn(`[SessionStore] Unsupported checkpoint version: ${data.version}`);
        return false;
      }
      if (Date.now() - data.savedAt > 3600_000) {
        this.#logger.info(`[SessionStore] Checkpoint expired (>1h), ignoring`);
        return false;
      }

      if (data.dimensionReports) {
        for (const [dimId, report] of Object.entries(data.dimensionReports)) {
          this.#dimensionReports.set(dimId, report);
        }
      }
      if (data.crossReferences) this.#crossReferences = data.crossReferences;
      if (data.tierReflections) this.#tierReflections = data.tierReflections;
      if (data.submittedCandidates) {
        for (const [dimId, candidates] of Object.entries(data.submittedCandidates)) {
          this.#submittedCandidates.set(dimId, candidates);
        }
      }

      this.#logger.info(
        `[SessionStore] Checkpoint loaded: ${this.#dimensionReports.size} reports`
      );
      return true;
    } catch (err) {
      this.#logger.warn(`[SessionStore] Failed to load checkpoint: ${err.message}`);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════
  // §10: 序列化
  // ═══════════════════════════════════════════════════════

  toJSON() {
    return {
      dimensionReports: Object.fromEntries(this.#dimensionReports),
      crossReferences: this.#crossReferences,
      tierReflections: this.#tierReflections,
      submittedCandidates: Object.fromEntries(this.#submittedCandidates),
      projectContext: this.#projectContext,
    };
  }

  static fromJSON(json) {
    const store = new SessionStore({ projectContext: json.projectContext || {} });
    if (json.dimensionReports) {
      for (const [k, v] of Object.entries(json.dimensionReports)) {
        store.#dimensionReports.set(k, v);
      }
    }
    if (json.crossReferences) store.#crossReferences = json.crossReferences;
    if (json.tierReflections) store.#tierReflections = json.tierReflections;
    if (json.submittedCandidates) {
      for (const [k, v] of Object.entries(json.submittedCandidates)) {
        store.#submittedCandidates.set(k, v);
      }
    }
    return store;
  }

  // ═══════════════════════════════════════════════════════
  // §11: 统计 + 查询
  // ═══════════════════════════════════════════════════════

  /**
   * 获取所有已引用文件 (去重, F10)
   * @returns {Set<string>}
   */
  getAllReferencedFiles() {
    const files = new Set();
    for (const report of this.#dimensionReports.values()) {
      for (const f of report.referencedFiles) files.add(f);
    }
    return files;
  }

  /**
   * 获取统计数据 (合并维度 + 缓存统计, F12)
   * @returns {object}
   */
  getStats() {
    const totalFindings = [...this.#dimensionReports.values()].reduce(
      (sum, r) => sum + r.findings.length, 0
    );
    const totalEvidence = [...this.#evidenceStore.values()].reduce(
      (sum, arr) => sum + arr.length, 0
    );
    const totalCandidates = [...this.#submittedCandidates.values()].reduce(
      (sum, arr) => sum + arr.length, 0
    );
    const { hits, misses } = this.#cacheStats;
    return {
      completedDimensions: this.#dimensionReports.size,
      totalFindings,
      totalEvidence,
      totalCandidates,
      crossReferences: this.#crossReferences.length,
      tierReflections: this.#tierReflections.length,
      referencedFiles: this.getAllReferencedFiles().size,
      cache: {
        ...this.#cacheStats,
        hitRate: hits + misses > 0
          ? `${((hits / (hits + misses)) * 100).toFixed(1)}%`
          : '0%',
        searchCacheSize: this.#searchCache.size,
        fileCacheSize: this.#fileCache.size,
      },
    };
  }

  // ═══════════════════════════════════════════════════════
  // §12: 清理
  // ═══════════════════════════════════════════════════════

  /**
   * 清空所有缓存
   */
  clearCache() {
    this.#searchCache.clear();
    this.#fileCache.clear();
    this.#cacheStats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * 销毁实例，释放定时器
   */
  dispose() {
    this.clearCache();
    this.#dimensionReports.clear();
    this.#evidenceStore.clear();
    this.#crossReferences.length = 0;
    this.#tierReflections.length = 0;
    this.#submittedCandidates.clear();
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════
  // 私有方法
  // ═══════════════════════════════════════════════════════

  /**
   * 从 findings 中选择与当前焦点最相关的
   */
  #selectRelevantFindings(findings, focusKeywords, limit) {
    if (!findings || findings.length === 0) return [];

    if (!focusKeywords || focusKeywords.length === 0) {
      return [...findings]
        .sort((a, b) => (b.importance || 5) - (a.importance || 5))
        .slice(0, limit);
    }

    return [...findings]
      .map((f) => {
        const relevance = focusKeywords.some((kw) =>
          (f.finding || '').toLowerCase().includes(kw.toLowerCase())
        ) ? 1 : 0;
        return { ...f, _score: relevance * 10 + (f.importance || 5) };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, limit)
      .map(({ _score, ...rest }) => rest);
  }

  /**
   * 清理过期缓存条目 (F13)
   */
  #evictExpired() {
    if (this.#ttlMs <= 0) return;
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.#searchCache) {
      if (now - entry.cachedAt > this.#ttlMs) {
        this.#searchCache.delete(key);
        evicted++;
      }
    }
    for (const [key, entry] of this.#fileCache) {
      if (now - entry.cachedAt > this.#ttlMs) {
        this.#fileCache.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.#cacheStats.evictions += evicted;
      this.#logger.debug(`[SessionStore] evicted ${evicted} expired cache entries`);
    }
  }
}

export default SessionStore;
