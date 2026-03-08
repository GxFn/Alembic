/**
 * CursorDeliveryPipeline — 6 通道交付主入口
 *
 * 读取知识库 → 筛选 + 分类 + 排序 + 压缩 → 写入 6 个通道
 *
 * Channel A: .cursor/rules/autosnippet-project-rules.mdc (alwaysApply rules)
 * Channel B: .cursor/rules/autosnippet-patterns-{topic}.mdc (smart rules)
 * Channel C: .cursor/skills/ (project skills sync)
 * Channel D: .cursor/skills/autosnippet-devdocs/ (dev documents)
 * Channel F: AGENTS.md + CLAUDE.md + .github/copilot-instructions.md (agent instructions)
 * + Mirror: .qoder/ .trae/ (IDE mirror)
 *
 * 触发时机：
 *   1. bootstrap 完成后自动触发
 *   2. `asd cursor-rules` CLI 命令手动触发
 *   3. Recipe 状态变更（pending → active）后触发
 *   4. `asd upgrade` 时作为升级步骤执行
 */

import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeEntryProps } from '../../domain/knowledge/KnowledgeEntry.js';
import { DELIVERY_RANK, KNOWLEDGE_CONFIDENCE } from '../../shared/constants.js';
import { DEFAULT_KNOWLEDGE_BASE_DIR } from '../../shared/ProjectMarkers.js';
import { AgentInstructionsGenerator } from './AgentInstructionsGenerator.js';
import { KnowledgeCompressor } from './KnowledgeCompressor.js';
import { RulesGenerator } from './RulesGenerator.js';
import { SkillsSyncer } from './SkillsSyncer.js';
import { BUDGET } from './TokenBudget.js';
import { TopicClassifier } from './TopicClassifier.js';

export class CursorDeliveryPipeline {
  agentInstructions: AgentInstructionsGenerator;
  compressor: KnowledgeCompressor;
  database: Record<string, unknown> | null;
  knowledgeService: {
    list: (
      filter: Record<string, unknown>,
      pagination: { page: number; pageSize: number }
    ) => Promise<unknown>;
  };
  logger: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  projectName: string;
  projectRoot: string;
  rulesGenerator: RulesGenerator;
  skillsSyncer: SkillsSyncer;
  topicClassifier: TopicClassifier;
  /**
   * @param {Object} options
   * @param {Object} options.knowledgeService - KnowledgeService 实例
   * @param {string} options.projectRoot 用户项目根目录
   * @param {string} [options.projectName] 项目名称
   * @param {Object} [options.logger] 日志器
   */
  constructor({
    knowledgeService,
    projectRoot,
    projectName,
    logger,
    database,
  }: {
    knowledgeService: {
      list: (
        filter: Record<string, unknown>,
        pagination: { page: number; pageSize: number }
      ) => Promise<unknown>;
    };
    projectRoot: string;
    projectName?: string;
    logger?: {
      info?: (...args: unknown[]) => void;
      warn?: (...args: unknown[]) => void;
      error?: (...args: unknown[]) => void;
    };
    database?: Record<string, unknown> | null;
  }) {
    this.knowledgeService = knowledgeService;
    this.projectRoot = projectRoot;
    this.projectName = projectName || this._inferProjectName(projectRoot);
    this.logger = logger || console;
    this.database = database || null;

    // 子模块
    this.compressor = new KnowledgeCompressor();
    this.topicClassifier = new TopicClassifier(this.projectName);
    this.rulesGenerator = new RulesGenerator(projectRoot, this.projectName);
    this.skillsSyncer = new SkillsSyncer(projectRoot, this.projectName, knowledgeService);
    this.agentInstructions = new AgentInstructionsGenerator(projectRoot, this.projectName, logger);
  }

