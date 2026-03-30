/**
 * ReverseGuard — Recipe→Code 反向验证
 *
 * 正向: 代码 → Guard → "代码是否符合知识？"  ✅ 已有
 * 反向: Recipe → Guard → "知识是否还符合代码？" ← 本文件
 *
 * 对每条 active rule Recipe:
 *   1. 提取 coreCode 中的 API 引用（类名、方法名）
 *   2. 在 code_entities 表中查找这些符号
 *   3. 符号不存在 → PatternDrift
 *   4. 提取 guard regex pattern → 对项目代码运行匹配
 *   5. 匹配率骤降 → 代码模式正在迁移
 */

import Logger from '../../infrastructure/logging/Logger.js';

import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';

/* ────────────────────── Types ────────────────────── */

interface DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

export type DriftType =
  | 'symbol_missing'
  | 'match_rate_drop'
  | 'api_deprecated'
  | 'zero_match'
  | 'source_ref_stale';
export type DriftSeverity = 'high' | 'medium' | 'low';

export interface PatternDriftSignal {
  type: DriftType;
  detail: string;
  severity: DriftSeverity;
  evidence: {
    expectedSymbol?: string;
    matchRate?: { current: number; historical: number };
  };
}

export type ReverseRecommendation = 'healthy' | 'investigate' | 'decay';

export interface ReverseGuardResult {
  recipeId: string;
  title: string;
  signals: PatternDriftSignal[];
  recommendation: ReverseRecommendation;
}

interface RecipeRow {
  id: string;
  title: string;
  core_code: string | null;
  guard_pattern: string | null;
  stats: string | null;
}

/* ────────────────────── 常量 ────────────────────── */

