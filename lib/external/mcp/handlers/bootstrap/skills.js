/**
 * Bootstrap — Skill 加载与维度增强
 *
 * 负责加载 coldstart Skill，从中提取维度增强指引注入 baseDimensions。
 *
 * 内部 Agent (bootstrap.js) 和外部 Agent (bootstrap-external.js) 共享此模块。
 *
 * 注：语言特有知识已由 LanguageExtensions.buildLanguageExtension() 提供，
 * 不再依赖语言 reference Skills。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(__dirname, '../../../../../skills');

const COLDSTART_SKILL_NAME = 'autosnippet-coldstart';

/**
 * 加载 Bootstrap 相关 Skills（仅 coldstart Skill）
 *
 * @param {string} _primaryLanguage 主语言（保留参数签名兼容）
 * @param {object} logger
 * @returns {{ coldstartSkill: string|null, loaded: string[] }}
 */
export function loadBootstrapSkills(_primaryLanguage, logger) {
  const result = { coldstartSkill: null, loaded: [] };
  const skillPath = path.join(SKILLS_DIR, COLDSTART_SKILL_NAME, 'SKILL.md');

  try {
    if (fs.existsSync(skillPath)) {
      result.coldstartSkill = fs.readFileSync(skillPath, 'utf8');
      result.loaded.push(COLDSTART_SKILL_NAME);
      logger?.info?.(`[Bootstrap] Loaded skill: ${COLDSTART_SKILL_NAME}`);
    } else {
      logger?.debug?.(`[Bootstrap] Skill not found: ${skillPath}`);
    }
  } catch (e) {
    logger?.warn?.(`[Bootstrap] Failed to load skill ${COLDSTART_SKILL_NAME}: ${e.message}`);
  }

  return result;
}

/**
 * Skill 中提取维度增强指引
 *
 * 从 coldstart SKILL.md 中的 "Per-Dimension Industry Reference Templates" 提取
 * rationale/whyStandard 作为维度增强指引。
 *
 * @param {object} skillContext — 由 loadBootstrapSkills 返回
 * @returns {{ guides: Record<string, string>, sectionMap: Record<string, Array<{title: string, content: string, keywords: string[]}>> }}
 */
export function extractSkillDimensionGuides(skillContext) {
  const guides = {}; // dimId → summary guide text
  const sectionMap = {}; // dimId → [{title, content, keywords}]

  // ── coldstart 模板: 从 rationale/whyStandard 提取维度指引 ──
  if (skillContext.coldstartSkill) {
    const content = skillContext.coldstartSkill;
    const dimBlocks = content.matchAll(
      /###\s+维度\s*\d+\s*[:：]\s*(.+?)\s*\(([^)]+)\)\s*[—–-]\s*参考模板\s*\n([\s\S]*?)(?=\n###\s|\n##\s)/g
    );
    for (const match of dimBlocks) {
      let dimId = match[2].trim();
      if (/solution|antiPattern|bug/i.test(dimId)) {
        dimId = 'anti-pattern';
      }
      dimId = dimId.replace(/\s+/g, '-');
      const block = match[3];
      const rationaleMatch = block.match(/"rationale"\s*:\s*"([^"]{20,300})"/);
      const whyMatch = block.match(/"whyStandard"\s*:\s*"([^"]{20,200})"/);
      const extraGuide = [rationaleMatch?.[1], whyMatch?.[1]].filter(Boolean).join('。');
      if (extraGuide) {
        guides[dimId] = extraGuide;
      }
    }
  }

  return { guides, sectionMap };
}

/**
 * 增强 9 维度定义 — 将 Skill 提供的参考指引注入 dimensions[].guide
 *
 * @param {Array} dimensions — 原始维度数组
 * @param {Record<string, string>} skillGuides — guides 部分
 * @param {Record<string, Array>} skillSections — sectionMap 部分（per-candidate 匹配用）
 * @returns {Array} 增强后的维度数组（原数组不变，返回新数组）
 */
export function enhanceDimensions(dimensions, skillGuides, skillSections) {
  if (!skillGuides || Object.keys(skillGuides).length === 0) {
    return dimensions;
  }

  return dimensions.map((dim) => {
    const extra = skillGuides[dim.id];
    if (!extra) {
      return dim;
    }
    return {
      ...dim,
      guide: `${dim.guide}。[Skill 参考] ${extra}`,
      _skillEnhanced: true,
      _skillSections: skillSections?.[dim.id] || [],
    };
  });
}
