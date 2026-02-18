/**
 * ComplianceReporter — 全项目 Guard 合规报告生成
 *
 * 依赖:
 *   - GuardCheckEngine.auditFiles() — 原始 violations 数据
 *   - ViolationsStore — 历史统计 & 趋势
 *   - RuleLearner — 规则 P/R/F1
 *   - ExclusionManager — 排除项（不计入合规分）
 *   - config.qualityGate — 阈值配置
 *
 * 输出:
 *   ComplianceReport { qualityGate, summary, topViolations, fileHotspots, ruleHealth, trend }
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { collectSourceFilesWithContent } from './SourceFileCollector.js';
import { COMPLIANCE_SCORING, QUALITY_GATE } from '../../shared/constants.js';

/**
 * Quality Gate 评分算法
 */
function computeScore(summary, ruleHealth = []) {
  let score = 100;

  // 扣分：每个 error/warning/info 按常量权重扣分
  score -= summary.errors * COMPLIANCE_SCORING.ERROR_PENALTY;
  score -= summary.warnings * COMPLIANCE_SCORING.WARNING_PENALTY;
  score -= (summary.infos || 0) * COMPLIANCE_SCORING.INFO_PENALTY;

  // 加分：规则平均 F1 > 阈值加分
  if (ruleHealth.length > 0) {
    const avgF1 = ruleHealth.reduce((s, r) => s + (r.f1 || 0), 0) / ruleHealth.length;
    if (avgF1 > COMPLIANCE_SCORING.HIGH_F1_THRESHOLD) score += COMPLIANCE_SCORING.HIGH_F1_BONUS;
  }

  // 扣分：高误报规则每条扣分
  const problematic = ruleHealth.filter(r => (r.precision || 1) < COMPLIANCE_SCORING.LOW_PRECISION_THRESHOLD);
  score -= problematic.length * COMPLIANCE_SCORING.PROBLEMATIC_RULE_PENALTY;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * 判定 Quality Gate 状态
 */
function evaluateGate(summary, score, thresholds) {
  const { maxErrors = QUALITY_GATE.MAX_ERRORS, maxWarnings = QUALITY_GATE.MAX_WARNINGS, minScore = QUALITY_GATE.MIN_SCORE } = thresholds;

  if (summary.errors > maxErrors) return 'FAIL';
  if (score < minScore) return 'FAIL';
  if (summary.warnings > maxWarnings) return 'WARN';
  return 'PASS';
}

export class ComplianceReporter {
  /**
   * @param {import('./GuardCheckEngine.js').GuardCheckEngine} guardCheckEngine
   * @param {import('./ViolationsStore.js').ViolationsStore} violationsStore
   * @param {import('./RuleLearner.js').RuleLearner} ruleLearner
   * @param {import('./ExclusionManager.js').ExclusionManager} exclusionManager
   * @param {object} qualityGateConfig - { maxErrors, maxWarnings, minScore }
   */
  constructor(guardCheckEngine, violationsStore, ruleLearner, exclusionManager, qualityGateConfig = {}) {
    this.engine = guardCheckEngine;
    this.violationsStore = violationsStore;
    this.ruleLearner = ruleLearner;
    this.exclusionManager = exclusionManager;
    this.qualityGateConfig = {
      maxErrors: QUALITY_GATE.MAX_ERRORS,
      maxWarnings: QUALITY_GATE.MAX_WARNINGS,
      minScore: QUALITY_GATE.MIN_SCORE,
      ...qualityGateConfig,
    };
    this.logger = Logger.getInstance();
  }

  /**
   * 生成全项目合规报告
   * @param {string} projectRoot - 项目根目录
   * @param {object} options
   * @param {object} [options.qualityGate] - 覆盖默认的 Quality Gate 阈值
   * @param {number} [options.maxFiles] - 最大扫描文件数
   * @returns {Promise<ComplianceReport>}
   */
  async generate(projectRoot, options = {}) {
    const thresholds = { ...this.qualityGateConfig, ...(options.qualityGate || {}) };
    const maxFiles = options.maxFiles || 500;

    // 1. 收集源文件
    const files = await collectSourceFilesWithContent(projectRoot, { maxFiles });
    this.logger.info(`[ComplianceReporter] Collected ${files.length} source files`);

    // 2. 批量审计
    const auditResult = this.engine.auditFiles(files, { scope: 'project' });

    // 3. 通过 ExclusionManager 过滤被排除的项
    const filteredFiles = [];
    for (const fileResult of auditResult.files || []) {
      if (this.exclusionManager?.isPathExcluded?.(fileResult.filePath)) continue;

      const filteredViolations = fileResult.violations.filter(v => {
        // isRuleExcluded 内部已检查全局排除
        if (this.exclusionManager?.isRuleExcluded?.(v.ruleId, fileResult.filePath)) return false;
        return true;
      });

      filteredFiles.push({
        ...fileResult,
        violations: filteredViolations,
        summary: {
          total: filteredViolations.length,
          errors: filteredViolations.filter(v => v.severity === 'error').length,
          warnings: filteredViolations.filter(v => v.severity === 'warning').length,
          infos: filteredViolations.filter(v => v.severity === 'info').length,
        },
      });
    }

    // 4. 汇总
    const summary = {
      filesScanned: files.length,
      totalViolations: filteredFiles.reduce((s, f) => s + f.summary.total, 0),
      errors: filteredFiles.reduce((s, f) => s + f.summary.errors, 0),
      warnings: filteredFiles.reduce((s, f) => s + f.summary.warnings, 0),
      infos: filteredFiles.reduce((s, f) => s + f.summary.infos, 0),
    };

    // 5. 按规则 ID 聚合 top violations
    const ruleAgg = new Map();
    for (const f of filteredFiles) {
      for (const v of f.violations) {
        const key = v.ruleId;
        if (!ruleAgg.has(key)) {
          ruleAgg.set(key, {
            ruleId: key,
            message: v.message,
            severity: v.severity,
            fileCount: new Set(),
            occurrences: 0,
            fixRecipeId: null,
            fixRecipeTitle: null,
          });
        }
        const agg = ruleAgg.get(key);
        agg.fileCount.add(f.filePath);
        agg.occurrences++;
        if (v.fixSuggestion && !agg.fixRecipeId) {
          agg.fixRecipeId = v.fixSuggestion.replace(/^recipe:/, '');
        }
      }
    }

    const topViolations = [...ruleAgg.values()]
      .map(v => ({ ...v, fileCount: v.fileCount.size }))
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 20);

    // 6. 文件热点
    const fileHotspots = filteredFiles
      .filter(f => f.summary.total > 0)
      .map(f => ({
        filePath: f.filePath,
        violationCount: f.summary.total,
        errorCount: f.summary.errors,
      }))
      .sort((a, b) => b.violationCount - a.violationCount)
      .slice(0, 20);

    // 7. 规则健康度（来自 RuleLearner）
    let ruleHealth = [];
    try {
      if (this.ruleLearner?.getAllStats) {
        const allStats = this.ruleLearner.getAllStats();
        ruleHealth = Object.entries(allStats).map(([ruleId, stat]) => ({
          ruleId,
          precision: stat.metrics?.precision ?? 1,
          recall: stat.metrics?.recall ?? 1,
          f1: stat.metrics?.f1 ?? 1,
          triggers: stat.triggers || 0,
          warning: (stat.metrics?.precision ?? 1) < 0.5 ? '高误报' : null,
        }));
      }
    } catch {
      // RuleLearner not available
    }

    // 8. 趋势
    let trend = { errorsChange: 0, warningsChange: 0, hasHistory: false };
    try {
      if (this.violationsStore?.getTrend) {
        trend = this.violationsStore.getTrend();
      }
    } catch {
      // ViolationsStore not available
    }

    // 9. 评分 + Gate
    const score = computeScore(summary, ruleHealth);
    const gateStatus = evaluateGate(summary, score, thresholds);

    // 10. 写入 ViolationsStore（记录本次运行）
    try {
      if (this.violationsStore?.appendRun) {
        const allViolations = filteredFiles.flatMap(f =>
          f.violations.map(v => ({ ...v, filePath: f.filePath }))
        );
        this.violationsStore.appendRun({
          filePath: projectRoot,
          violations: allViolations,
          summary: `Compliance scan: score=${score} ${gateStatus} | ${summary.errors}E ${summary.warnings}W`,
        });
      }
    } catch {
      // Persist failure — non-critical
    }

    return {
      timestamp: new Date().toISOString(),
      projectRoot,
      qualityGate: {
        status: gateStatus,
        score,
        thresholds,
      },
      summary,
      topViolations,
      fileHotspots,
      ruleHealth,
      trend,
    };
  }

  /**
   * 终端格式化输出报告
   * @param {object} report - generate() 产出的报告
   * @param {object} options - { format: 'text' | 'markdown' | 'json' }
   */
  printReport(report, options = {}) {
    const { format = 'text' } = options;

    if (format === 'json') {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (format === 'markdown') {
      this._printMarkdown(report);
      return;
    }

    // text format
    this._printText(report);
  }

  _printText(report) {
    const { qualityGate, summary, topViolations, fileHotspots, trend } = report;

    const gateIcon = qualityGate.status === 'PASS' ? '✅' : qualityGate.status === 'WARN' ? '⚠️' : '❌';
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🛡️  Guard Compliance Report`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`  ${gateIcon} Quality Gate: ${qualityGate.status}  (Score: ${qualityGate.score}/100)`);
    console.log(`  📁 Files Scanned: ${summary.filesScanned}`);
    console.log(`  📊 Violations: ${summary.errors} errors, ${summary.warnings} warnings, ${summary.infos || 0} infos`);

    if (trend.hasHistory) {
      const errTrend = trend.errorsChange > 0 ? `+${trend.errorsChange}` : `${trend.errorsChange}`;
      const warnTrend = trend.warningsChange > 0 ? `+${trend.warningsChange}` : `${trend.warningsChange}`;
      console.log(`  📈 Trend: errors ${errTrend}, warnings ${warnTrend}`);
    }

    if (topViolations.length > 0) {
      console.log(`\n  Top Violations:`);
      for (const v of topViolations.slice(0, 10)) {
        const fix = v.fixRecipeId ? ` → 🔧 recipe:${v.fixRecipeId}` : '';
        console.log(`    [${v.severity}] ${v.ruleId} — ${v.occurrences} hits in ${v.fileCount} files${fix}`);
      }
    }

    if (fileHotspots.length > 0) {
      console.log(`\n  File Hotspots:`);
      for (const f of fileHotspots.slice(0, 10)) {
        console.log(`    📄 ${f.filePath} — ${f.violationCount} violations (${f.errorCount} errors)`);
      }
    }

    console.log(`${'═'.repeat(60)}\n`);
  }

  _printMarkdown(report) {
    const { qualityGate, summary, topViolations, fileHotspots, trend } = report;
    const lines = [];

    lines.push('# Guard Compliance Report');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Quality Gate | ${qualityGate.status} (Score: ${qualityGate.score}/100) |`);
    lines.push(`| Files Scanned | ${summary.filesScanned} |`);
    lines.push(`| Errors | ${summary.errors} |`);
    lines.push(`| Warnings | ${summary.warnings} |`);
    lines.push(`| Infos | ${summary.infos || 0} |`);

    if (trend.hasHistory) {
      lines.push(`| Errors Trend | ${trend.errorsChange > 0 ? '+' : ''}${trend.errorsChange} |`);
      lines.push(`| Warnings Trend | ${trend.warningsChange > 0 ? '+' : ''}${trend.warningsChange} |`);
    }

    if (topViolations.length > 0) {
      lines.push('');
      lines.push('## Top Violations');
      lines.push('');
      lines.push('| Rule | Severity | Files | Hits | Fix |');
      lines.push('|------|----------|-------|------|-----|');
      for (const v of topViolations.slice(0, 20)) {
        const fix = v.fixRecipeId ? `recipe:${v.fixRecipeId}` : '-';
        lines.push(`| ${v.ruleId} | ${v.severity} | ${v.fileCount} | ${v.occurrences} | ${fix} |`);
      }
    }

    if (fileHotspots.length > 0) {
      lines.push('');
      lines.push('## File Hotspots');
      lines.push('');
      lines.push('| File | Violations | Errors |');
      lines.push('|------|-----------|--------|');
      for (const f of fileHotspots.slice(0, 20)) {
        lines.push(`| ${f.filePath} | ${f.violationCount} | ${f.errorCount} |`);
      }
    }

    console.log(lines.join('\n'));
  }
}

export default ComplianceReporter;