  /**
   * 完整交付流程 — 生成 6 通道消费物料
   * @returns {Promise<{ channelA: Object, channelB: Object, channelC: Object, channelD: Object, channelF: Object, stats: Object }>}
   */
  async deliver() {
    const startTime = Date.now();
    const stats = {
      channelA: { rulesCount: 0, tokensUsed: 0 },
      channelB: {
        topicCount: 0,
        patternsCount: 0,
        totalTokens: 0,
        topics: {} as Record<
          string,
          { patternsCount: number; factsCount: number; tokensUsed: number }
        >,
      },
      channelC: { synced: 0, skipped: 0, errors: 0 },
      channelD: { documentsCount: 0, filesWritten: 0 },
      channelF: { filesWritten: 0, totalTokens: 0 },
      totalTokensUsed: 0,
      duration: 0,
    };

    try {
      // 1. 加载所有 active + pending 知识
      const entries = await this._loadEntries();
      this.logger.info?.(`[CursorDelivery] Loaded ${entries.length} knowledge entries`);

      // 2. 分类：rules vs patterns vs facts vs documents
      const { rules, patterns, facts, documents } = this._classify(entries);
      this.logger.info?.(
        `[CursorDelivery] Classified: ${rules.length} rules, ${patterns.length} patterns, ${facts.length} facts, ${documents.length} documents`
      );

      // 3. 清理旧的动态生成文件
      this.rulesGenerator.cleanDynamicFiles();

      // ── Channel A: Always-On Rules ──
      const channelA = this._generateChannelA(rules);
      stats.channelA = channelA;

      // ── Channel B: Smart Rules (by topic) + Facts ──
      const channelB = this._generateChannelB(patterns, facts);
      stats.channelB = channelB;

      // ── Channel B+: Call Graph Architecture Rules (Phase 5.2) ──
      const archResult = this._generateCallGraphArchitectureRules();
      if (archResult) {
        stats.channelB.topicCount++;
        stats.channelB.totalTokens += archResult.tokensUsed;
        stats.channelB.topics = stats.channelB.topics || {};
        stats.channelB.topics['call-architecture'] = {
          patternsCount: archResult.insightsCount,
          factsCount: 0,
          tokensUsed: archResult.tokensUsed,
        };
      }

      // ── Channel C: Skills Sync ──
      const channelC = await this._generateChannelC();
      stats.channelC = channelC;

      // ── Channel D: Dev Documents → references ──
      const channelD = this._generateChannelD(documents);
      stats.channelD = channelD;

      // ── Channel F: Agent Instructions (AGENTS.md / CLAUDE.md / copilot-instructions) ──
      const channelF = this._generateChannelF(rules, patterns);
      stats.channelF = channelF;

      // NOTE: .qoder/ .trae/ 镜像不再自动执行，由 `asd mirror` 按需触发

      stats.totalTokensUsed =
        channelA.tokensUsed + channelB.totalTokens + (channelF.totalTokens || 0);
      stats.duration = Date.now() - startTime;

      this.logger.info?.(
        `[CursorDelivery] Done in ${stats.duration}ms — ` +
          `A: ${channelA.rulesCount} rules (${channelA.tokensUsed} tokens), ` +
          `B: ${channelB.topicCount} topics (${channelB.totalTokens} tokens), ` +
          `C: ${channelC.synced} skills synced, ` +
          `D: ${channelD.documentsCount} documents, ` +
          `F: ${channelF.filesWritten} agent files`
      );

      return { channelA, channelB, channelC, channelD, channelF, stats };
    } catch (error: unknown) {
      this.logger.error?.(`[CursorDelivery] Error: ${(error as Error).message}`);
      throw error;
    }
  }

  // ─── 内部方法 ───────────────────────────────────────

