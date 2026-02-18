/**
 * CursorDeliveryPipeline — 4 通道交付主入口
 *
 * 读取知识库 → 筛选 + 分类 + 排序 + 压缩 → 写入 4 个 Cursor 通道
 *
 * 触发时机：
 *   1. bootstrap 完成后自动触发
 *   2. `asd cursor-rules` CLI 命令手动触发
 *   3. Recipe 状态变更（pending → active）后触发
 *   4. `asd upgrade` 时作为升级步骤执行
 */

import { KnowledgeCompressor } from './KnowledgeCompressor.js';
import { TopicClassifier } from './TopicClassifier.js';
import { RulesGenerator } from './RulesGenerator.js';
import { SkillsSyncer } from './SkillsSyncer.js';
import { estimateTokens, BUDGET } from './TokenBudget.js';
import path from 'node:path';
import fs from 'node:fs';

export class CursorDeliveryPipeline {
  /**
   * @param {Object} options
   * @param {Object} options.knowledgeService - KnowledgeService 实例
   * @param {string} options.projectRoot - 用户项目根目录
   * @param {string} [options.projectName] - 项目名称
   * @param {Object} [options.logger] - 日志器
   */
  constructor({ knowledgeService, projectRoot, projectName, logger }) {
    this.knowledgeService = knowledgeService;
    this.projectRoot = projectRoot;
    this.projectName = projectName || this._inferProjectName(projectRoot);
    this.logger = logger || console;

    // 子模块
    this.compressor = new KnowledgeCompressor();
    this.topicClassifier = new TopicClassifier(this.projectName);
    this.rulesGenerator = new RulesGenerator(projectRoot, this.projectName);
    this.skillsSyncer = new SkillsSyncer(projectRoot, this.projectName, knowledgeService);
  }

  /**
   * 完整交付流程 — 生成 4 通道 Cursor 消费物料
   * @returns {Promise<{ channelA: Object, channelB: Object, channelC: Object, stats: Object }>}
   */
  async deliver() {
    const startTime = Date.now();
    const stats = {
      channelA: { rulesCount: 0, tokensUsed: 0 },
      channelB: { topicCount: 0, patternsCount: 0, totalTokens: 0 },
      channelC: { synced: 0, skipped: 0, errors: 0 },
      channelD: { documentsCount: 0, filesWritten: 0 },
      totalTokensUsed: 0,
      duration: 0,
    };

    try {
      // 1. 加载所有 active + pending 知识
      const entries = await this._loadEntries();
      this.logger.info?.(`[CursorDelivery] Loaded ${entries.length} knowledge entries`);

      // 2. 分类：rules vs patterns vs facts vs documents
      const { rules, patterns, documents } = this._classify(entries);
      this.logger.info?.(`[CursorDelivery] Classified: ${rules.length} rules, ${patterns.length} patterns, ${documents.length} documents`);

      // 3. 清理旧的动态生成文件
      this.rulesGenerator.cleanDynamicFiles();

      // ── Channel A: Always-On Rules ──
      const channelA = this._generateChannelA(rules);
      stats.channelA = channelA;

      // ── Channel B: Smart Rules (by topic) ──
      const channelB = this._generateChannelB(patterns);
      stats.channelB = channelB;

      // ── Channel C: Skills Sync ──
      const channelC = await this._generateChannelC();
      stats.channelC = channelC;

      // ── Channel D: Dev Documents → references ──
      const channelD = this._generateChannelD(documents);
      stats.channelD = channelD;

      // 统计
      stats.totalTokensUsed = channelA.tokensUsed + channelB.totalTokens;
      stats.duration = Date.now() - startTime;

      this.logger.info?.(`[CursorDelivery] Done in ${stats.duration}ms — ` +
        `A: ${channelA.rulesCount} rules (${channelA.tokensUsed} tokens), ` +
        `B: ${channelB.topicCount} topics (${channelB.totalTokens} tokens), ` +
        `C: ${channelC.synced} skills synced, ` +
        `D: ${channelD.documentsCount} documents`);

      return { channelA, channelB, channelC, channelD, stats };
    } catch (error) {
      this.logger.error?.(`[CursorDelivery] Error: ${error.message}`);
      throw error;
    }
  }

  // ─── 内部方法 ───────────────────────────────────────

