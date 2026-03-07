/**
 * TopicClassifier — 按主题分组 KnowledgeEntry
 *
 * 将 kind='pattern' 的知识条目按主题分组，用于 Channel B（Smart Rules）。
 * 每个主题对应一个 .mdc 文件，设 alwaysApply: false + 丰富的 description。
 */

import type { KnowledgeEntryProps } from '../../domain/knowledge/KnowledgeEntry.js';

/**
 * 主题定义
 * - dimensions: 关联的 bootstrap 维度
 * - keywords: 用于匹配 entry 分类的关键词
 * - descriptionKeywords: 用于 .mdc description 字段的关键词（Agent 关联性判断依据）
 */
const TOPIC_MAP = {
  networking: {
    dimensions: ['event-and-data-flow'],
    descriptionKeywords:
      'network, HTTP, API, request, response, URL, fetch, socket, REST, download, upload, error handling, retry, timeout',
  },
  ui: {
    dimensions: ['code-pattern'],
    descriptionKeywords:
      'view, controller, UI, layout, animation, cell, table, collection, button, scroll, navigation, auto layout, gesture, storyboard',
  },
  data: {
    dimensions: ['code-pattern', 'architecture'],
    descriptionKeywords:
      'model, storage, database, cache, CoreData, Realm, SQLite, keychain, UserDefaults, JSON, parsing, serialization, persistence',
  },
  architecture: {
    dimensions: ['architecture', 'best-practice'],
    descriptionKeywords:
      'singleton, delegate, factory, observer, protocol, manager, service, dependency injection, module, MVVM, MVC, coordinator, router, design pattern',
  },
  conventions: {
    dimensions: ['code-standard'],
    descriptionKeywords:
      'naming, format, style, import, header, prefix, convention, documentation, file organization, constants, enum, typedef, pragma mark',
  },
};

export class TopicClassifier {
  projectName: string;
  /**
   * @param {string} projectName 项目名称
   */
  constructor(projectName = 'Project') {
    this.projectName = projectName;
  }

  /**
   * 将 patterns 按主题分组
   * @param {Array<Object>} entries - KnowledgeEntry 数组 (kind='pattern')
   * @returns {Object<string, Array<Object>>} { topic: [entries] }
   */
  group(entries: KnowledgeEntryProps[]) {
    const grouped: Record<string, KnowledgeEntryProps[]> = {};
    const unmatched: KnowledgeEntryProps[] = [];

    for (const entry of entries) {
      const topic = this._classifyEntry(entry);
      if (topic) {
        if (!grouped[topic]) {
          grouped[topic] = [];
        }
        grouped[topic].push(entry);
      } else {
        unmatched.push(entry);
      }
    }

    // 未匹配的归入 'general' — 但只在有内容时
    if (unmatched.length > 0) {
      grouped.general = unmatched;
    }

    return grouped;
  }

  /**
   * 为主题构建 description — Agent 判断关联性的唯一依据
   *
   * v3: 动态丰富化 — 除硬编码 baseKeywords 外，还从 entries 的
   * tags, whenClause, trigger 中提取高价值关键词，让 Cursor 的
   * description 匹配更精准。
   *
   * @param {string} topic
   * @param {Array<Object>} entries
   * @returns {string}
   */
  buildDescription(topic: string, entries: KnowledgeEntryProps[]) {
    const topicDef = (
      TOPIC_MAP as Record<string, { dimensions: string[]; descriptionKeywords: string }>
    )[topic];
    const baseKeywords = topicDef
      ? topicDef.descriptionKeywords
      : entries
          .map((e: KnowledgeEntryProps) => e.title || '')
          .filter(Boolean)
          .join(', ');

    // 从 entries 提取动态关键词（tags + whenClause + title/description）
    const entryKeywords = entries
      .flatMap((e: KnowledgeEntryProps) => this._extractKeywords(e))
      .filter(Boolean);
    // 从 tags 直接提取（tags 本身就是高质量关键词）
    const tagKeywords = entries
      .flatMap((e: KnowledgeEntryProps) => e.tags || [])
      .map((t: string) => t.toLowerCase())
      .filter((t: string) => t.length >= 2 && !STOP_WORDS.has(t));
    // 从 whenClause 提取（包含触发场景信息）
    const whenKeywords = entries
      .flatMap((e: KnowledgeEntryProps) => (e.whenClause || '').match(/[a-zA-Z]{3,}/g) || [])
      .map((w: string) => w.toLowerCase())
      .filter((w: string) => !STOP_WORDS.has(w));

    const allExtra = [...new Set([...tagKeywords, ...whenKeywords, ...entryKeywords])].slice(0, 15);
    const extra = allExtra.length > 0 ? `, ${allExtra.join(', ')}` : '';

    return `${this._topicLabel(topic)} patterns for ${this.projectName} — ${baseKeywords}${extra}. Use when writing or reviewing ${this._topicLabel(topic).toLowerCase()}-related code.`;
  }

  /**
   * 分类单个 entry 到主题 — 直读 AI 预计算的 topicHint
   * @private
   */
  _classifyEntry(entry: KnowledgeEntryProps) {
    return entry.topicHint || null; // AI 没给 → null → 归入 general
  }

  /**
   * 从 entry 提取关键词
   * @private
   */
  _extractKeywords(entry: KnowledgeEntryProps) {
    const text = `${entry.title || ''} ${entry.description || ''}`;
    // 提取英文关键词（3+ 字母）
    const words = text.match(/[a-zA-Z]{3,}/g) || [];
    const filtered = words.map((w) => w.toLowerCase()).filter((w) => !STOP_WORDS.has(w));
    return [...new Set(filtered)].slice(0, 5);
  }

  /**
   * @private
   */
  _topicLabel(topic: string) {
    const labels = {
      networking: 'Networking',
      ui: 'UI',
      data: 'Data',
      architecture: 'Architecture',
      conventions: 'Conventions',
      general: 'General',
    };
    return (
      (labels as Record<string, string>)[topic] || topic.charAt(0).toUpperCase() + topic.slice(1)
    );
  }
}

/** @type {Set<string>} */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'this',
  'that',
  'with',
  'from',
  'use',
  'using',
  'when',
  'not',
  'all',
  'are',
  'has',
  'have',
  'been',
  'will',
  'can',
  'should',
  'must',
  'may',
  'each',
  'which',
  'their',
  'your',
  'its',
  'project',
  'code',
  'file',
  'class',
  'method',
  'function',
  'bootstrap',
]);

export default TopicClassifier;