  /**
   * 加载知识条目（active + high-confidence pending）
   * @private
   */
  async _loadEntries() {
    const allEntries: KnowledgeEntryProps[] = [];

    // 加载 active
    try {
      const active = await this.knowledgeService.list(
        { lifecycle: 'active' },
        { page: 1, pageSize: 200 }
      );
      const activeItems = this._extractItems(active);
      allEntries.push(...activeItems);
    } catch (e: unknown) {
      this.logger.warn?.(`[CursorDelivery] Failed to load active entries: ${(e as Error).message}`);
    }

    // 加载 pending（高置信度的也纳入）
    try {
      const pending = await this.knowledgeService.list(
        { lifecycle: 'pending' },
        { page: 1, pageSize: 200 }
      );
      const pendingItems = this._extractItems(pending);
      // 过滤高置信度 pending（quality.confidence >= PENDING_MIN 或无 quality 字段）
      const highConfPending = pendingItems.filter((e: KnowledgeEntryProps) => {
        const qual = e.quality as { confidence?: number } | undefined;
        const conf = qual?.confidence;
        return conf === undefined || conf === null || conf >= KNOWLEDGE_CONFIDENCE.PENDING_MIN;
      });
      allEntries.push(...highConfPending);
    } catch (e: unknown) {
      this.logger.warn?.(
        `[CursorDelivery] Failed to load pending entries: ${(e as Error).message}`
      );
    }

    return allEntries;
  }

  /**
   * 从 KnowledgeService.list() 返回值提取条目数组
   * @private
   */
  _extractItems(result: unknown): KnowledgeEntryProps[] {
    if (Array.isArray(result)) {
      return result as KnowledgeEntryProps[];
    }
    const obj = result as Record<string, unknown> | null | undefined;
    if (obj?.items) {
      return obj.items as KnowledgeEntryProps[];
    }
    if (obj?.data) {
      return obj.data as KnowledgeEntryProps[];
    }
    return [];
  }

  /**
   * 按 kind 分类知识条目
   * dev-document 类型单独分流，不进入 Channel A/B 压缩
   * @private
   */
  _classify(entries: KnowledgeEntryProps[]) {
    const rules: KnowledgeEntryProps[] = [],
      patterns: KnowledgeEntryProps[] = [],
      facts: KnowledgeEntryProps[] = [],
      documents: KnowledgeEntryProps[] = [];
    for (const entry of entries) {
      if (entry.knowledgeType === 'dev-document') {
        documents.push(entry);
      } else if (entry.kind === 'rule') {
        rules.push(entry);
      } else if (entry.kind === 'fact') {
        facts.push(entry);
      } else {
        patterns.push(entry); // 无 kind 或 kind='pattern' → pattern
      }
    }
    return { rules, patterns, facts, documents };
  }