  /**
   * 加载知识条目（active + high-confidence pending）
   * @private
   */
  async _loadEntries() {
    const allEntries = [];

    // 加载 active
    try {
      const active = await this.knowledgeService.list(
        { lifecycle: 'active' },
        { page: 1, pageSize: 200 }
      );
      const activeItems = this._extractItems(active);
      allEntries.push(...activeItems);
    } catch (e) {
      this.logger.warn?.(`[CursorDelivery] Failed to load active entries: ${e.message}`);
    }

    // 加载 pending（高置信度的也纳入）
    try {
      const pending = await this.knowledgeService.list(
        { lifecycle: 'pending' },
        { page: 1, pageSize: 200 }
      );
      const pendingItems = this._extractItems(pending);
      // 过滤高置信度 pending（quality.confidence >= 0.7 或无 quality 字段）
      const highConfPending = pendingItems.filter(e => {
        const conf = e.quality?.confidence;
        return conf === undefined || conf === null || conf >= 0.7;
      });
      allEntries.push(...highConfPending);
    } catch (e) {
      this.logger.warn?.(`[CursorDelivery] Failed to load pending entries: ${e.message}`);
    }

    return allEntries;
  }

  /**
   * 从 KnowledgeService.list() 返回值提取条目数组
   * @private
   */
  _extractItems(result) {
    if (Array.isArray(result)) return result;
    if (result?.items) return result.items;
    if (result?.data) return result.data;
    return [];
  }

  /**
   * 按 kind 分类知识条目
   * dev-document 类型单独分流，不进入 Channel A/B 压缩
   * @private
   */
  _classify(entries) {
    const rules = [], patterns = [], facts = [], documents = [];
    for (const entry of entries) {
      if (entry.knowledgeType === 'dev-document') {
        documents.push(entry);
      } else if (entry.kind === 'rule') {
        rules.push(entry);
      } else if (entry.kind === 'fact') {
        facts.push(entry);
      } else {
        patterns.push(entry);  // 无 kind 或 kind='pattern' → pattern
      }
    }
    return { rules, patterns, facts, documents };
  }

  /**
   * 排序 — 质量分 + 统计使用量
   * @private
   */
  _rank(entries) {
    return [...entries].sort((a, b) => {
      const scoreA = this._rankScore(a);
      const scoreB = this._rankScore(b);
      return scoreB - scoreA;
    });
  }

  /**
   * 计算排名分
   * @private
   */
  _rankScore(entry) {
    let score = 0;
    score += (entry.quality?.confidence || 0.5) * 50;
    score += (entry.quality?.authorityScore || 0) * 30;
    score += Math.min(entry.stats?.useCount || 0, 10) * 2;
    if (entry.lifecycle === 'active') score += 10;
    return score;
  }

  /**
   * Channel A 生成
   * @private
   */
  _generateChannelA(rules) {
    const topRules = this._rank(rules).slice(0, BUDGET.CHANNEL_A_MAX_RULES);
    const ruleLines = this.compressor.compressToRuleLine(topRules);

    if (ruleLines.length === 0) {
      this.logger.info?.('[CursorDelivery] Channel A: No rules to generate');
      return { rulesCount: 0, tokensUsed: 0, filePath: null };
    }

    const result = this.rulesGenerator.writeAlwaysOnRules(ruleLines);
    this.logger.info?.(`[CursorDelivery] Channel A: ${result.rulesCount} rules → ${result.filePath}`);
    return result;
  }

  /**
   * Channel B 生成
   * @private
   */
  _generateChannelB(patterns) {
    const result = { topicCount: 0, patternsCount: 0, totalTokens: 0, topics: {} };

    if (patterns.length === 0) {
      this.logger.info?.('[CursorDelivery] Channel B: No patterns to generate');
      return result;
    }

    // 按主题分组
    const grouped = this.topicClassifier.group(patterns);

    for (const [topic, topicPatterns] of Object.entries(grouped)) {
      // 排序并取 Top N
      const top = this._rank(topicPatterns).slice(0, BUDGET.CHANNEL_B_MAX_PATTERNS);

      // 压缩为 When/Do/Don't
      const compressed = this.compressor.compressToWhenDoDont(top);
      if (compressed.length === 0) continue;

      // 格式化为 Markdown
      const body = this.compressor.formatWhenDoDont(compressed);

      // 构建 description
      const description = this.topicClassifier.buildDescription(topic, topicPatterns);

      // 写入 .mdc
      const writeResult = this.rulesGenerator.writeSmartRules(topic, body, description);

      result.topicCount++;
      result.patternsCount += compressed.length;
      result.totalTokens += writeResult.tokensUsed;
      result.topics[topic] = { patternsCount: compressed.length, tokensUsed: writeResult.tokensUsed };

      this.logger.info?.(`[CursorDelivery] Channel B: ${topic} — ${compressed.length} patterns → ${writeResult.filePath}`);
    }

    return result;
  }

