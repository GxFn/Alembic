/**
 * @module CallGraphAnalyzer
 * @description Phase 5: 顶层编排器 - 协调 Call Graph 分析的全流程
 *
 * 流水线:
 *   1. CallSiteExtractor  — 从 AST 提取调用点 (已在 AstAnalyzer 二次遍历中完成)
 *   2. SymbolTableBuilder  — 构建全局符号表
 *   3. ImportPathResolver  — 导入路径解析器
 *   4. CallEdgeResolver    — 调用点 → 调用边
 *   5. DataFlowInferrer    — 调用边 → 数据流边
 *
 * 输出:
 *   { callEdges, dataFlowEdges, stats }
 */

import { SymbolTableBuilder } from './SymbolTableBuilder.js';
import { ImportPathResolver } from './ImportPathResolver.js';
import { CallEdgeResolver } from './CallEdgeResolver.js';
import { DataFlowInferrer } from './DataFlowInferrer.js';

/**
 * @typedef {object} CallGraphResult
 * @property {import('./CallEdgeResolver.js').ResolvedEdge[]} callEdges
 * @property {import('./DataFlowInferrer.js').DataFlowEdge[]} dataFlowEdges
 * @property {CallGraphStats} stats
 */

/**
 * @typedef {object} CallGraphStats
 * @property {number} totalCallSites 总调用点数
 * @property {number} resolvedCallSites 成功解析的调用点数
 * @property {number} resolvedRate 解析成功率 (0-1)
 * @property {number} totalEdges 总边数 (call + data_flow)
 * @property {number} filesProcessed 处理的文件数
 * @property {number} symbolCount 符号表大小
 * @property {number} durationMs 总耗时
 */

/**
 * @typedef {object} AnalyzeOptions
 * @property {number} [timeout=15000] 超时(ms)
 * @property {number} [maxCallSitesPerFile=500] 每文件最多调用点
 * @property {number} [minConfidence=0.5] 最低置信度
 */