  /**
   * 排序 — 质量分 + 统计使用量
   * @private
   */
  _rank(entries: KnowledgeEntryProps[]) {
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
  _rankScore(entry: KnowledgeEntryProps) {
    const qual = entry.quality as { confidence?: number; authorityScore?: number } | undefined;
    const st = entry.stats as { useCount?: number } | undefined;
    let score = 0;
    score +=
      (qual?.confidence || KNOWLEDGE_CONFIDENCE.RANK_DEFAULT) * DELIVERY_RANK.CONFIDENCE_WEIGHT;
    score += (qual?.authorityScore || 0) * DELIVERY_RANK.AUTHORITY_WEIGHT;
    score +=
      Math.min(st?.useCount || 0, DELIVERY_RANK.USE_COUNT_MAX) * DELIVERY_RANK.USE_COUNT_WEIGHT;
    if (entry.lifecycle === 'active') {
      score += DELIVERY_RANK.ACTIVE_BONUS;
    }
    return score;
  }

  /**
   * Channel A 生成
   * @private
   */
  _generateChannelA(rules: KnowledgeEntryProps[]) {
    const topRules = this._rank(rules).slice(0, BUDGET.CHANNEL_A_MAX_RULES);
    const ruleLines = this.compressor.compressToRuleLine(topRules);

    if (ruleLines.length === 0) {
      this.logger.info?.('[CursorDelivery] Channel A: No rules to generate');
      return { rulesCount: 0, tokensUsed: 0, filePath: null };
    }

    const result = this.rulesGenerator.writeAlwaysOnRules(ruleLines);
    this.logger.info?.(
      `[CursorDelivery] Channel A: ${result.rulesCount} rules → ${result.filePath}`
    );
    return result;
  }

  /**
   * Channel B 生成（patterns + facts）
   * @param {Array} patterns - kind='pattern' 的知识条目
   * @param {Array} [facts=[]] - kind='fact' 的知识条目
   * @private
   */
  _generateChannelB(patterns: KnowledgeEntryProps[], facts: KnowledgeEntryProps[] = []) {
    const result: {
      topicCount: number;
      patternsCount: number;
      factsCount: number;
      totalTokens: number;
      topics: Record<string, { patternsCount: number; factsCount: number; tokensUsed: number }>;
    } = { topicCount: 0, patternsCount: 0, factsCount: 0, totalTokens: 0, topics: {} };

    if (patterns.length === 0 && facts.length === 0) {
      this.logger.info?.('[CursorDelivery] Channel B: No patterns or facts to generate');
      return result;
    }

    // 按主题分组 patterns
    const grouped = this.topicClassifier.group(patterns);

    // 按主题分组 facts（复用同一分类器）
    const groupedFacts = facts.length > 0 ? this.topicClassifier.group(facts) : {};

    // 合并所有主题（patterns + facts 的并集）
    const allTopics = new Set([...Object.keys(grouped), ...Object.keys(groupedFacts)]);

    for (const topic of allTopics) {
      const topicPatterns = grouped[topic] || [];
      const topicFacts = groupedFacts[topic] || [];

      // 压缩 patterns 为 When/Do/Don't
      const top = this._rank(topicPatterns).slice(0, BUDGET.CHANNEL_B_MAX_PATTERNS);
      const compressed = this.compressor.compressToWhenDoDont(top);

      // 压缩 facts 为 Know 行
      const factLines = this.compressor.compressToFactLines(topicFacts);

      if (compressed.length === 0 && factLines.length === 0) {
        continue;
      }

      // 格式化为 Markdown（patterns + facts）
      let body = '';
      if (compressed.length > 0) {
        body += this.compressor.formatWhenDoDont(compressed);
      }
      if (factLines.length > 0) {
        body += this.compressor.formatFactLines(factLines);
      }

      // 构建 description（合并 patterns 和 facts 条目用于关键词提取）
      const allEntries = [...topicPatterns, ...topicFacts];
      const description = this.topicClassifier.buildDescription(topic, allEntries);

      // 写入 .mdc
      const writeResult = this.rulesGenerator.writeSmartRules(topic, body, description);

      result.topicCount++;
      result.patternsCount += compressed.length;
      result.factsCount += factLines.length;
      result.totalTokens += writeResult.tokensUsed;
      (
        result.topics as Record<
          string,
          { patternsCount: number; factsCount: number; tokensUsed: number }
        >
      )[topic] = {
        patternsCount: compressed.length,
        factsCount: factLines.length,
        tokensUsed: writeResult.tokensUsed,
      };

      this.logger.info?.(
        `[CursorDelivery] Channel B: ${topic} — ${compressed.length} patterns + ${factLines.length} facts → ${writeResult.filePath}`
      );
    }

    return result;
  }

  /**
   * Channel B+ — Call Graph Architecture Rules (Phase 5.2)
   * 从调用图拓扑分析架构分层，生成 architecture smart rule
   * @private
   * @returns {{ insightsCount: number, tokensUsed: number, filePath: string }|null}
   */
  _generateCallGraphArchitectureRules() {
    if (!this.database) {
      return null;
    }

    try {
      const db = typeof this.database.getDb === 'function' ? this.database.getDb() : this.database;

      // 查询调用边中的跨目录调用模式
      const callEdges = db
        .prepare(
          `SELECT from_id, to_id, metadata_json FROM knowledge_edges
         WHERE relation = 'calls' AND metadata_json LIKE '%phase5%'`
        )
        .all();

      if (!callEdges || callEdges.length < 5) {
        return null;
      }

      // 提取 caller/callee 对应的文件路径
      const entityFiles = new Map();
      const entities = db
        .prepare(`SELECT entity_id, file_path FROM code_entities WHERE entity_type = 'method'`)
        .all();
      for (const e of entities) {
        entityFiles.set(e.entity_id, e.file_path);
      }

      // 构建目录级调用矩阵
      const dirCalls = new Map(); // 'src/controllers' → Map('src/services' → count)
      for (const edge of callEdges) {
        const callerFile = entityFiles.get(edge.from_id);
        const calleeFile = entityFiles.get(edge.to_id);
        if (!callerFile || !calleeFile || callerFile === calleeFile) {
          continue;
        }

        const callerDir = this._extractLayerDir(callerFile);
        const calleeDir = this._extractLayerDir(calleeFile);
        if (!callerDir || !calleeDir || callerDir === calleeDir) {
          continue;
        }

        if (!dirCalls.has(callerDir)) {
          dirCalls.set(callerDir, new Map());
        }
        const targets = dirCalls.get(callerDir);
        targets.set(calleeDir, (targets.get(calleeDir) || 0) + 1);
      }

      if (dirCalls.size === 0) {
        return null;
      }

      // 检测架构层: 入度高(被调用多)的目录是底层服务, 出度高(调用多)的是上层
      const dirInDegree = new Map();
      const dirOutDegree = new Map();
      for (const [from, targets] of dirCalls) {
        for (const [to, count] of targets) {
          dirOutDegree.set(from, (dirOutDegree.get(from) || 0) + count);
          dirInDegree.set(to, (dirInDegree.get(to) || 0) + count);
        }
      }

      // 生成架构洞察
      const lines: string[] = [];
      lines.push('## Call Graph Architecture');
      lines.push('');

      // 分层推断: 按 (inDegree - outDegree) 排序, 值越大 = 越底层
      const allDirs = new Set([...dirInDegree.keys(), ...dirOutDegree.keys()]);
      const layers = [...allDirs]
        .map((dir) => ({
          dir,
          inDegree: dirInDegree.get(dir) || 0,
          outDegree: dirOutDegree.get(dir) || 0,
          layerScore: (dirInDegree.get(dir) || 0) - (dirOutDegree.get(dir) || 0),
        }))
        .sort((a, b) => b.layerScore - a.layerScore);

      // 分层标签
      const total = layers.length;
      let insightsCount = 0;

      if (total >= 2) {
        lines.push('### Architecture Layers (inferred from call graph)');
        lines.push('');

        for (let i = 0; i < layers.length && i < 10; i++) {
          const l = layers[i];
          let layerLabel: string;
          if (i < total * 0.33) {
            layerLabel = '🔽 low-level (service/repository)';
          } else if (i < total * 0.66) {
            layerLabel = '↔️ mid-level (business logic)';
          } else {
            layerLabel = '🔼 high-level (controller/UI)';
          }

          lines.push(`- \`${l.dir}/\` — ${layerLabel} (in:${l.inDegree} out:${l.outDegree})`);
          insightsCount++;
        }
        lines.push('');
      }

      // 核心调用链
      const hotPaths = [...dirCalls.entries()]
        .flatMap(([from, targets]) =>
          [...targets.entries()].map(([to, count]) => ({ from, to, count }))
        )
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

      if (hotPaths.length > 0) {
        lines.push('### Key Call Paths');
        lines.push('');
        for (const p of hotPaths) {
          lines.push(`- \`${p.from}/\` → \`${p.to}/\` (${p.count} calls)`);
          insightsCount++;
        }
        lines.push('');
      }

      if (insightsCount === 0) {
        return null;
      }

      // 构建 description (用于 smart rule 关联性判断)
      const dirList = layers.map((l) => l.dir).join(', ');
      const description =
        `Architecture layer analysis for ${this.projectName}. ` +
        `Relevant when editing files in: ${dirList}. ` +
        `Call graph shows ${callEdges.length} cross-file call relationships.`;

      const body = lines.join('\n');
      const writeResult = this.rulesGenerator.writeSmartRules(
        'call-architecture',
        body,
        description
      );

      this.logger.info?.(
        `[CursorDelivery] Channel B+: call-architecture — ${insightsCount} insights → ${writeResult.filePath}`
      );

      return {
        insightsCount,
        tokensUsed: writeResult.tokensUsed,
        filePath: writeResult.filePath,
      };
    } catch (err: unknown) {
      this.logger.warn?.(
        `[CursorDelivery] Call graph architecture rules failed: ${(err as Error).message}`
      );
      return null;
    }
  }

  /**
   * 从文件路径中提取层级目录 (第一或第二级有意义的目录)
   * @private
   */
  _extractLayerDir(filePath: string) {
    if (!filePath) {
      return null;
    }
    const parts = filePath.split('/').filter(Boolean);
    // 跳过 src/ lib/ app/ 等通用前缀
    const skipPrefixes = new Set(['src', 'lib', 'app', 'pkg', 'internal', 'cmd']);
    let startIdx = 0;
    if (parts.length > 1 && skipPrefixes.has(parts[0])) {
      startIdx = 1;
    }
    // 取第一个有意义的目录
    return parts[startIdx] || parts[0] || null;
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
    } catch (err: unknown) {
      this.logger.error?.(`[CursorDelivery] Channel C error: ${(err as Error).message}`);
      return {
        synced: 0,
        skipped: 0,
        errors: 1,
        details: { synced: [], skipped: [], errors: [(err as Error).message] },
      };
    }
  }