  /**
   * Channel C 生成
   * @private
   */
  async _generateChannelC() {
    try {
      const syncResult = await this.skillsSyncer.sync();
      this.logger.info?.(
        `[CursorDelivery] Channel C: ${syncResult.synced.length} synced, ` +
        `${syncResult.skipped.length} skipped, ${syncResult.errors.length} errors`
      );
      return {
        synced: syncResult.synced.length,
        skipped: syncResult.skipped.length,
        errors: syncResult.errors.length,
        details: syncResult,
      };
    } catch (err) {
      this.logger.error?.(`[CursorDelivery] Channel C error: ${err.message}`);
      return { synced: 0, skipped: 0, errors: 1, details: { synced: [], skipped: [], errors: [err.message] } };
    }
  }

  /**
   * Channel D — Dev Documents 生成
   * 将 knowledgeType='dev-document' 的条目以原始 MD 写入
   * .cursor/skills/autosnippet-devdocs/references/ 目录
   * @private
   */
  _generateChannelD(documents) {
    const result = { documentsCount: 0, filesWritten: 0, filePaths: [] };
    if (!documents || documents.length === 0) {
      return result;
    }

    const devdocsDir = path.join(this.projectRoot, '.cursor', 'skills', 'autosnippet-devdocs');
    const refsDir = path.join(devdocsDir, 'references');
    fs.mkdirSync(refsDir, { recursive: true });

    // 生成 SKILL.md（索引页）
    const skillLines = [
      '---',
      'name: autosnippet-devdocs',
      `description: "Development documents and knowledge artifacts for ${this.projectName}. Use when looking up architecture decisions, debug reports, design docs, or analysis notes."`,
      '---',
      '',
      `# Dev Documents — ${this.projectName}`,
      '',
      'Use this skill when:',
      '- Looking up architecture decisions or design rationale',
      '- Reviewing debug reports or performance analysis',
      '- Finding previous research or investigation notes',
      '- Understanding project-specific decisions and trade-offs',
      '',
      '## Document Index',
      '',
      '| Title | Tags | Updated |',
      '|-------|------|---------|',
    ];

    for (const doc of documents) {
      const tags = (doc.tags || []).join(', ') || '-';
      const updated = doc.updatedAt
        ? new Date(doc.updatedAt * 1000).toISOString().split('T')[0]
        : '-';
      const slug = this._slugify(doc.title || doc.id);
      skillLines.push(`| [${doc.title}](references/${slug}.md) | ${tags} | ${updated} |`);

      // 写入单个文档 MD
      const markdown = doc.content?.markdown || doc.description || '';
      const docContent = [
        `# ${doc.title || 'Untitled'}`,
        '',
        doc.description ? `> ${doc.description}` : '',
        '',
        `**Tags:** ${tags}  `,
        `**Scope:** ${doc.scope || 'universal'}  `,
        `**Created:** ${doc.createdAt ? new Date(doc.createdAt * 1000).toISOString().split('T')[0] : '-'}`,
        '',
        '---',
        '',
        markdown,
      ].filter(Boolean).join('\n');

      const docPath = path.join(refsDir, `${slug}.md`);
      fs.writeFileSync(docPath, docContent, 'utf8');
      result.filePaths.push(docPath);
      result.filesWritten++;
    }

    skillLines.push('');
    skillLines.push('## Deeper Knowledge');
    skillLines.push('');
    skillLines.push('For full-text search across all documents:');
    skillLines.push('- `autosnippet_search("your query")`');

    fs.writeFileSync(path.join(devdocsDir, 'SKILL.md'), skillLines.join('\n') + '\n', 'utf8');
    result.documentsCount = documents.length;

    this.logger.info?.(`[CursorDelivery] Channel D: ${result.documentsCount} documents → ${refsDir}`);
    return result;
  }

  /**
   * 文件名安全 slug 化
   * @private
   */
  _slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 80) || 'untitled';
  }

  /**
   * 从项目路径推断项目名称
   * @private
   */
  _inferProjectName(projectRoot) {
    return path.basename(projectRoot);
  }
}

export default CursorDeliveryPipeline;