/** 从 coreCode 中提取符号引用的正则（多语言通用） */
const SYMBOL_PATTERNS = [
  // ClassName.method / ClassName.shared / ClassName() — Swift/Java/Kotlin/TS/Dart/C#
  /\b([A-Z][A-Za-z0-9_]+)\s*[.(]/g,
  // [ClassName method] — ObjC 消息发送
  /\[\s*([A-Z][A-Za-z0-9_]+)\s+\w/g,
  // import/from 引用 — JS/TS/Python/Dart/Go
  /(?:import|from)\s+['"]([^'"]+)['"]/g,
  // #import / #include — ObjC/C/C++ 头文件引用
  /^\s*#(?:import|include)\s+[<"]([^>"]+)[>"]/gm,
  // package.function / module::Type — Go/Rust 限定名
  /\b([a-z][a-z0-9_]+(?:::[A-Z][A-Za-z0-9_]+|\.[A-Z][A-Za-z0-9_]+))/g,
  // @decorator — Python/TS decorator 引用
  /@([A-Z][A-Za-z0-9_]+)/g,
];

/** 定义多少条 drift signal 算 investigate / decay */
const DRIFT_THRESHOLDS = {
  /** ≥1 high → investigate */
  INVESTIGATE_HIGH: 1,
  /** ≥2 high → decay */
  DECAY_HIGH: 2,
  /** ≥3 medium → investigate */
  INVESTIGATE_MEDIUM: 3,
};

/* ────────────────────── Class ────────────────────── */

export class ReverseGuard {
  #db: DatabaseLike;
  #signalBus: SignalBus | null;
  #logger = Logger.getInstance();

  constructor(db: DatabaseLike, options: { signalBus?: SignalBus } = {}) {
    this.#db = db;
    this.#signalBus = options.signalBus ?? null;
  }

  /**
   * 对一条 Recipe 执行反向验证
   */
  checkRecipe(
    recipe: RecipeRow,
    projectFiles: { path: string; content: string }[]
  ): ReverseGuardResult {
    const signals: PatternDriftSignal[] = [];

    // 1. 检查 coreCode 中引用的符号是否还存在于代码库
    if (recipe.core_code) {
      signals.push(...this.#checkSymbolExistence(recipe.core_code));
    }

    // 2. 检查 guard pattern 在项目代码中的匹配率
    if (recipe.guard_pattern) {
      signals.push(...this.#checkPatternMatchRate(recipe.id, recipe.guard_pattern, projectFiles));
    }

    // 3. 检查 sourceRef 路径是否失效（与 SourceRefReconciler 数据交叉验证）
    signals.push(...this.#checkSourceRefStaleness(recipe.id));

    // 4. 综合判定
    const recommendation = this.#computeRecommendation(signals);

    // 5. 发射信号
    if (this.#signalBus && signals.length > 0) {
      const severity = recommendation === 'decay' ? 1 : recommendation === 'investigate' ? 0.5 : 0;
      this.#signalBus.send('quality', 'ReverseGuard', severity, {
        target: recipe.id,
        metadata: {
          signalCount: signals.length,
          recommendation,
          driftTypes: [...new Set(signals.map((s) => s.type))],
        },
      });
    }

    return {
      recipeId: recipe.id,
      title: recipe.title,
      signals,
      recommendation,
    };
  }

  /**
   * 批量对所有 active rule Recipes 执行反向验证
   */
  auditAllRules(projectFiles: { path: string; content: string }[]): ReverseGuardResult[] {
    const recipes = this.#loadActiveRuleRecipes();
    const results: ReverseGuardResult[] = [];

    for (const recipe of recipes) {
      try {
        results.push(this.checkRecipe(recipe, projectFiles));
      } catch (err: unknown) {
        this.#logger.debug(
          `ReverseGuard: failed to check recipe ${recipe.id}: ${(err as Error).message}`
        );
      }
    }

    return results;
  }

  /**
   * 获取需要调查/衰退的 Recipe 结果
   */
  getDriftResults(results: ReverseGuardResult[]): ReverseGuardResult[] {
    return results.filter((r) => r.recommendation !== 'healthy');
  }

  /* ── 内部方法 ── */

  #loadActiveRuleRecipes(): RecipeRow[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT id, title,
                json_extract(content, '$.coreCode') AS core_code,
                json_extract(content, '$.pattern') AS guard_pattern,
                stats
         FROM knowledge_entries
         WHERE lifecycle = 'active'
           AND kind = 'rule'`
        )
        .all();
      return rows.map((r) => ({
        id: r.id as string,
        title: r.title as string,
        core_code: (r.core_code as string) ?? null,
        guard_pattern: (r.guard_pattern as string) ?? null,
        stats: (r.stats as string) ?? null,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 检查 coreCode 中引用的符号是否存在于 code_entities 表
   */
  #checkSymbolExistence(coreCode: string): PatternDriftSignal[] {
    const symbols = this.#extractSymbols(coreCode);
    if (symbols.size === 0) {
      return [];
    }

    const signals: PatternDriftSignal[] = [];
    for (const symbol of symbols) {
      try {
        const row = this.#db
          .prepare(`SELECT name FROM code_entities WHERE name = ? LIMIT 1`)
          .get(symbol);
        if (!row) {
          signals.push({
            type: 'symbol_missing',
            detail: `Symbol "${symbol}" referenced in recipe coreCode not found in codebase`,
            severity: 'high',
            evidence: { expectedSymbol: symbol },
          });
        }
      } catch {
        // code_entities 表不存在时静默跳过
        break;
      }
    }
    return signals;
  }

  /**
   * 检查 guard pattern 在项目代码中的匹配情况
   */
  #checkPatternMatchRate(
    recipeId: string,
    guardPattern: string,
    projectFiles: { path: string; content: string }[]
  ): PatternDriftSignal[] {
    let re: RegExp;
    try {
      re = new RegExp(guardPattern, 'gm');
    } catch {
      return []; // 无效正则，不产出 drift（由 UncertaintyCollector 处理）
    }

    // 统计当前匹配数
    let currentMatches = 0;
    for (const file of projectFiles) {
      const matches = file.content.match(re);
      if (matches) {
        currentMatches += matches.length;
      }
    }

    // 获取历史匹配率（从 stats.guardHits 推断）
    const historicalHits = this.#getHistoricalHits(recipeId);

    const signals: PatternDriftSignal[] = [];

    if (currentMatches === 0 && projectFiles.length > 0) {
      // 完全匹配不到 — 场景已不存在
      signals.push({
        type: 'zero_match',
        detail: `Guard pattern matches 0 times across ${projectFiles.length} files — scenario may no longer exist`,
        severity: 'high',
        evidence: {
          matchRate: { current: 0, historical: historicalHits },
        },
      });
    } else if (historicalHits > 0 && currentMatches > 0) {
      // 匹配率大幅下降
      const dropRatio = currentMatches / historicalHits;
      if (dropRatio < 0.3) {
        signals.push({
          type: 'match_rate_drop',
          detail: `Guard pattern match count dropped significantly: ${currentMatches} current vs ${historicalHits} historical (${Math.round(dropRatio * 100)}%)`,
          severity: 'medium',
          evidence: {
            matchRate: { current: currentMatches, historical: historicalHits },
          },
        });
      }
    }

    return signals;
  }

  /**
   * 检查 recipe_source_refs 中是否有 stale 条目（与 SourceRefReconciler 数据交叉验证）
   */
  #checkSourceRefStaleness(recipeId: string): PatternDriftSignal[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT source_path FROM recipe_source_refs WHERE recipe_id = ? AND status = 'stale'`
        )
        .all(recipeId) as { source_path: string }[];

      if (rows.length === 0) {
        return [];
      }

      return [
        {
          type: 'source_ref_stale',
          detail: `${rows.length} source file(s) no longer exist: ${rows
            .slice(0, 3)
            .map((r) => r.source_path)
            .join(', ')}${rows.length > 3 ? ` (+${rows.length - 3} more)` : ''}`,
          severity: rows.length >= 3 ? 'high' : 'medium',
          evidence: {},
        },
      ];
    } catch {
      // recipe_source_refs 表可能不存在
      return [];
    }
  }

  #extractSymbols(coreCode: string): Set<string> {
    const symbols = new Set<string>();
    for (const pattern of SYMBOL_PATTERNS) {
      // 重置 lastIndex（全局正则需要重置）
      const re = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(coreCode)) !== null) {
        const symbol = match[1];
        if (!symbol || symbol.length < 3) {
          continue;
        }
        // 过滤纯小写短词（if/for/var 等关键词），但允许含大写、含分隔符（::/.）、含路径分隔符（/）的符号
        if (/^[a-z]+$/.test(symbol) && symbol.length < 6) {
          continue;
        }
        symbols.add(symbol);
      }
    }
    return symbols;
  }

  #getHistoricalHits(recipeId: string): number {
    try {
      const row = this.#db
        .prepare(
          `SELECT json_extract(stats, '$.guardHits') AS hits FROM knowledge_entries WHERE id = ?`
        )
        .get(recipeId) as { hits: number | null } | undefined;
      return row?.hits ?? 0;
    } catch {
      return 0;
    }
  }

  #computeRecommendation(signals: PatternDriftSignal[]): ReverseRecommendation {
    if (signals.length === 0) {
      return 'healthy';
    }

    const highCount = signals.filter((s) => s.severity === 'high').length;
    const mediumCount = signals.filter((s) => s.severity === 'medium').length;

    if (highCount >= DRIFT_THRESHOLDS.DECAY_HIGH) {
      return 'decay';
    }
    if (highCount >= DRIFT_THRESHOLDS.INVESTIGATE_HIGH) {
      return 'investigate';
    }
    if (mediumCount >= DRIFT_THRESHOLDS.INVESTIGATE_MEDIUM) {
      return 'investigate';
    }

    return 'healthy';
  }
}