  /**
   * Channel D — Dev Documents 生成
   * 将 knowledgeType='dev-document' 的条目以原始 MD 写入
   * .cursor/skills/autosnippet-devdocs/references/ 目录
   * @private
   */
  _generateChannelD(documents: KnowledgeEntryProps[]) {
    const result = { documentsCount: 0, filesWritten: 0, filePaths: [] as string[] };
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
        ? new Date((doc.updatedAt as number) * 1000).toISOString().split('T')[0]
        : '-';
      const slug = this._slugify(doc.title || doc.id || 'untitled');
      skillLines.push(`| [${doc.title}](references/${slug}.md) | ${tags} | ${updated} |`);

      // 写入单个文档 MD
      const contentObj = doc.content as { markdown?: string } | undefined;
      const markdown = contentObj?.markdown || doc.description || '';
      const docContent = [
        `# ${doc.title || 'Untitled'}`,
        '',
        doc.description ? `> ${doc.description}` : '',
        '',
        `**Tags:** ${tags}  `,
        `**Scope:** ${doc.scope || 'universal'}  `,
        `**Created:** ${doc.createdAt ? new Date((doc.createdAt as number) * 1000).toISOString().split('T')[0] : '-'}`,
        '',
        '---',
        '',
        markdown,
      ]
        .filter(Boolean)
        .join('\n');

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

    fs.writeFileSync(path.join(devdocsDir, 'SKILL.md'), `${skillLines.join('\n')}\n`, 'utf8');
    result.documentsCount = documents.length;

    this.logger.info?.(
      `[CursorDelivery] Channel D: ${result.documentsCount} documents → ${refsDir}`
    );
    return result;
  }

