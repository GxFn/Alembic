/**
 * BootstrapSession — 外部 Agent 驱动的 Bootstrap 会话状态管理
 *
 * 跨多次 MCP 调用保持状态（进程生命周期内有效）。
 * 通过 ServiceContainer 单例注册，每个项目同时只有一个 active session。
 *
 * 职责：
 *   - 维度完成状态跟踪
 *   - Phase 缓存（供 wiki_plan 复用）
 *   - EpisodicMemory 管理
 *   - Cross-dimension hints 收集与分发
 *   - 进度查询
 *   - Session 过期与恢复
 *
 * @module bootstrap/BootstrapSession
 */

import crypto from 'node:crypto';
import { SessionStore } from '#agent/memory/SessionStore.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import type { SessionCacheShape } from '#types/snapshot-views.js';
import type { DimensionQualityReport } from './ExternalSubmissionTracker.js';
import { ExternalSubmissionTracker } from './ExternalSubmissionTracker.js';

// ── 本地类型定义 ─────────────────────────────────────────────

/** Bootstrap 会话构造参数 */
interface BootstrapSessionOpts {
  projectRoot: string;
  dimensions: DimensionDef[];
  projectContext?: Record<string, unknown>;
}

/** 维度完成报告 */
interface DimensionReport {
  analysisText?: string;
  findings?: string[];
  keyFindings?: string[];
  referencedFiles?: string[];
  recipeIds?: string[];
  candidateCount?: number;
  [key: string]: unknown;
}

/** 维度完成记录（带时间戳） */
interface DimensionCompletion extends DimensionReport {
  completedAt: number;
}

/** 跨维度 hint 条目 */
interface CrossDimensionHint {
  fromDim: string;
  hint: string;
}

// ── 常量 ────────────────────────────────────────────────────

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时

// ── BootstrapSession ────────────────────────────────────────

export class BootstrapSession {
  expiresAt: number;
  id: string;
  projectRoot: string;
  startedAt: number;
  _activeSession: BootstrapSession | null;
  completedDimensions: Map<string, DimensionCompletion>;
  crossDimensionHints: Record<string, CrossDimensionHint[]>;
  dimensions: DimensionDef[];
  snapshotCache: SessionCacheShape | null;
  sessionStore: SessionStore;
  submissionTracker: ExternalSubmissionTracker;
  /**
   * @param opts.projectRoot 项目根目录
   * @param opts.dimensions 激活的维度定义列表
   * @param [opts.projectContext] 传给 EpisodicMemory 的项目元数据
   */
  constructor({ projectRoot, dimensions, projectContext = {} }: BootstrapSessionOpts) {
    this.id = `bs-${crypto.randomUUID()}`;
    this.projectRoot = projectRoot;
    this.dimensions = dimensions;
    this.completedDimensions = new Map<string, DimensionCompletion>(); // dimId → { report, completedAt, recipeIds }
    this.sessionStore = new SessionStore(projectContext);

    /** 外部 Agent 提交追踪 (v2: 对标内部 Agent 的 EvidenceCollector) */
    this.submissionTracker = new ExternalSubmissionTracker();

    /** Phase 1-4 分析结果缓存，供 wiki_plan 复用 */
    this.snapshotCache = null;

    /** 跨维度 hints 收集 */
    this.crossDimensionHints = {}; // targetDimId → [{ fromDim, hint }]

    this._activeSession = null;

    this.startedAt = Date.now();
    this.expiresAt = Date.now() + SESSION_TTL_MS;
  }

  // ── 状态查询 ──────────────────────────────────────────────

  get isExpired() {
    return Date.now() > this.expiresAt;
  }

  get isComplete() {
    return this.completedDimensions.size >= this.dimensions.length;
  }

  getProgress() {
    return {
      completed: this.completedDimensions.size,
      total: this.dimensions.length,
      completedDimIds: [...this.completedDimensions.keys()],
      remainingDimIds: this.dimensions
        .map((d: DimensionDef) => d.id)
        .filter((id: string) => !this.completedDimensions.has(id)),
    };
  }

  /** 检查某个维度是否已完成 */
  isDimensionComplete(dimId: string): boolean {
    return this.completedDimensions.has(dimId);
  }

  // ── 维度完成 ──────────────────────────────────────────────

