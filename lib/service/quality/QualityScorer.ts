/**
 * QualityScorer — Recipe 质量评分器
 * 5 个维度: completeness(0.35) + format(0.25) + codeQuality(0.25) + metadata(0.15) + engagement(0)
 * 每个维度评分 0-1，加权求和
 */

import { CODE_LENGTH, QUALITY_GRADES, QUALITY_WEIGHTS } from '../../shared/constants.js';

const DEFAULT_WEIGHTS = QUALITY_WEIGHTS;

interface RecipeInput {
  title?: string;
  trigger?: string;
  code?: string;
  language?: string;
  category?: string;
  summary?: string;
  usageGuide?: string;
  headers?: string[];
  tags?: string[];
  views?: number;
  clicks?: number;
  rating?: number;
  [key: string]: unknown;
}

interface QualityScorerOptions {
  weights?: Record<string, number>;
}

export class QualityScorer {
  #weights;

  constructor(options: QualityScorerOptions = {}) {
    this.#weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  }

  /**
   * 计算综合质量分
   * @param {object} recipe - Recipe 对象 (title, trigger, code, language, category, summary, usageGuide, headers, tags, views, clicks, rating)
   * @returns {{ score: number, dimensions: object, grade: string }}
   */
  score(recipe: RecipeInput) {
    const dimensions = {
      completeness: this.#scoreCompleteness(recipe),
      format: this.#scoreFormat(recipe),
      codeQuality: this.#scoreCodeQuality(recipe),
      metadata: this.#scoreMetadata(recipe),
      engagement: this.#scoreEngagement(recipe),
    };

    let totalScore = 0;
    for (const [dim, weight] of Object.entries(this.#weights)) {
      totalScore +=
        (((dimensions as Record<string, number>)[dim] || 0) as number) * (weight as number);
    }

    totalScore = Math.min(1, Math.max(0, totalScore));

    return {
      score: parseFloat(totalScore.toFixed(3)),
      dimensions,
      grade: this.#toGrade(totalScore),
    };
  }

  /**
   * 批量评分
   */
  scoreBatch(recipes: RecipeInput[]) {
    return recipes.map((r: RecipeInput) => ({ recipe: r, ...this.score(r) }));
  }

  /**
   * 获取维度权重
   */
  getWeights() {
    return { ...this.#weights };
  }

  // ─── 维度评分 ─────────────────────────────────────────

  /**
   * 完整性: title(0.25) + trigger(0.25) + code(0.3) + usageGuide(0.2)
   */
  #scoreCompleteness(r: RecipeInput) {
    let s = 0;
    if (r.title?.trim()) {
      s += 0.25;
    }
    if (r.trigger?.trim()) {
      s += 0.25;
    }
    if (r.code && r.code.trim().length > 5) {
      s += 0.3;
    }
    if (r.usageGuide?.trim()) {
      s += 0.2;
    }
    return s;
  }

  /**
   * 格式: trigger 格式(0.5) + language 合法性(0.5)
   */
  #scoreFormat(r: RecipeInput) {
    let s = 0;
    if (r.trigger) {
      if (
        /^[a-zA-Z0-9_\-:.]+$/.test(r.trigger) &&
        r.trigger.length >= 2 &&
        r.trigger.length <= 64
      ) {
        s += 0.5;
      } else if (r.trigger.length >= 2) {
        s += 0.25;
      }
    }
    if (r.language) {
      const valid = new Set([
        'swift',
        'objective-c',
        'objc',
        'javascript',
        'typescript',
        'python',
        'c',
        'cpp',
        'shell',
        'markdown',
      ]);
      s += valid.has(r.language.toLowerCase()) ? 0.5 : 0.25;
    }
    return s;
  }

  /**
   * 代码质量: 长度适中(0.3) + 无 TODO(0.2) + 有注释(0.3) + 有错误处理(0.2)
   */
  #scoreCodeQuality(r: RecipeInput) {
    if (!r.code) {
      return 0;
    }
    let s = 0;
    const code = r.code;

    // 长度适中
    if (code.length >= CODE_LENGTH.MIN && code.length <= CODE_LENGTH.MAX) {
      s += 0.3;
    } else if (code.length > CODE_LENGTH.MAX) {
      s += 0.15;
    }

    // 无 TODO/FIXME/HACK
    if (!/\b(TODO|FIXME|HACK|XXX)\b/.test(code)) {
      s += 0.2;
    }

    // 有注释
    if (/\/\/|\/\*|#\s/.test(code)) {
      s += 0.3;
    }

    // 有错误处理
    if (/try|catch|throw|guard|if\s+let|do\s*\{|\.catch/.test(code)) {
      s += 0.2;
    }

    return s;
  }

  /**
   * 元数据: category(0.35) + tags/headers(0.35) + summary(0.3)
   */
  #scoreMetadata(r: RecipeInput) {
    let s = 0;
    if (r.category?.trim()) {
      s += 0.35;
    }
    if ((r.tags && r.tags.length > 0) || (r.headers && r.headers.length > 0)) {
      s += 0.35;
    }
    if (r.summary?.trim()) {
      s += 0.3;
    }
    return s;
  }

  /**
   * 互动: views(0.3) + clicks(0.3) + rating(0.4)
   */
  #scoreEngagement(r: RecipeInput) {
    let s = 0;
    if (r.views && r.views > 0) {
      s += Math.min(0.3, (r.views / 100) * 0.3);
    }
    if (r.clicks && r.clicks > 0) {
      s += Math.min(0.3, (r.clicks / 50) * 0.3);
    }
    if (r.rating && r.rating > 0) {
      s += (r.rating / 5) * 0.4;
    }
    return s;
  }

  /**
   * 分数转等级
   */
  #toGrade(score: number) {
    if (score >= QUALITY_GRADES.A) {
      return 'A';
    }
    if (score >= QUALITY_GRADES.B) {
      return 'B';
    }
    if (score >= QUALITY_GRADES.C) {
      return 'C';
    }
    if (score >= QUALITY_GRADES.D) {
      return 'D';
    }
    return 'F';
  }
}
