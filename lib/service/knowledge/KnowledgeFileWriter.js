/**
 * KnowledgeFileWriter — 将 KnowledgeEntry 序列化为 .md 文件 / 从 .md 解析回实体
 *
 * 统一替代 CandidateFileWriter + RecipeFileWriter。
 *
 * 职责：
 *  - KnowledgeEntry → YAML frontmatter + Markdown body  (serialize)
 *  - .md 内容 → wire format JSON → KnowledgeEntry.fromJSON()  (parse)
 *  - 落盘到 AutoSnippet/{candidates|recipes}/{category}/ 目录
 *  - .md 文件 = 完整唯一数据源（Source of Truth），DB = 索引缓存
 *
 * Frontmatter 分层：
 *  - 标量字段（人类可读/可编辑）：id, title, lifecycle, language, ...
 *  - 简单数组字段（行内 JSON）：tags, headers, headerPaths
 *  - 值对象（_ 前缀，单行 JSON）：_content, _relations, _constraints, ...
 *
 * 文件名策略：trigger slug > title slug > id[:8]
 * 落盘目录：isCandidate() → candidates/  |  isActive()/deprecated → recipes/
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RECIPES_DIR, CANDIDATES_DIR } from '../../infrastructure/config/Defaults.js';
import Logger from '../../infrastructure/logging/Logger.js';
import pathGuard from '../../shared/PathGuard.js';

/* ═══════════════════════════════════════════════════════════
 * 标量字段定义 — frontmatter 中直接输出为 key: value
 * ═══════════════════════════════════════════════════════════ */

const SCALAR_FIELDS = [
  'id', 'title', 'trigger', 'lifecycle', 'language', 'category',
  'kind', 'knowledgeType', 'complexity', 'scope', 'difficulty',
  'description', 'source', 'moduleName',
  'topicHint', 'whenClause', 'doClause', 'dontClause', 'coreCode',
  'createdBy', 'createdAt', 'updatedAt',
  'publishedAt', 'publishedBy', 'reviewedBy', 'reviewedAt',
  'rejectionReason', 'sourceFile', 'sourceCandidateId',
];

/* ═══════════════════════════════════════════════════════════
 * KnowledgeFileWriter 类
 * ═══════════════════════════════════════════════════════════ */

export class KnowledgeFileWriter {
  /**
   * @param {string} projectRoot 项目根目录
   */
  constructor(projectRoot) {
    this.projectRoot   = projectRoot;
    this.recipesDir    = path.join(projectRoot, RECIPES_DIR);
    this.candidatesDir = path.join(projectRoot, CANDIDATES_DIR);
    this.logger        = Logger.getInstance();
  }

  /* ═══ 序列化 ═══════════════════════════════════════════ */

  /**
   * 将 KnowledgeEntry 序列化为完整 .md（YAML frontmatter + body）
   * @param {import('../../domain/knowledge/KnowledgeEntry.js').KnowledgeEntry} entry
   * @returns {string}
   */
  serialize(entry) {
    const json = entry.toJSON();
    const lines = ['---'];

    // ── 标量字段（人类可读）──
    for (const key of SCALAR_FIELDS) {
      const val = json[key];
      if (val != null && val !== '') {
        lines.push(`${key}: ${_yamlValue(key, val)}`);
      }
    }

    // ── 简单数组字段（行内 JSON）──
    if (json.tags?.length)        lines.push(`tags: ${JSON.stringify(json.tags)}`);
    if (json.headers?.length)     lines.push(`headers: ${JSON.stringify(json.headers)}`);
    if (json.headerPaths?.length) lines.push(`headerPaths: ${JSON.stringify(json.headerPaths)}`);
    if (json.includeHeaders)      lines.push(`includeHeaders: true`);
    if (json.autoApprovable)      lines.push(`autoApprovable: true`);

    // ── JSON 值对象（_ 前缀，单行 JSON）──
    const JSON_FIELDS = [
      ['_content',          json.content],
      ['_relations',        json.relations],
      ['_constraints',      json.constraints],
      ['_reasoning',        json.reasoning],
      ['_quality',          json.quality],
      ['_stats',            json.stats],
      ['_lifecycleHistory', json.lifecycleHistory],
    ];
    for (const [key, val] of JSON_FIELDS) {
      if (val && typeof val === 'object') {
        // 跳过空对象和空数组
        const hasContent = Array.isArray(val) ? val.length > 0 : Object.keys(val).length > 0;
        if (hasContent) {
          lines.push(`${key}: ${JSON.stringify(val)}`);
        }
      }
    }
    if (json.agentNotes) lines.push(`_agentNotes: ${JSON.stringify(json.agentNotes)}`);
    if (json.aiInsight)  lines.push(`_aiInsight: ${JSON.stringify(json.aiInsight)}`);

    // _contentHash 占位（后续替换为真实 hash）
    const hashPlaceholder = '__HASH_PLACEHOLDER__';
    lines.push(`_contentHash: ${hashPlaceholder}`);

    lines.push('---');
    lines.push('');

    // ── Body ──
    lines.push(this._buildBody(entry));
    lines.push('');

    // ── 计算 content hash 并替换 placeholder ──
    const md = lines.join('\n');
    const cleanedForHash = md.replace(`_contentHash: ${hashPlaceholder}`, '');
    const hash = computeKnowledgeHash(cleanedForHash);
    return md.replace(hashPlaceholder, hash);
  }