export class CallGraphAnalyzer {
  /**
   * @param {string} projectRoot
   */
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
  }

  /**
   * 执行完整的调用图分析
   *
   * @param {object} astProjectSummary - analyzeProject() 的输出 (需包含 callSites)
   * @param {AnalyzeOptions} [options]
   * @returns {Promise<CallGraphResult>}
   */
  async analyze(astProjectSummary, options = {}) {
    const t0 = Date.now();
    const timeout = options.timeout || 15_000;
    const maxCallSitesPerFile = options.maxCallSitesPerFile || 500;

    if (!astProjectSummary?.fileSummaries?.length) {
      return this._emptyResult(Date.now() - t0);
    }

    // ── 渐进式超时: 逐文件检查超时，返回 partial result ──
    const deadline = t0 + timeout;
    const result = await this._doAnalyze(astProjectSummary, maxCallSitesPerFile, deadline);
    result.stats.durationMs = Date.now() - t0;
    return result;
  }

  /**
   * 增量分析 — 仅重新分析变更文件及其依赖方
   *
   * @param {object} astProjectSummary - analyzeProject() 的全量输出
   * @param {string[]} changedFiles 变更文件的相对路径列表
   * @param {AnalyzeOptions} [options]
   * @returns {Promise<CallGraphResult>}
   */
  async analyzeIncremental(astProjectSummary, changedFiles, options = {}) {
    const t0 = Date.now();
    const timeout = options.timeout || 15_000;
    const maxCallSitesPerFile = options.maxCallSitesPerFile || 500;

    if (!astProjectSummary?.fileSummaries?.length || !changedFiles?.length) {
      return this._emptyResult(Date.now() - t0);
    }

    // ── 超过 10 个文件变更 → 回退全量分析 ──
    if (changedFiles.length > 10) {
      return this.analyze(astProjectSummary, options);
    }

    const deadline = t0 + timeout;
    const changedSet = new Set(changedFiles);

    // ── Step 1: 构建全局符号表 (始终全量，确保跨文件符号可解析) ──
    const symbolTable = SymbolTableBuilder.build(astProjectSummary);

    // ── Step 2: 构建 ImportPathResolver ──
    const allFiles = astProjectSummary.fileSummaries.map((f) => f.file);
    const importResolver = new ImportPathResolver(this.projectRoot, allFiles);

    // ── Step 3: 找到依赖变更文件的所有文件 (reverse dependency) ──
    const affectedFiles = new Set(changedFiles);
    for (const fileSummary of astProjectSummary.fileSummaries) {
      const imports = symbolTable.fileImports.get(fileSummary.file) || [];
      for (const imp of imports) {
        const resolved = importResolver.resolve(String(imp), fileSummary.file);
        if (resolved && changedSet.has(resolved)) {
          affectedFiles.add(fileSummary.file);
          break;
        }
      }
    }

    // ── Step 4: 仅对受影响文件解析调用边 ──
    const fileCount = astProjectSummary.fileSummaries.length;
    const tier = _computeTier(fileCount);
    const useCHA = tier === 'full-cha';
    const inheritanceGraph = useCHA ? (astProjectSummary.inheritanceGraph || []) : [];
    const callEdgeResolver = new CallEdgeResolver(symbolTable, importResolver, inheritanceGraph);
    const allCallEdges = [];
    let totalCallSites = 0;
    let processedFiles = 0;

    for (const fileSummary of astProjectSummary.fileSummaries) {
      if (!affectedFiles.has(fileSummary.file)) continue;

      const callSites = fileSummary.callSites || [];
      if (callSites.length === 0) continue;

      // 超时检查
      if (Date.now() > deadline) {
        return {
          callEdges: allCallEdges,
          dataFlowEdges: DataFlowInferrer.infer(allCallEdges),
          stats: {
            totalCallSites,
            resolvedCallSites: allCallEdges.length,
            resolvedRate: totalCallSites > 0 ? allCallEdges.length / totalCallSites : 0,
            totalEdges: allCallEdges.length,
            filesProcessed: processedFiles,
            symbolCount: symbolTable.declarations.size,
            durationMs: Date.now() - t0,
            tier,
            partial: true,
            incremental: true,
            processedFiles,
            totalFiles: affectedFiles.size,
            changedFiles: changedFiles.length,
            affectedFiles: affectedFiles.size,
          },
        };
      }

      const limitedCallSites =
        callSites.length > maxCallSitesPerFile
          ? callSites.slice(0, maxCallSitesPerFile)
          : callSites;

      totalCallSites += limitedCallSites.length;

      const edges = callEdgeResolver.resolveFile(limitedCallSites, fileSummary.file);
      allCallEdges.push(...edges);
      processedFiles++;
    }

    // ── Step 5: 推断数据流 ──
    const dataFlowEdges = DataFlowInferrer.infer(allCallEdges);

    return {
      callEdges: allCallEdges,
      dataFlowEdges,
      stats: {
        totalCallSites,
        resolvedCallSites: allCallEdges.length,
        resolvedRate: totalCallSites > 0 ? allCallEdges.length / totalCallSites : 0,
        totalEdges: allCallEdges.length + dataFlowEdges.length,
        filesProcessed: processedFiles,
        symbolCount: symbolTable.declarations.size,
        durationMs: Date.now() - t0,
        tier,
        incremental: true,
        changedFiles: changedFiles.length,
        affectedFiles: affectedFiles.size,
      },
    };
  }

  /**
   * @private 实际分析逻辑
   *
   * 分级降级策略 (§5.2):
   *   - <100 文件  → 完整分析 (含 CHA)
   *   - 100-500   → 完整分析，禁用 CHA
   *   - 500-2000  → 抽样分析 (核心目录优先)
   *   - >2000     → 仅模块级 import graph (跳过调用边解析)
   *
   * 渐进式超时 (§13 Issue #15):
   *   每处理完一个文件检查 deadline，超时时返回已有的 partial result
   *
   * @param {object} astProjectSummary
   * @param {number} maxCallSitesPerFile
   * @param {number} deadline - Date.now() + timeout
   */
  async _doAnalyze(astProjectSummary, maxCallSitesPerFile, deadline) {
    const fileCount = astProjectSummary.fileSummaries.length;

    // ── 分级降级 ──
    const tier = _computeTier(fileCount);
    let fileSummaries = astProjectSummary.fileSummaries;

    if (tier === 'import-only') {
      // >2000 文件: 仅返回 import graph，不解析调用边
      return {
        callEdges: [],
        dataFlowEdges: [],
        stats: {
          totalCallSites: 0,
          resolvedCallSites: 0,
          resolvedRate: 0,
          totalEdges: 0,
          filesProcessed: fileCount,
          symbolCount: 0,
          durationMs: 0,
          tier: 'import-only',
        },
      };
    }

    if (tier === 'sampled') {
      // 500-2000 文件: 抽样核心目录 (仅限制 call site 解析范围)
      fileSummaries = _sampleCoreFiles(fileSummaries, 500);
    }

    // ── Step 2: 构建符号表 (始终使用全量文件，确保跨文件符号可解析) ──
    const symbolTable = SymbolTableBuilder.build(astProjectSummary);

    // ── Step 3: 构建 ImportPathResolver (全量文件索引) ──
    const allFiles = astProjectSummary.fileSummaries.map((f) => f.file);
    const importResolver = new ImportPathResolver(this.projectRoot, allFiles);

    // ── Step 4: 解析调用边 (逐文件 + 超时检查) ──
    const useCHA = tier === 'full-cha';
    const inheritanceGraph = useCHA ? (astProjectSummary.inheritanceGraph || []) : [];
    const callEdgeResolver = new CallEdgeResolver(symbolTable, importResolver, inheritanceGraph);
    const allCallEdges = [];
    let totalCallSites = 0;
    let processedFiles = 0;
    const totalFiles = fileSummaries.filter((f) => f.callSites?.length > 0).length;

    for (const fileSummary of fileSummaries) {
      const callSites = fileSummary.callSites || [];
      if (callSites.length === 0) continue;

      // ── 渐进式超时: 每文件检查 deadline ──
      if (Date.now() > deadline) {
        const dataFlowEdges = DataFlowInferrer.infer(allCallEdges);
        return {
          callEdges: allCallEdges,
          dataFlowEdges,
          stats: {
            totalCallSites,
            resolvedCallSites: allCallEdges.length,
            resolvedRate: totalCallSites > 0 ? allCallEdges.length / totalCallSites : 0,
            totalEdges: allCallEdges.length + dataFlowEdges.length,
            filesProcessed: processedFiles,
            symbolCount: symbolTable.declarations.size,
            durationMs: 0,
            tier,
            partial: true,
            processedFiles,
            totalFiles,
          },
        };
      }

      // 防护: 限制每文件调用点数 (防止超大文件)
      const limitedCallSites =
        callSites.length > maxCallSitesPerFile
          ? callSites.slice(0, maxCallSitesPerFile)
          : callSites;

      totalCallSites += limitedCallSites.length;

      const edges = callEdgeResolver.resolveFile(limitedCallSites, fileSummary.file);
      allCallEdges.push(...edges);
      processedFiles++;
    }

    // ── Step 5: 推断数据流 ──
    const dataFlowEdges = DataFlowInferrer.infer(allCallEdges);

    // ── Stats ──
    const stats = {
      totalCallSites,
      resolvedCallSites: allCallEdges.length,
      resolvedRate: totalCallSites > 0 ? allCallEdges.length / totalCallSites : 0,
      totalEdges: allCallEdges.length + dataFlowEdges.length,
      filesProcessed: processedFiles,
      symbolCount: symbolTable.declarations.size,
      durationMs: 0, // 由外层填充
      tier,
    };

    return { callEdges: allCallEdges, dataFlowEdges, stats };
  }

  /**
   * @private 空结果
   */
  _emptyResult(durationMs) {
    return {
      callEdges: [],
      dataFlowEdges: [],
      stats: {
        totalCallSites: 0,
        resolvedCallSites: 0,
        resolvedRate: 0,
        totalEdges: 0,
        filesProcessed: 0,
        symbolCount: 0,
        durationMs,
      },
    };
  }
}

// ── 分级降级辅助 ──────────────────────────────────────────

/**
 * 根据文件数量确定分析层级
 * @param {number} fileCount
 * @returns {'full-cha'|'full'|'sampled'|'import-only'}
 */
function _computeTier(fileCount) {
  if (fileCount < 100) return 'full-cha';
  if (fileCount <= 500) return 'full';
  if (fileCount <= 2000) return 'sampled';
  return 'import-only';
}

/**
 * 抽样核心文件 — 优先选取 src/、lib/、app/、core/ 等核心目录
 * @param {object[]} fileSummaries
 * @param {number} limit
 * @returns {object[]}
 */
function _sampleCoreFiles(fileSummaries, limit) {
  const CORE_DIRS = /\/(src|lib|app|core|pkg|internal|domain|service|controller|handler|api)\//i;
  const scored = fileSummaries.map((f) => ({
    f,
    score: CORE_DIRS.test(f.file) ? 2 : 1,
    callSiteCount: f.callSites?.length || 0,
  }));
  // 排序: 核心目录优先，有调用点的优先
  scored.sort((a, b) => b.score - a.score || b.callSiteCount - a.callSiteCount);
  return scored.slice(0, limit).map((s) => s.f);
}

export default CallGraphAnalyzer;