  /**
   * 标记维度完成
   * @param report { analysisText, findings, referencedFiles, recipeIds, candidateCount }
   * @returns } - updated=true 表示覆盖了已有记录
   */
  markDimensionComplete(
    dimId: string,
    report: DimensionReport
  ): { updated: boolean; qualityReport: DimensionQualityReport } {
    const updated = this.completedDimensions.has(dimId);

    this.completedDimensions.set(dimId, {
      ...report,
      completedAt: Date.now(),
    });

    // 写入 SessionStore
    // keyFindings 是字符串数组，需转换为 SessionStore 期望的 { finding, importance } 格式
    this.sessionStore.storeDimensionReport(dimId, {
      analysisText: report.analysisText,
      findings: (report.keyFindings || []).map((f: string) => ({ finding: f, importance: 7 })),
      referencedFiles: report.referencedFiles || [],
      candidatesSummary: [],
    });

    // v2: 从 analysisText 提取负空间信号并计算质量报告
    this.submissionTracker.extractNegativeSignals(report.analysisText || '', dimId);
    const qualityReport = this.submissionTracker.buildQualityReport(
      dimId,
      report.analysisText,
      report.referencedFiles || []
    );

    return { updated, qualityReport };
  }

  // ── Cross-Dimension Hints ─────────────────────────────────

  /**
   * 存储跨维度 hints
   * @param fromDimId 来源维度
   * @param hints { targetDimId: hintText }
   */
  storeHints(
    fromDimId: string,
    hints: Record<string, string> | Record<string, unknown> | null | undefined
  ) {
    if (!hints || typeof hints !== 'object') {
      return;
    }

    for (const [targetDim, hintText] of Object.entries(hints)) {
      if (!this.crossDimensionHints[targetDim]) {
        this.crossDimensionHints[targetDim] = [];
      }
      // 去重：同源维度只保留最新 hint
      this.crossDimensionHints[targetDim] = this.crossDimensionHints[targetDim].filter(
        (h: CrossDimensionHint) => h.fromDim !== fromDimId
      );
      this.crossDimensionHints[targetDim].push({
        fromDim: fromDimId,
        hint: String(hintText),
      });
    }
  }

  /**
   * 收集与剩余维度相关的 accumulated hints
   * @returns >>}
   */
  getAccumulatedHints() {
    const progress = this.getProgress();
    const accumulated: Record<string, CrossDimensionHint[]> = {};

    for (const remainingDim of progress.remainingDimIds) {
      const hints = this.crossDimensionHints[remainingDim];
      if (hints?.length > 0) {
        accumulated[remainingDim] = hints;
      }
    }

    return accumulated;
  }

  // ── Snapshot 缓存 ──────────────────────────────────────────

  /**
   * 缓存 Phase 1-4 分析结果（ProjectSnapshot 的 session cache 形式）
   * @param cache toSessionCache(snapshot) 的返回值
   */
  setSnapshotCache(cache: SessionCacheShape | null) {
    this.snapshotCache = cache;
  }

  /** 获取 Snapshot 缓存（wiki_plan / dimension-complete 复用） */
  getSnapshotCache() {
    return this.snapshotCache;
  }

  // ── 序列化 ────────────────────────────────────────────────

  toJSON() {
    return {
      id: this.id,
      projectRoot: this.projectRoot,
      startedAt: this.startedAt,
      expiresAt: this.expiresAt,
      progress: this.getProgress(),
      dimensionCount: this.dimensions.length,
    };
  }
}

// ── Session 管理器（进程级单例）──────────────────────────────

/**
 * BootstrapSessionManager — 管理 active session
 *
 * 设计为进程级单例，通过 ServiceContainer 注册。
 * 同时只有一个 active session（单项目场景）。
 */
export class BootstrapSessionManager {
  _activeSession: BootstrapSession | null;
  constructor() {
    this._activeSession = null;
  }

  /**
   * 创建新的 bootstrap session
   * @param opts 传给 BootstrapSession 构造函数的参数
   */
  createSession(opts: BootstrapSessionOpts): BootstrapSession {
    // 如果有旧的未过期 session，先标记过期
    if (this._activeSession && !this._activeSession.isExpired) {
      this._activeSession.expiresAt = Date.now(); // 强制过期
    }
    this._activeSession = new BootstrapSession(opts);
    return this._activeSession;
  }

  /**
   * 获取 active session
   * @param [sessionId] 可选，用于验证 session ID
   */
  getSession(sessionId?: string): BootstrapSession | null {
    if (!this._activeSession) {
      return null;
    }
    if (this._activeSession.isExpired) {
      return null;
    }
    if (sessionId && this._activeSession.id !== sessionId) {
      return null;
    }
    return this._activeSession;
  }

  /** 获取 active session，无论是否过期（用于恢复场景） */
  getAnySession() {
    return this._activeSession;
  }

  /** 清除 active session */
  clearSession() {
    this._activeSession = null;
  }
}

export default BootstrapSession;