  /**
   * 构建 Markdown body
   * @param {import('../../domain/knowledge/KnowledgeEntry.js').KnowledgeEntry} entry
   * @returns {string}
   */
  _buildBody(entry) {
    const c = entry.content;
    const lines = [];

    if (c.markdown) {
      // Markdown 项目特写 / 完整文章 → 直接输出（去掉可能残留的 frontmatter）
      const body = c.markdown.replace(/^---[\s\S]*?---\s*/, '').trim();
      lines.push(body);
    } else {
      // 结构化构建
      lines.push(`## ${entry.title}`);
      lines.push('');

      if (entry.description) {
        lines.push(`> ${entry.description}`);
        lines.push('');
      }

      if (c.pattern) {
        lines.push('```' + (entry.language || 'swift'));
        lines.push(c.pattern);
        lines.push('```');
        lines.push('');
      }

      if (c.rationale) {
        lines.push('## 设计原理');
        lines.push('');
        lines.push(c.rationale);
        lines.push('');
      }

      if (c.steps?.length > 0) {
        lines.push('## 实施步骤');
        lines.push('');
        for (const [i, step] of c.steps.entries()) {
          if (typeof step === 'string') {
            lines.push(`${i + 1}. ${step}`);
          } else {
            const title = step.title || '步骤';
            const desc  = step.description || '';
            lines.push(`${i + 1}. **${title}**: ${desc}`);
            if (step.code) {
              lines.push('');
              lines.push('```');
              lines.push(step.code);
              lines.push('```');
            }
          }
        }
        lines.push('');
      }

      if (entry.constraints.boundaries?.length > 0) {
        lines.push('## 约束与边界');
        lines.push('');
        for (const b of entry.constraints.boundaries) {
          lines.push(`- ${b}`);
        }
        lines.push('');
      }

      if (entry.reasoning.whyStandard) {
        lines.push('## Why Standard');
        lines.push('');
        lines.push(entry.reasoning.whyStandard);
        lines.push('');
      }

      if (entry.reasoning.sources?.length > 0) {
        lines.push('## Sources');
        lines.push('');
        for (const src of entry.reasoning.sources) {
          lines.push(`- ${src}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /* ═══ 文件操作 ═══════════════════════════════════════════ */

  /**
   * 将 KnowledgeEntry 落盘到对应目录
   * - isCandidate() → AutoSnippet/candidates/{category}/
   * - isActive()/deprecated → AutoSnippet/recipes/{category}/
   *
   * @param {import('../../domain/knowledge/KnowledgeEntry.js').KnowledgeEntry} entry
   * @returns {string|null} 写入的文件路径，失败返回 null
   */
  persist(entry) {
    try {
      if (!entry?.id || !entry?.title) {
        this.logger.warn('Cannot persist knowledge entry: missing id or title');
        return null;
      }

      const { dir, filename } = this._resolveFilePath(entry);

      // 路径安全检查
      pathGuard.assertProjectWriteSafe(dir);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 清理旧文件（lifecycle 切换或 category 变更场景）
      this._cleanupOldFile(entry, path.join(dir, filename));

      const filePath = path.join(dir, filename);
      const markdown = this.serialize(entry);
      fs.writeFileSync(filePath, markdown, 'utf8');

      // 更新 entry 的 sourceFile 溯源
      entry.sourceFile = path.relative(this.projectRoot, filePath);

      this.logger.info('Knowledge entry persisted to file', {
        entryId: entry.id,
        lifecycle: entry.lifecycle,
        path: entry.sourceFile,
      });

      return filePath;
    } catch (error) {
      this.logger.error('Failed to persist knowledge entry to file', {
        entryId: entry?.id,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * 删除 KnowledgeEntry 对应的 .md 文件
   * @param {import('../../domain/knowledge/KnowledgeEntry.js').KnowledgeEntry} entry
   * @returns {boolean}
   */
  remove(entry) {
    if (!entry?.id) return false;

    // 先尝试 sourceFile 精确删除
    if (entry.sourceFile) {
      const fullPath = path.join(this.projectRoot, entry.sourceFile);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        this.logger.info('Knowledge entry file removed', {
          entryId: entry.id,
          path: entry.sourceFile,
        });
        return true;
      }
    }

    // fallback: 按文件名在 candidates/ 和 recipes/ 中扫描
    const { filename } = this._resolveFilePath(entry);
    const searchDirs = [
      path.join(this.candidatesDir, (entry.category || 'general').toLowerCase()),
      path.join(this.recipesDir, (entry.category || 'general').toLowerCase()),
    ];

    for (const dir of searchDirs) {
      const fp = path.join(dir, filename);
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        this.logger.info('Knowledge entry file removed', { entryId: entry.id, path: fp });
        return true;
      }
    }

    // 最终 fallback: id 扫描
    return this._removeByIdScan(entry.id);
  }

  /**
   * 当 lifecycle 切换时，移动 .md 文件到正确目录
   * candidates/ ↔ recipes/
   *
   * @param {import('../../domain/knowledge/KnowledgeEntry.js').KnowledgeEntry} entry
   * @returns {string|null} 新的文件路径
   */
  moveOnLifecycleChange(entry) {
    const oldPath = entry.sourceFile
      ? path.join(this.projectRoot, entry.sourceFile)
      : null;

    const { dir: newDir, filename } = this._resolveFilePath(entry);
    const newPath = path.join(newDir, filename);

    // 如果路径没变，直接重新序列化
    if (oldPath && path.resolve(oldPath) === path.resolve(newPath)) {
      return this.persist(entry);
    }

    // 删除旧文件
    if (oldPath && fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
      this.logger.info('Removed old knowledge entry file on lifecycle change', {
        entryId: entry.id,
        oldPath: entry.sourceFile,
      });
    }

    // 写入新位置
    return this.persist(entry);
  }

  /* ═══ 内部工具 ═══════════════════════════════════════════ */

  /**
   * 计算文件存储路径
   * @returns {{ dir: string, filename: string }}
   */
  _resolveFilePath(entry) {
    const baseDir = entry.isCandidate() ? this.candidatesDir : this.recipesDir;
    const category = (entry.category || 'general').toLowerCase();
    const dir = path.join(baseDir, category);
    const filename = _slugFilename(entry.trigger, entry.title, entry.id);
    return { dir, filename };
  }

  /**
   * 清理旧文件（category 变更或 lifecycle 切换场景）
   */
  _cleanupOldFile(entry, newPath) {
    if (!entry.sourceFile) return;
    const oldPath = path.join(this.projectRoot, entry.sourceFile);
    if (oldPath !== newPath && fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
      this.logger.info('Cleaned up old knowledge entry file', {
        entryId: entry.id,
        oldPath: entry.sourceFile,
      });
    }
  }

  /**
   * 通过 id 扫描所有 .md 文件来删除
   * @returns {boolean}
   */
  _removeByIdScan(id) {
    for (const baseDir of [this.candidatesDir, this.recipesDir]) {
      if (!fs.existsSync(baseDir)) continue;
      try {
        const found = _walkAndRemoveById(baseDir, id);
        if (found) {
          this.logger.info('Knowledge entry file removed by id scan', { id });
          return true;
        }
      } catch { /* ignore scan errors */ }
    }
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════
 * 公共工具函数
 * ═══════════════════════════════════════════════════════════ */

/**
 * 计算 .md 内容的 SHA-256 hash（去除 _content_hash 行后）
 * @param {string} content
 * @returns {string} 16 字符 hex
 */
export function computeKnowledgeHash(content) {
  const cleaned = content.replace(/^_contentHash:.*\n?/m, '').trim();
  return createHash('sha256').update(cleaned, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 从 .md 内容解析为 wire format JSON
 * 返回值可直接 KnowledgeEntry.fromJSON(data) 构造实体
 *
 * @param {string} content  .md 文件全文
 * @param {string} [relPath]  相对路径（用于溯源）
 * @returns {Object} wire format JSON
 */
export function parseKnowledgeMarkdown(content, relPath) {
  const fmMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const data = {};

  if (fmMatch) {
    const fmLines = fmMatch[1].split('\n');

    for (let i = 0; i < fmLines.length; i++) {
      const line = fmLines[i];
      const colonIdx = line.indexOf(':');
      if (colonIdx <= 0) continue;

      const key = line.slice(0, colonIdx).trim();
      // 跳过带空格的非正常 key
      if (/\s/.test(key)) continue;

      let value = line.slice(colonIdx + 1).trim();

      // ── _ 前缀字段：统一去掉 _ 前缀存入 data ──
      if (key.startsWith('_')) {
        const dataKey = key.slice(1); // _content → content, _ai_insight → ai_insight

        // JSON 对象/数组值
        if (value.startsWith('{') || value.startsWith('[')) {
          try {
            data[dataKey] = JSON.parse(value);
            continue;
          } catch {
            // 可能是跨多行的 JSON — 尝试拼接后续行
            let jsonStr = value;
            while (i + 1 < fmLines.length) {
              i++;
              jsonStr += fmLines[i];
              try {
                data[dataKey] = JSON.parse(jsonStr);
                break;
              } catch { /* continue concatenating */ }
            }
            continue;
          }
        }

        // JSON 字符串值（如 _ai_insight: "text"）
        if (value.startsWith('"')) {
          try {
            data[dataKey] = JSON.parse(value);
            continue;
          } catch { /* fall through to plain string */ }
        }

        // 纯标量值（如 _content_hash: abc123）
        if (/^\d+$/.test(value)) { data[dataKey] = parseInt(value, 10); continue; }
        if (/^\d+\.\d+$/.test(value)) { data[dataKey] = parseFloat(value); continue; }
        if (value === 'true')  { data[dataKey] = true; continue; }
        if (value === 'false') { data[dataKey] = false; continue; }
        data[dataKey] = value;
        continue;
      }

      // ── 布尔 ──
      if (value === 'true')  { data[key] = true; continue; }
      if (value === 'false') { data[key] = false; continue; }

      // ── 数值（整数或浮点） ──
      if (/^\d+$/.test(value)) { data[key] = parseInt(value, 10); continue; }
      if (/^\d+\.\d+$/.test(value)) { data[key] = parseFloat(value); continue; }

      // ── JSON 数组（非 _ 前缀） ──
      if (value.startsWith('[')) {
        try { data[key] = JSON.parse(value); continue; } catch { /* fallthrough */ }
      }

      // ── 去引号 ──
      if (/^".*"$/.test(value)) {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
      }

      data[key] = value;
    }
  }

  // ── 从 body 提取信息 ──
  const bodyMatch = content.match(/^---[\s\S]*?---\s*\r?\n([\s\S]*)$/);
  if (bodyMatch) {
    const body = bodyMatch[1].trim();

    // 如果 content 中没有 pattern，从 body 代码块提取
    if (!data.content?.pattern) {
      const codeMatch = body.match(/```\w*\n([\s\S]*?)```/);
      if (codeMatch) {
        data.content = data.content || {};
        data.content.pattern = codeMatch[1].trimEnd();
      }
    }

    // 如果 content 中没有 markdown 且 body 看起来是 Markdown 文章
    if (!data.content?.markdown && !data.content?.pattern) {
      const isMarkdownArticle = body.includes('— 项目特写') ||
        (body.startsWith('#') && body.length > 200);
      if (isMarkdownArticle) {
        data.content = data.content || {};
        data.content.markdown = body;
      }
    }
  }

  // ── 元数据补充 ──
  if (relPath) {
    data.sourceFile = relPath;
  }

  // ── fallback: title 从 body heading 提取 ──
  if (!data.title) {
    const headingMatch = content.match(/^##?\s+(.+)$/m);
    if (headingMatch) data.title = headingMatch[1].trim();
  }

  return data;
}

/* ═══ 私有辅助 ═══════════════════════════════════════════ */

/**
 * 生成文件名 slug
 * @param {string} trigger
 * @param {string} title
 * @param {string} id
 * @returns {string} 文件名（含 .md 后缀）
 */
function _slugFilename(trigger, title, id) {
  // 优先用 trigger
  if (trigger) {
    const clean = trigger
      .replace(/^@/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 60);
    if (clean.length >= 2) return `${clean}.md`;
  }

  // 其次用 title
  if (title) {
    const slug = title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    if (slug.length >= 3) return `${slug}.md`;
  }

  // 最后用 id 前 8 位
  return `${(id || 'unknown').slice(0, 8)}.md`;
}

/**
 * 将 YAML 值安全序列化
 */
function _yamlValue(key, val) {
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  const str = String(val);
  // 含特殊字符时加引号
  if (/[:#\[\]{}&*!|>'"`,@\n]/.test(str) || str.trim() !== str) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return str;
}

/**
 * 递归扫描目录，删除包含指定 id 的 .md 文件
 * @returns {boolean}
 */
function _walkAndRemoveById(dir, id) {
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (_walkAndRemoveById(full, id)) return true;
    } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
      const head = fs.readFileSync(full, 'utf8').slice(0, 500);
      if (head.includes(`id: ${id}`)) {
        fs.unlinkSync(full);
        return true;
      }
    }
  }
  return false;
}

export default KnowledgeFileWriter;