  /**
   * Channel F — Agent Instructions 生成
   * 生成 AGENTS.md / CLAUDE.md / .github/copilot-instructions.md
   * @private
   */
  _generateChannelF(rules: KnowledgeEntryProps[], patterns: KnowledgeEntryProps[]) {
    try {
      // 收集可用 Skills 名称
      const skillsDir = path.join(this.projectRoot, DEFAULT_KNOWLEDGE_BASE_DIR, 'skills');
      let skills: string[] = [];
      if (fs.existsSync(skillsDir)) {
        skills = fs
          .readdirSync(skillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      }

      // 排序后传入
      const rankedRules = this._rank(rules);
      const rankedPatterns = this._rank(patterns);

      const result = this.agentInstructions.generate({
        rules: rankedRules,
        patterns: rankedPatterns,
        skills,
      });

      this.logger.info?.(
        `[CursorDelivery] Channel F: ${result.stats.filesWritten} agent instruction files ` +
          `(${result.stats.totalTokens} tokens)`
      );

      return {
        filesWritten: result.stats.filesWritten,
        totalTokens: result.stats.totalTokens,
        files: {
          agents: result.agents.filePath,
          claude: result.claude.filePath,
          copilot: result.copilot.filePath,
        },
      };
    } catch (err: unknown) {
      this.logger.warn?.(
        `[CursorDelivery] Channel F error (non-blocking): ${(err as Error).message}`
      );
      return { filesWritten: 0, totalTokens: 0, files: {} };
    }
  }

  /**
   * 文件名安全 slug 化
   * @private
   */
  _slugify(text: string) {
    return (
      text
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 80) || 'untitled'
    );
  }

