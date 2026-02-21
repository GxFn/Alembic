/**
 * Bootstrap — Skill 加载与维度增强
 *
 * 负责加载 coldstart + language-reference Skills，
 * 从中提取维度增强指引注入 baseDimensions。
 *
 * ChatAgent + MCP 外部 Agent 共享此模块。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(__dirname, '../../../../../skills');

/**
 * 语言 → Skills 映射（Skills 必须位于内置 skills/ 目录）
 */
const LANG_SKILL_MAP = {
  objectivec: ['autosnippet-coldstart', 'autosnippet-reference-objc'],
  swift: ['autosnippet-coldstart', 'autosnippet-reference-swift'],
  typescript: ['autosnippet-coldstart', 'autosnippet-reference-jsts'],
  javascript: ['autosnippet-coldstart', 'autosnippet-reference-jsts'],
  python: ['autosnippet-coldstart', 'autosnippet-reference-python'],
  java: ['autosnippet-coldstart', 'autosnippet-reference-java'],
  kotlin: ['autosnippet-coldstart', 'autosnippet-reference-kotlin'],
  go: ['autosnippet-coldstart', 'autosnippet-reference-go'],
  dart: ['autosnippet-coldstart', 'autosnippet-reference-dart'],
  rust: ['autosnippet-coldstart', 'autosnippet-reference-rust'],
};

/**
 * 加载 Bootstrap 相关 Skills
 *
 * @param {string} primaryLanguage 主语言
 * @param {object} logger
 * @returns {{ coldstartSkill: string|null, languageSkill: string|null, loaded: string[] }}
 */
export function loadBootstrapSkills(primaryLanguage, logger) {
  const result = { coldstartSkill: null, languageSkill: null, loaded: [] };
  const skillNames = LANG_SKILL_MAP[primaryLanguage] ||
    LANG_SKILL_MAP.typescript || ['autosnippet-coldstart'];

  for (const skillName of skillNames) {
    const skillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
    try {
      if (fs.existsSync(skillPath)) {
        const content = fs.readFileSync(skillPath, 'utf8');
        if (skillName.startsWith('autosnippet-coldstart')) {
          result.coldstartSkill = content;
        } else if (skillName.includes('reference-')) {
          result.languageSkill = content;
        }
        result.loaded.push(skillName);
        logger?.info?.(`[Bootstrap] Loaded skill: ${skillName}`);
      } else {
        logger?.debug?.(`[Bootstrap] Skill not found: ${skillPath}`);
      }
    } catch (e) {
      logger?.warn?.(`[Bootstrap] Failed to load skill ${skillName}: ${e.message}`);
    }
  }

  return result;
}

/**
 * Skill 中提取维度增强指引
 *
 * 1) coldstart SKILL.md 中的 "Per-Dimension Industry Reference Templates" 是**格式示例**（Swift 代码），
 *    仅当无语言 Skill 时才用作 fallback；
 * 2) 语言 Skill（如 reference-objc）包含真正的业界最佳实践内容，优先使用；
 * 3) 返回 per-section 结构以便后续 per-candidate 精准匹配。
 *
 * @param {object} skillContext — 由 loadBootstrapSkills 返回
 * @returns {{ guides: Record<string, string>, sectionMap: Record<string, Array<{title: string, content: string, keywords: string[]}>> }}
 */
