/**
 * CoverageAnalyzer — Guard 覆盖率矩阵 + Panorama 协同
 *
 * 计算模块级 Rule 覆盖率，识别零覆盖和低覆盖模块。
 * 与 PanoramaService 协同：利用模块划分 + gaps 数据做精准评估。
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { LanguageService } from '../../shared/LanguageService.js';

/* ────────────────────── Types ────────────────────── */

interface DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

interface RuleLearnerLike {
  getMetrics(ruleId: string): {
    precision: number;
    recall: number;
    f1: number;
    triggers: number;
    falsePositiveRate: number;
  };
  getAllStats(): Record<
    string,
    { triggers: number; metrics?: { precision?: number; recall?: number; f1?: number } }
  >;
}

export interface ModuleCoverage {
  module: string;
  ruleCount: number;
  fpRate: number;
  coverage: number; // 0-100
  level: 'good' | 'low' | 'zero';
}

export interface CoverageMatrix {
  modules: ModuleCoverage[];
  overallCoverage: number;
  zeroModules: string[];
  lowModules: string[];
}

/* ────────────────────── 常量 ────────────────────── */

const LOW_COVERAGE_THRESHOLD = 50;

/* ────────────────────── Class ────────────────────── */

export class CoverageAnalyzer {
  #db: DatabaseLike;
  #ruleLearner: RuleLearnerLike | null;
  #logger = Logger.getInstance();

  constructor(db: DatabaseLike, options: { ruleLearner?: RuleLearnerLike } = {}) {
    this.#db = db;
    this.#ruleLearner = options.ruleLearner ?? null;
  }

  /**
   * 计算覆盖率矩阵
   * @param moduleFiles 模块名 → 文件路径列表的映射
   */
  analyze(moduleFiles: Map<string, string[]>): CoverageMatrix {
    // 1. 加载所有 active rule recipes
    const rules = this.#loadActiveRules();

    // 2. 构建 rule → 文件路径映射 (从 guard_violations 历史推断)
    const ruleFileMap = this.#buildRuleFileMap();

    // 3. 加载规则健康数据
    const allStats = this.#ruleLearner?.getAllStats() ?? {};

    // 4. 对每个模块计算覆盖率
    const modules: ModuleCoverage[] = [];

    for (const [moduleName, files] of moduleFiles) {
      if (files.length === 0) {
        modules.push({
          module: moduleName,
          ruleCount: 0,
          fpRate: 0,
          coverage: 0,
          level: 'zero',
        });
        continue;
      }

      // 找出与该模块文件匹配的 rule
      const fileSet = new Set(files);
      const matchedRules = new Set<string>();

      // 方式 1: rule 的 guard_violations 历史曾命中该模块的文件
      for (const [ruleId, rulePaths] of ruleFileMap) {
        for (const rp of rulePaths) {
          if (fileSet.has(rp)) {
            matchedRules.add(ruleId);
            break;
          }
        }
      }

      // 方式 2: rule 的 scope/language 与模块语言匹配 (基于文件扩展名推断)
      const moduleLanguages = this.#inferLanguages(files);
      for (const rule of rules) {
        if (rule.languages.length === 0 || rule.languages.some((l) => moduleLanguages.has(l))) {
          matchedRules.add(rule.id);
        }
      }

      const ruleCount = matchedRules.size;

      // 计算该模块关联规则的平均 FP 率
      let fpRateSum = 0;
      let fpRuleCount = 0;
      for (const ruleId of matchedRules) {
        const stat = allStats[ruleId];
        if (stat?.triggers && stat.triggers > 0) {
          const metrics = this.#ruleLearner?.getMetrics(ruleId);
          if (metrics) {
            fpRateSum += metrics.falsePositiveRate;
            fpRuleCount++;
          }
        }
      }
      const fpRate = fpRuleCount > 0 ? Math.round((fpRateSum / fpRuleCount) * 100) : 0;

      // 覆盖率 = 匹配到的规则数 / (模块文件数 × 权重因子)
      // 简化公式: 每个文件理论上应有 ≥1 条规则覆盖
      const coverage = Math.min(100, Math.round((ruleCount / Math.max(1, files.length)) * 100));
      const level = coverage === 0 ? 'zero' : coverage < LOW_COVERAGE_THRESHOLD ? 'low' : 'good';

      modules.push({ module: moduleName, ruleCount, fpRate, coverage, level });
    }

    // 5. 总体覆盖率
    const totalModules = modules.length;
    const overallCoverage =
      totalModules > 0
        ? Math.round(modules.reduce((sum, m) => sum + m.coverage, 0) / totalModules)
        : 0;

    const zeroModules = modules.filter((m) => m.level === 'zero').map((m) => m.module);
    const lowModules = modules.filter((m) => m.level === 'low').map((m) => m.module);

    return { modules, overallCoverage, zeroModules, lowModules };
  }

  /* ── 内部 ── */

  #loadActiveRules(): { id: string; languages: string[] }[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT id, language FROM knowledge_entries WHERE lifecycle = 'active' AND kind = 'rule'`
        )
        .all();
      return rows.map((r) => ({
        id: r.id as string,
        languages: r.language
          ? (r.language as string).split(',').map((l) => LanguageService.normalize(l.trim()))
          : [],
      }));
    } catch {
      return [];
    }
  }

  #buildRuleFileMap(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    try {
      const rows = this.#db
        .prepare(
          `SELECT file_path, violations_json FROM guard_violations ORDER BY created_at DESC LIMIT 200`
        )
        .all();
      for (const row of rows) {
        try {
          const violations = JSON.parse((row.violations_json as string) || '[]') as {
            ruleId?: string;
          }[];
          const filePath = row.file_path as string;
          for (const v of violations) {
            if (!v.ruleId) {
              continue;
            }
            const list = map.get(v.ruleId) || [];
            list.push(filePath);
            map.set(v.ruleId, list);
          }
        } catch {
          // invalid json
        }
      }
    } catch {
      // table doesn't exist
    }
    return map;
  }

  #inferLanguages(files: string[]): Set<string> {
    const langs = new Set<string>();
    for (const f of files) {
      const lang = LanguageService.inferLang(f);
      if (lang !== 'unknown') {
        langs.add(lang);
      }
    }
    return langs;
  }
}