  /**
   * 镜像 .cursor/ 交付物料到目标 IDE 目录（Qoder / Trae 等兼容 IDE）
   * 只复制 autosnippet- 前缀的文件/目录，不触碰用户自定义内容
   * @param {string} targetDirName 目标目录名，如 '.qoder' 或 '.trae'
   * @private
   */
  _mirrorToIDE(targetDirName: string) {
    try {
      const cursorDir = path.join(this.projectRoot, '.cursor');
      const targetDir = path.join(this.projectRoot, targetDirName);

      // Mirror rules/ — 只复制 autosnippet-* 文件
      const cursorRulesDir = path.join(cursorDir, 'rules');
      if (fs.existsSync(cursorRulesDir)) {
        const targetRulesDir = path.join(targetDir, 'rules');
        fs.mkdirSync(targetRulesDir, { recursive: true });
        for (const file of fs.readdirSync(cursorRulesDir)) {
          if (!file.startsWith('autosnippet-')) {
            continue;
          }
          const src = path.join(cursorRulesDir, file);
          if (!fs.statSync(src).isFile()) {
            continue;
          }
          // .mdc → .md
          const destName = file.endsWith('.mdc') ? file.replace(/\.mdc$/, '.md') : file;
          fs.copyFileSync(src, path.join(targetRulesDir, destName));
        }
      }

      // Mirror skills/ — 只复制 autosnippet-* 子目录
      const cursorSkillsDir = path.join(cursorDir, 'skills');
      if (fs.existsSync(cursorSkillsDir)) {
        const targetSkillsDir = path.join(targetDir, 'skills');
        for (const entry of fs.readdirSync(cursorSkillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith('autosnippet-')) {
            continue;
          }
          this._copyDirRecursive(
            path.join(cursorSkillsDir, entry.name),
            path.join(targetSkillsDir, entry.name)
          );
        }
      }

      this.logger.info?.(`[CursorDelivery] Mirrored autosnippet-* to ${targetDirName}/`);
    } catch (err: unknown) {
      this.logger.warn?.(
        `[CursorDelivery] Mirror to ${targetDirName}/ failed: ${(err as Error).message}`
      );
    }
  }

  /**
   * 递归复制目录
   * @private
   */
  _copyDirRecursive(src: string, dest: string) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this._copyDirRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * 从项目路径推断项目名称
   * @private
   */
  _inferProjectName(projectRoot: string) {
    return path.basename(projectRoot);
  }
}

export default CursorDeliveryPipeline;