export function extractSkillDimensionGuides(skillContext) {
  const guides = {}; // dimId → summary guide text
  const sectionMap = {}; // dimId → [{title, content, keywords}]
  const hasLanguageSkill = !!skillContext.languageSkill;

  // ── coldstart 模板: 仅在无语言 Skill 时用作 fallback ──
  // coldstart 中的 rationale/whyStandard 是 Swift 示例，不适合直接注入其它语言项目
  if (skillContext.coldstartSkill && !hasLanguageSkill) {
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

  // ── 语言 Skill: 逐 section 提取丰富内容作为业界参考（PRIMARY） ──
  if (skillContext.languageSkill) {
    const content = skillContext.languageSkill;

    // heading → dimension(s) + 子主题匹配关键词
    const HEADING_DIM_MAP = [
      {
        pattern: /命名|naming|前缀|prefix/i,
        dims: ['code-standard', 'code-pattern'],
        keywords: ['naming', 'prefix', '命名', '前缀', 'category'],
      },
      {
        pattern: /属性|propert/i,
        dims: ['code-standard', 'best-practice', 'anti-pattern'],
        keywords: [
          'property',
          '属性',
          'copy',
          'weak',
          'strong',
          'memory',
          'retain',
          'cycle',
          'leak',
        ],
      },
      {
        pattern: /delegate|委托/i,
        dims: ['event-and-data-flow', 'code-pattern'],
        keywords: ['delegate', 'protocol', '委托', '协议'],
      },
      {
        pattern: /初始化|initializ/i,
        dims: ['code-pattern'],
        keywords: ['init', 'initializer', '初始化', 'factory'],
      },
      {
        pattern: /null|可选/i,
        dims: ['code-standard'],
        keywords: ['nullable', 'nonnull', 'nullability'],
      },
      {
        pattern: /错误处理|error/i,
        dims: ['best-practice'],
        keywords: ['error', 'NSError', '错误', 'error-handling'],
      },
      { pattern: /bool|陷阱/i, dims: ['anti-pattern'], keywords: ['BOOL', 'bool', '陷阱', 'trap'] },
      {
        pattern: /gcd|线程|thread|并发|concurrent/i,
        dims: ['best-practice', 'anti-pattern'],
        keywords: ['GCD', 'dispatch', 'thread', '线程', 'main', 'concurrency', 'main-thread'],
      },
      {
        pattern: /泛型|generic/i,
        dims: ['code-standard'],
        keywords: ['generics', '泛型', 'generic'],
      },
      {
        pattern: /import|导入/i,
        dims: ['code-standard'],
        keywords: ['import', '#import', '导入', 'file-organization'],
      },
      {
        pattern: /特有维度|extra.?dim/i,
        dims: ['agent-guidelines'],
        keywords: ['agent', '注意', '维度', 'extra'],
      },
      {
        pattern: /category|扩展(?!.*特有)/i,
        dims: ['code-pattern'],
        keywords: ['category', 'extension', '扩展'],
      },
      {
        pattern: /singleton|单例/i,
        dims: ['code-pattern'],
        keywords: ['singleton', '单例', 'dispatch_once'],
      },
    ];

    // 用 --- 分割section，更可靠地提取完整 section body
    const sectionParts = content.split(/\n---\n/);
    for (const part of sectionParts) {
      const headingMatch = part.match(/^##\s+\d+\.\s+(.+?)(?:\s*\(.+\))?\s*$/m);
      if (!headingMatch) {
        continue;
      }

      const heading = headingMatch[1].trim();
      const bodyStart = part.indexOf(headingMatch[0]) + headingMatch[0].length;
      const body = part.substring(bodyStart);

      // 查找匹配的 dimension(s)
      let matchedDims = [];
      const matchedKeywords = [];
      for (const mapping of HEADING_DIM_MAP) {
        if (mapping.pattern.test(heading)) {
          matchedDims.push(...mapping.dims);
          matchedKeywords.push(...mapping.keywords);
        }
      }
      matchedDims = [...new Set(matchedDims)];
      if (matchedDims.length === 0) {
        continue;
      }

      // 提取有意义的摘要内容
      let summary = extractSectionSummary(body);
      // 如果 section body 主要是代码块导致摘要太短，用 heading 本身作为摘要前缀
      if (summary.length < 20) {
        summary = `${heading}：${summary}`;
      }
      if (summary.length < 10) {
        continue;
      }

      const sectionData = {
        title: heading,
        content: summary.substring(0, 500),
        keywords: [...new Set(matchedKeywords)],
      };

      for (const dimId of matchedDims) {
        if (!sectionMap[dimId]) {
          sectionMap[dimId] = [];
        }
        sectionMap[dimId].push(sectionData);

        const shortContent = summary.substring(0, 120);
        if (!guides[dimId]) {
          guides[dimId] = `[${heading}] ${shortContent}`;
        } else if (guides[dimId].length < 500) {
          guides[dimId] += `; [${heading}] ${shortContent}`;
        }
      }
    }
  }

  return { guides, sectionMap };
}

/**
 * 从 Skill section body 中提取有意义的摘要内容
 * 跳过 JSON 模板、代码块（保留关键注释），保留表格和文字描述
 */
export function extractSectionSummary(body) {
  const lines = body.split('\n');
  const parts = [];
  let inCodeBlock = false;
  let inJsonBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 跳过 JSON 模板块（候选格式示例）
    if (trimmed.startsWith('```json')) {
      inJsonBlock = true;
      continue;
    }
    if (inJsonBlock) {
      if (trimmed === '```') {
        inJsonBlock = false;
      }
      continue;
    }

    // 追踪代码块 — 保留 ✅/❌ 关键注释
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      if (/[✅❌]/.test(trimmed) && parts.length < 12) {
        parts.push(trimmed);
      }
      continue;
    }

    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('###') || trimmed.startsWith('####')) {
      continue;
    }
    if (/^\|[-\s|:]+\|$/.test(trimmed)) {
      continue; // 表格分隔线
    }

    parts.push(trimmed);
    if (parts.length >= 10) {
      break;
    }
  }

  return parts
    .join('; ')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
