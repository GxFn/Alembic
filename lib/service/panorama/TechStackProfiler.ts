/**
 * TechStackProfiler — 技术栈画像聚合
 *
 * 根据外部依赖名称自动分类，生成项目技术栈画像。
 * 使用已知库名映射表 + 关键词启发式进行分类。
 *
 * @module TechStackProfiler
 */

import { LanguageProfiles } from '#shared/LanguageProfiles.js';
import type { ExternalDepProfile, TechStackProfile } from './PanoramaTypes.js';

/* ═══ TechStackProfiler ═══════════════════════════════════ */

/** Fan-in 阈值：高于此值视为关键依赖热点 */
const HOTSPOT_THRESHOLD = 3;

/**
 * 对外部依赖进行分类，生成技术栈画像
 */
export function profileTechStack(externalDeps: ExternalDepProfile[]): TechStackProfile {
  if (externalDeps.length === 0) {
    return { categories: [], hotspots: [], totalExternalDeps: 0 };
  }

  // 1. 分类每个外部依赖
  const categoryMap = new Map<string, Array<{ name: string; fanIn: number; version?: string }>>();

  for (const dep of externalDeps) {
    const category = classifyDependency(dep.name);
    dep.category = category;

    if (!categoryMap.has(category)) {
      categoryMap.set(category, []);
    }
    categoryMap.get(category)!.push({
      name: dep.name,
      fanIn: dep.fanIn,
      version: dep.version,
    });
  }

  // 2. 按分类排序（每个分类内按 fan-in 降序，分类间按依赖数降序）
  const categories = [...categoryMap.entries()]
    .map(([name, deps]) => ({
      name,
      deps: deps.sort((a, b) => b.fanIn - a.fanIn),
    }))
    .sort((a, b) => b.deps.length - a.deps.length);

  // 3. 提取热点（fan-in ≥ 阈值）
  const hotspots = externalDeps
    .filter((d) => d.fanIn >= HOTSPOT_THRESHOLD)
    .map((d) => ({ name: d.name, fanIn: d.fanIn, dependedBy: d.dependedBy }))
    .sort((a, b) => b.fanIn - a.fanIn);

  return {
    categories,
    hotspots,
    totalExternalDeps: externalDeps.length,
  };
}

/**
 * 分类单个外部依赖
 */
function classifyDependency(name: string): string {
  const knownLibraries = LanguageProfiles.knownLibraries;
  // 标准化名称：移除前缀、转小写
  const normalized = name
    .replace(/^(BDMV|BDP|FMT|BD|MTL|Bai|Ali|TX|TT)/, '')
    .toLowerCase()
    .replace(/[-_]/g, '');

  // 1. 精确匹配已知库
  if (knownLibraries[normalized]) {
    return knownLibraries[normalized];
  }

  // 尝试原始名称小写
  const rawLower = name.toLowerCase().replace(/[-_]/g, '');
  if (knownLibraries[rawLower]) {
    return knownLibraries[rawLower];
  }

  // 2. 关键词启发式
  for (const [pattern, category] of LanguageProfiles.keywordCategories) {
    if (pattern.test(name)) {
      return category;
    }
  }

  // 3. 默认分类
  return 'Other';
}
