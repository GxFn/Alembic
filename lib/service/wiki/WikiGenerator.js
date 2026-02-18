/**
 * WikiGenerator — Repo Wiki 生成引擎 (V3 Content-First)
 *
 * 自动分析项目代码结构，生成结构化的项目文档 Wiki。
 * 结合 AutoSnippet 的 AST 深度分析能力（ProjectGraph、CodeEntityGraph、SPM 依赖图）
 * 做到深层代码洞察。
 *
 * V3 核心设计: "内容驱动 + AI 优先"
 *   1. 数据收集 (Scan → AST → SPM → KB)
 *   2. 主题发现 — 分析数据丰富度，动态决定生成哪些文章
 *   3. AI 优先撰写 — 直接由 AI 写完整文章，非骨架+润色
 *   4. 质量关卡 — 内容不足 MIN_ARTICLE_CHARS 则跳过该文章
 *   5. 降级保底 — AI 不可用时使用丰富模板内容
 *
 * Wiki 文档结构 (动态生成，按项目特征而异):
 *   AutoSnippet/wiki/
 *   ├── index.md              — 项目概述 (始终生成)
 *   ├── architecture.md       — 架构总览 (多模块项目)
 *   ├── getting-started.md    — 快速上手 (有构建系统时)
 *   ├── modules/
 *   │   ├── {ModuleName}.md   — 模块深度文档 (仅内容丰富的模块)
 *   │   └── ...
 *   ├── patterns.md           — 代码模式 (有知识库 Recipe 时)
 *   ├── patterns/             — 按分类拆分 (Recipe 较多时)
 *   │   └── {category}.md
 *   ├── protocols.md          — 协议参考 (协议较多时)
 *   ├── documents/            — 同步的 Cursor 端文档
 *   └── meta.json             — Wiki 元数据
 *
 * @module WikiGenerator
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Logger from '../../infrastructure/logging/Logger.js';

const logger = Logger.getInstance();

// ─── Wiki 生成阶段 ──────────────────────────────────────────

export const WikiPhase = Object.freeze({
  INIT:         'init',          // 初始化 & 自检
  SCAN:         'scan',          // 扫描项目结构
  AST_ANALYZE:  'ast-analyze',   // AST 深度分析
  SPM_PARSE:    'spm-parse',     // SPM 依赖解析
  KNOWLEDGE:    'knowledge',     // 整合已有 Recipes
  GENERATE:     'generate',      // 生成 Markdown 骨架
  AI_COMPOSE:   'ai-compose',    // AI 合成写作增强
  SYNC_DOCS:    'sync-docs',     // 同步 Cursor 端 MD
  DEDUP:        'dedup',         // 去重
  FINALIZE:     'finalize',      // 写入 meta.json
});

// ─── 默认配置 ────────────────────────────────────────────────

const DEFAULTS = {
  wikiDir:       'AutoSnippet/wiki',
  language:      'zh',   // 'zh' | 'en'
  maxFiles:      500,
  includeRecipes: true,
  includeDepGraph: true,
  includeComponents: true,
};

// ─── WikiGenerator ────────────────────────────────────────────

export class WikiGenerator {
  /**
   * @param {object} deps
   * @param {string} deps.projectRoot
   * @param {import('../../service/spm/SpmService.js').SpmService} [deps.spmService]
   * @param {import('../../service/knowledge/KnowledgeService.js').KnowledgeService} [deps.knowledgeService]
   * @param {import('../../core/ast/ProjectGraph.js').default} [deps.projectGraph]
   * @param {import('../../service/knowledge/CodeEntityGraph.js').CodeEntityGraph} [deps.codeEntityGraph]
   * @param {import('../../external/ai/AiProvider.js').AiProvider} [deps.aiProvider]
   * @param {Function} [deps.onProgress] - (phase, progress, message) => void
   * @param {object} [deps.options]
   */
  constructor(deps) {
    this.projectRoot      = deps.projectRoot;
    this.spmService       = deps.spmService || null;
    this.knowledgeService = deps.knowledgeService || null;
    this.projectGraph     = deps.projectGraph || null;
    this.codeEntityGraph  = deps.codeEntityGraph || null;
    this.aiProvider       = deps.aiProvider || null;
    this.onProgress       = deps.onProgress || (() => {});
    this.options          = { ...DEFAULTS, ...deps.options };

    this.wikiDir = path.join(this.projectRoot, this.options.wikiDir);
    this.metaPath = path.join(this.wikiDir, 'meta.json');

    this._aborted = false;
  }

  // ═══ 公有 API ══════════════════════════════════════════════

  /**
   * 全量生成 Wiki
   * @returns {Promise<WikiResult>}
   */
  async generate() {
    const startTime = Date.now();
    this._aborted = false;

    try {
      // Phase 1: Init
      this._emit(WikiPhase.INIT, 0, '初始化 Wiki 生成引擎...');
      this._ensureDir(this.wikiDir);

      // Phase 2: Scan project
      this._emit(WikiPhase.SCAN, 5, '扫描项目结构...');
      const projectInfo = await this._scanProject();
      if (this._aborted) return this._abortedResult();

      // Phase 3: AST analyze
      this._emit(WikiPhase.AST_ANALYZE, 15, '执行 AST 深度分析...');
      const astInfo = await this._analyzeAST();
      if (this._aborted) return this._abortedResult();

      // Phase 4: SPM parse
      this._emit(WikiPhase.SPM_PARSE, 30, '解析 SPM 依赖关系...');
      const spmInfo = await this._parseSPM();
      if (this._aborted) return this._abortedResult();

      // Phase 5: Knowledge integration
      this._emit(WikiPhase.KNOWLEDGE, 45, '整合知识库 Recipes...');
      const knowledgeInfo = await this._integrateKnowledge();
      if (this._aborted) return this._abortedResult();

      // Phase 6: Content-driven topic discovery (V3)
      this._emit(WikiPhase.GENERATE, 50, '分析项目数据，发现文档主题...');
      const structuredData = { projectInfo, astInfo, spmInfo, knowledgeInfo };
      const topics = this._discoverTopics(projectInfo, astInfo, spmInfo, knowledgeInfo);
      if (this._aborted) return this._abortedResult();

      // Phase 7: AI-first article composition (V3)
      this._emit(WikiPhase.AI_COMPOSE, 55, `撰写 ${topics.length} 篇文档...`);
      const files = await this._composeArticles(topics, structuredData);
      if (this._aborted) return this._abortedResult();

      // Phase 8: Sync Cursor docs
      this._emit(WikiPhase.SYNC_DOCS, 80, '同步 Cursor 端文档...');
      const syncedFiles = this._syncCursorDocs();
      files.push(...syncedFiles);
      if (this._aborted) return this._abortedResult();

      // Phase 9: Dedup
      this._emit(WikiPhase.DEDUP, 90, '去重检查...');
      const dedupResult = this._dedup(files);

      // Phase 10: Finalize
      this._emit(WikiPhase.FINALIZE, 95, '写入元数据...');
      const meta = this._writeMeta(files, startTime, dedupResult);

      const duration = Date.now() - startTime;
      this._emit(WikiPhase.FINALIZE, 100, `Wiki 生成完成，耗时 ${(duration / 1000).toFixed(1)}s`);

      return {
        success: true,
        filesGenerated: files.length,
        aiComposed: files.filter(f => f.polished).length,
        syncedDocs: syncedFiles.length,
        dedup: dedupResult,
        duration,
        wikiDir: this.wikiDir,
        meta,
      };
    } catch (err) {
      logger.error('[WikiGenerator] Generation failed', { error: err.message });
      this._emit('error', -1, `生成失败: ${err.message}`);
      return { success: false, error: err.message, duration: Date.now() - startTime };
    }
  }

  /**
   * 增量更新 — 仅重新生成变更的部分
   * @returns {Promise<WikiResult>}
   */
  async update() {
    const meta = this._readMeta();
    if (!meta) {
      logger.info('[WikiGenerator] No existing meta.json — falling back to full generation');
      return this.generate();
    }

    // 简化增量策略：检查项目源文件修改时间 vs meta.generatedAt
    const hasChanges = this._detectChanges(meta);
    if (!hasChanges) {
      this._emit(WikiPhase.FINALIZE, 100, 'Wiki 已是最新，无需更新');
      return { success: true, filesGenerated: 0, duration: 0, upToDate: true };
    }

    return this.generate();
  }

  /**
   * 中止当前生成
   */
  abort() {
    this._aborted = true;
  }

  /**
   * 获取当前 Wiki 状态
   */
  getStatus() {
    const meta = this._readMeta();
    if (!meta) {
      return { exists: false };
    }
    return {
      exists: true,
      generatedAt: meta.generatedAt,
      filesCount: meta.files?.length || 0,
      version: meta.version,
      hasChanges: this._detectChanges(meta),
    };
  }

  // ═══ 阶段实现 ══════════════════════════════════════════════

  /**
   * 扫描项目基本信息
   */
  async _scanProject() {
    const info = {
      name: path.basename(this.projectRoot),
      root: this.projectRoot,
      hasPackageSwift: false,
      hasPodfile: false,
      hasXcodeproj: false,
      sourceFiles: [],
      languages: {},
    };

    // 检测项目类型
    const entries = fs.readdirSync(this.projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'Package.swift') info.hasPackageSwift = true;
      if (e.name === 'Podfile')       info.hasPodfile = true;
      if (e.name.endsWith('.xcodeproj') || e.name.endsWith('.xcworkspace')) info.hasXcodeproj = true;
    }

    // 统计源文件
    const extMap = { '.swift': 'Swift', '.m': 'Objective-C', '.h': 'Objective-C Header', '.mm': 'Objective-C++' };
    this._walkDir(this.projectRoot, (filePath) => {
      const ext = path.extname(filePath);
      if (extMap[ext]) {
        info.sourceFiles.push(path.relative(this.projectRoot, filePath));
        info.languages[extMap[ext]] = (info.languages[extMap[ext]] || 0) + 1;
      }
    }, this.options.maxFiles);

    // 按模块/Target 分组源文件 (SPM 约定: Sources/{ModuleName}/...)
    info.sourceFilesByModule = {};
    for (const f of info.sourceFiles) {
      const parts = f.split('/');
      const sourcesIdx = parts.indexOf('Sources');
      let mod;
      if (sourcesIdx >= 0 && sourcesIdx + 1 < parts.length) {
        // SPM 标准结构: Sources/{ModuleName}/...
        mod = parts[sourcesIdx + 1];
      } else {
        // 非 SPM: 取第一级目录名
        mod = parts.length > 1 ? parts[0] : null;
      }
      if (mod) {
        if (!info.sourceFilesByModule[mod]) info.sourceFilesByModule[mod] = [];
        info.sourceFilesByModule[mod].push(f);
      }
    }

    this._emit(WikiPhase.SCAN, 12, `发现 ${info.sourceFiles.length} 个源文件`);
    return info;
  }

  /**
   * AST 分析 — 利用已有 ProjectGraph 或重新构建
   */
  async _analyzeAST() {
    if (this.projectGraph) {
      const overview = this.projectGraph.getOverview();
      const allClasses = this.projectGraph.getAllClassNames();
      const allProtocols = this.projectGraph.getAllProtocolNames();

      // 按模块分组类名和协议名 (通过 filePath 推断所属模块)
      const classNamesByModule = {};
      const protocolNamesByModule = {};

      for (const name of allClasses) {
        const info = this.projectGraph.getClassInfo(name);
        if (info?.filePath) {
          const mod = this._inferModuleFromPath(info.filePath);
          if (mod) {
            if (!classNamesByModule[mod]) classNamesByModule[mod] = [];
            classNamesByModule[mod].push(name);
          }
        }
      }

      for (const name of allProtocols) {
        const info = this.projectGraph.getProtocolInfo(name);
        if (info?.filePath) {
          const mod = this._inferModuleFromPath(info.filePath);
          if (mod) {
            if (!protocolNamesByModule[mod]) protocolNamesByModule[mod] = [];
            protocolNamesByModule[mod].push(name);
          }
        }
      }

      this._emit(WikiPhase.AST_ANALYZE, 25, `AST 分析: ${overview.totalClasses} 个类, ${overview.totalProtocols} 个协议`);
      return {
        overview,
        classes: allClasses,
        protocols: allProtocols,
        classNamesByModule,
        protocolNamesByModule,
      };
    }

    // 没有现成的 ProjectGraph — 返回空壳（不阻塞生成）
    return { overview: null, classes: [], protocols: [], classNamesByModule: {}, protocolNamesByModule: {} };
  }

  /**
   * SPM 依赖解析
   */
  async _parseSPM() {
    if (!this.spmService) return { targets: [], depGraph: null };

    try {
      const targets = await this.spmService.listTargets();
      let depGraph = null;
      if (this.options.includeDepGraph) {
        try {
          depGraph = await this.spmService.getDependencyGraph({ level: 'target' });
        } catch { /* non-critical */ }
      }
      this._emit(WikiPhase.SPM_PARSE, 40, `SPM: ${targets.length} 个 Target`);
      return { targets, depGraph };
    } catch (err) {
      logger.warn('[WikiGenerator] SPM parse failed', { error: err.message });
      return { targets: [], depGraph: null };
    }
  }

  /**
   * 整合已有知识库 Recipes
   */
  async _integrateKnowledge() {
    if (!this.knowledgeService || !this.options.includeRecipes) {
      return { recipes: [], stats: null };
    }

    try {
      const result = await this.knowledgeService.list({
        lifecycle: 'active',
        limit: 200,
        offset: 0,
      });
      const recipes = result.items || result || [];
      const stats = await this.knowledgeService.getStats?.() || null;
      this._emit(WikiPhase.KNOWLEDGE, 55, `知识库: ${recipes.length} 条活跃 Recipe`);
      return { recipes: Array.isArray(recipes) ? recipes : [], stats };
    } catch (err) {
      logger.warn('[WikiGenerator] Knowledge integration failed', { error: err.message });
      return { recipes: [], stats: null };
    }
  }

  /**
   * V3 内容驱动的主题发现
   *
   * 核心原则:
   *   - 没有固定的文件列表 — 所有文章都由数据丰富度驱动
   *   - 跳过数据不足的主题（避免空文档）
   *   - 不同的项目产出不同数量/类型的文章
   *
   * @returns {Array<{id: string, path: string, title: string, type: string, priority: number}>}
   */
  _discoverTopics(projectInfo, astInfo, spmInfo, knowledgeInfo) {
    const topics = [];
    const isZh = this.options.language === 'zh';

    // ── 1. 项目概览 (始终生成) ──
    topics.push({
      id: 'overview',
      path: 'index.md',
      title: isZh ? '项目概述' : 'Project Overview',
      type: 'overview',
      priority: 100,
    });

    // ── 2. 架构概览 (需要模块/依赖关系) ──
    const moduleKeys = Object.keys(astInfo.classNamesByModule || {});
    const hasMultiModule = spmInfo.targets.length >= 2 || moduleKeys.length >= 2;
    const hasDepGraph = spmInfo.depGraph != null;
    const hasInheritance = this.codeEntityGraph != null;

    if (hasMultiModule || hasDepGraph || hasInheritance) {
      topics.push({
        id: 'architecture',
        path: 'architecture.md',
        title: isZh ? '架构总览' : 'Architecture Overview',
        type: 'architecture',
        priority: 90,
      });
    }

    // ── 3. 快速上手 (需要构建配置或入口点) ──
    const hasEntryPoints = (astInfo.overview?.entryPoints?.length || 0) > 0;
    const hasBuildSystem = projectInfo.hasPackageSwift || projectInfo.hasPodfile || projectInfo.hasXcodeproj;

    if (hasEntryPoints || hasBuildSystem) {
      topics.push({
        id: 'getting-started',
        path: 'getting-started.md',
        title: isZh ? '快速上手' : 'Getting Started',
        type: 'getting-started',
        priority: 85,
      });
    }

    // ── 4. 模块深度文档 (仅对实质性模块生成) ──
    for (const target of spmInfo.targets) {
      const moduleFiles = this._getModuleSourceFiles(target, projectInfo);
      const classCount = (astInfo.classNamesByModule?.[target.name] || []).length;
      const protoCount = (astInfo.protocolNamesByModule?.[target.name] || []).length;
      const depCount = (target.dependencies || target.info?.dependencies || []).length;

      // 丰富度评分: 文件数 + 类数×2 + 协议数×2 + 依赖数
      const richness = moduleFiles.length + classCount * 2 + protoCount * 2 + depCount;

      // 跳过过于单薄的模块 (少于3分不值得独立文档)
      if (richness < 3) continue;

      topics.push({
        id: `module-${_slug(target.name)}`,
        path: `modules/${_slug(target.name)}.md`,
        title: target.name,
        type: 'module',
        priority: 50 + Math.min(richness, 30),
        _moduleData: { target, moduleFiles, classCount, protoCount },
      });
    }

    // ── 5. 代码模式/最佳实践 (来自知识库 Recipes) ──
    if (knowledgeInfo.recipes.length > 0) {
      const groups = {};
      for (const r of knowledgeInfo.recipes) {
        const json = r.toJSON ? r.toJSON() : r;
        const cat = json.category || 'Other';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(json);
      }

      const catEntries = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);

      if (catEntries.length <= 3 || knowledgeInfo.recipes.length < 15) {
        // 合并为一篇
        topics.push({
          id: 'patterns',
          path: 'patterns.md',
          title: isZh ? '代码模式与最佳实践' : 'Code Patterns & Best Practices',
          type: 'patterns',
          priority: 40,
        });
      } else {
        // 按分类拆分为多篇
        for (const [cat, items] of catEntries) {
          if (items.length < 2) continue;
          topics.push({
            id: `pattern-${_slug(cat)}`,
            path: `patterns/${_slug(cat)}.md`,
            title: isZh ? `${cat} 模式` : `${cat} Patterns`,
            type: 'pattern-category',
            priority: 30 + items.length,
            _patternData: { category: cat, recipes: items },
          });
        }
      }
    }

    // ── 6. 协议参考 (协议数量足够多时) ──
    if (astInfo.protocols.length >= 8) {
      topics.push({
        id: 'protocols',
        path: 'protocols.md',
        title: isZh ? '协议参考' : 'Protocol Reference',
        type: 'reference',
        priority: 35,
      });
    }

    // 按优先级排序
    topics.sort((a, b) => b.priority - a.priority);

    logger.info(`[WikiGenerator] Discovered ${topics.length} topics: ${topics.map(t => t.id).join(', ')}`);
    this._emit(WikiPhase.GENERATE, 55, `发现 ${topics.length} 个文档主题`);
    return topics;
  }

  /**
   * V3 AI-first 文章撰写
   *
   * 对每个发现的主题:
   *   1. 优先使用 AI 撰写完整文章 (非骨架增强！)
   *   2. AI 不可用时使用丰富的模板内容
   *   3. 质量关卡: 最终内容不足 MIN_ARTICLE_CHARS 则跳过
   *
   * @param {Array} topics - _discoverTopics() 的输出
   * @param {object} structuredData - { projectInfo, astInfo, spmInfo, knowledgeInfo }
   * @returns {Array<{path: string, hash: string, size: number}>}
   */
  async _composeArticles(topics, structuredData) {
    const files = [];
    const isZh = this.options.language === 'zh';
    const MIN_ARTICLE_CHARS = 200;

    // 确保必要的子目录存在
    this._ensureDir(this.wikiDir);
    const needsModulesDir = topics.some(t => t.path.startsWith('modules/'));
    const needsPatternsDir = topics.some(t => t.path.startsWith('patterns/'));
    if (needsModulesDir) this._ensureDir(path.join(this.wikiDir, 'modules'));
    if (needsPatternsDir) this._ensureDir(path.join(this.wikiDir, 'patterns'));

    let composed = 0;
    const systemPrompt = this._buildAiSystemPrompt(isZh);

    for (let i = 0; i < topics.length; i++) {
      if (this._aborted) break;

      const topic = topics[i];
      // 将全部主题列表注入 overview，用于生成导航
      if (topic.type === 'overview') topic._allTopics = topics;

      const progress = 58 + Math.round((i / topics.length) * 22);
      this._emit(WikiPhase.AI_COMPOSE, progress, `撰写: ${topic.title}`);

      let content = null;

      // === 1. 尝试 AI 撰写完整文章 ===
      if (this.aiProvider) {
        try {
          const prompt = this._buildArticlePrompt(topic, structuredData, isZh);
          const aiResult = await Promise.race([
            this.aiProvider.chat(prompt, { systemPrompt, temperature: 0.3, maxTokens: 4096 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('AI compose timeout')), 45_000)),
          ]);

          if (aiResult && typeof aiResult === 'string' && aiResult.length >= MIN_ARTICLE_CHARS) {
            content = aiResult;
            composed++;
          }
        } catch (err) {
          logger.warn(`[WikiGenerator] AI compose failed for ${topic.id}: ${err.message}`);
        }
      }

      // === 2. 降级: 丰富的模板内容 ===
      if (!content) {
        content = this._buildFallbackArticle(topic, structuredData, isZh);
      }

      // === 3. 质量关卡 ===
      if (!content || content.length < MIN_ARTICLE_CHARS) {
        logger.info(`[WikiGenerator] Skipping thin topic: ${topic.id} (${content?.length || 0} chars)`);
        continue;
      }

      // 写入文件
      const fileInfo = this._writeFile(topic.path, content);
      if (composed > 0 && content !== this._buildFallbackArticle(topic, structuredData, isZh)) {
        fileInfo.polished = true;
      }
      files.push(fileInfo);
    }

    logger.info(`[WikiGenerator] Composed ${files.length} articles (${composed} AI-enhanced)`);
    this._emit(WikiPhase.AI_COMPOSE, 80, `撰写完成: ${files.length} 篇文档 (${composed} 篇 AI 增强)`);
    return files;
  }

  // ═══ AI Prompt 构建 ════════════════════════════════════════

  /**
   * 为特定主题构建 AI 撰写 prompt (V3 AI-first 核心)
   *
   * 关键区别: 不是润色骨架，而是提供丰富数据让 AI 写完整文章
   */
  _buildArticlePrompt(topic, data, isZh) {
    const { projectInfo, astInfo, spmInfo, knowledgeInfo } = data;
    const parts = [];

    // 公共项目上下文
    parts.push(`# 项目: ${projectInfo.name}`);
    parts.push(`源文件数: ${projectInfo.sourceFiles.length}, SPM Targets: ${spmInfo.targets.length}, 活跃知识条目: ${knowledgeInfo.recipes.length}`);
    if (projectInfo.languages) {
      parts.push(`语言分布: ${Object.entries(projectInfo.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}(${c})`).join(', ')}`);
    }
    parts.push('');

    switch (topic.type) {
      case 'overview': {
        parts.push('## 任务: 撰写项目概述文档');
        parts.push('');

        // 项目类型
        const types = [];
        if (projectInfo.hasPackageSwift) types.push('SPM');
        if (projectInfo.hasPodfile) types.push('CocoaPods');
        if (projectInfo.hasXcodeproj) types.push('Xcode Project');
        if (types.length > 0) parts.push(`构建系统: ${types.join(' + ')}`);
        parts.push('');

        // 模块结构
        if (spmInfo.targets.length > 0) {
          parts.push('### 模块列表');
          for (const t of spmInfo.targets) {
            const files = this._getModuleSourceFiles(t, projectInfo);
            const cls = astInfo.classNamesByModule?.[t.name]?.length || 0;
            const deps = (t.dependencies || t.info?.dependencies || []).map(d => typeof d === 'string' ? d : d.name);
            parts.push(`- ${t.name} (${t.type || 'target'}): ${files.length} 文件, ${cls} 个类型${deps.length > 0 ? `, 依赖: ${deps.join(', ')}` : ''}`);
          }
          parts.push('');
        }

        // AST 概况
        if (astInfo.overview) {
          parts.push('### 代码规模');
          parts.push(`类/结构体: ${astInfo.overview.totalClasses || 0}, 协议: ${astInfo.overview.totalProtocols || 0}, 方法: ${astInfo.overview.totalMethods || 0}`);
          parts.push('');
        }

        // 可用的其他文档（用于导航链接）
        const otherTopics = (topic._allTopics || []).filter(t => t.type !== 'overview');
        if (otherTopics.length > 0) {
          parts.push('### 需要包含的导航链接');
          for (const t of otherTopics) {
            parts.push(`- [${t.title}](${t.path})`);
          }
          parts.push('');
        }

        parts.push('要求: 撰写完整的项目概述文档。');
        parts.push('包含: 项目简介(解释项目做什么)、模块总览(表格形式)、技术栈分析、核心数据指标、文档导航索引。');
        parts.push('不要只列数据 — 要解释项目的定位、各模块的职责和协作关系。');
        break;
      }

      case 'architecture': {
        parts.push('## 任务: 撰写架构分析文档');
        parts.push('');

        if (spmInfo.targets.length > 0) {
          parts.push('### 模块及依赖关系');
          for (const t of spmInfo.targets) {
            const deps = (t.dependencies || t.info?.dependencies || []).map(d => typeof d === 'string' ? d : d.name);
            parts.push(`- ${t.name} (${t.type || 'target'})${deps.length > 0 ? ` → 依赖: ${deps.join(', ')}` : ''}`);
          }
          parts.push('');
        }

        if (astInfo.overview?.topLevelModules?.length > 0) {
          parts.push(`### 顶层模块: ${astInfo.overview.topLevelModules.join(', ')}`);
          const cpm = astInfo.overview.classesPerModule || {};
          for (const mod of astInfo.overview.topLevelModules) {
            parts.push(`  ${mod}: ${cpm[mod] || 0} 个类`);
          }
          parts.push('');
        }

        if (astInfo.overview?.entryPoints?.length > 0) {
          parts.push(`### 入口点: ${astInfo.overview.entryPoints.join(', ')}`);
          parts.push('');
        }

        const roots = this._getInheritanceRoots();
        if (roots.length > 0) {
          parts.push('### 核心继承关系');
          for (const r of roots.slice(0, 10)) {
            parts.push(`- ${r.name} → ${(r.children || []).slice(0, 5).join(', ')}`);
          }
          parts.push('');
        }

        parts.push('要求: 撰写架构分析文档。');
        parts.push('包含: 模块依赖图(使用 Mermaid graph TD 语法)、分层架构分析(解释每层的职责)、模块间协作关系、架构设计决策阐述。');
        parts.push('用 Mermaid 绘制依赖关系图和继承层次图。分析为什么采用这种架构。');
        break;
      }

      case 'module': {
        const md = topic._moduleData;
        const target = md.target;
        const moduleFiles = md.moduleFiles;
        const moduleClasses = astInfo.classNamesByModule?.[target.name] || [];
        const moduleProtocols = astInfo.protocolNamesByModule?.[target.name] || [];
        const deps = target.dependencies || target.info?.dependencies || [];

        parts.push(`## 任务: 撰写 "${target.name}" 模块的深度文档`);
        parts.push('');
        parts.push('### 模块基本信息');
        parts.push(`- 类型: ${target.type || 'target'}`);
        const tPath = target.path || target.info?.path;
        if (tPath) parts.push(`- 路径: ${tPath}`);
        if (target.packageName) parts.push(`- 所属包: ${target.packageName}`);
        parts.push(`- 源文件: ${moduleFiles.length} 个`);
        parts.push(`- 类/结构体: ${moduleClasses.length} 个`);
        parts.push(`- 协议: ${moduleProtocols.length} 个`);
        parts.push('');

        if (deps.length > 0) {
          parts.push(`### 依赖: ${deps.map(d => typeof d === 'string' ? d : d.name).join(', ')}`);
          parts.push('');
        }

        if (moduleClasses.length > 0) {
          parts.push(`### 类型列表: ${moduleClasses.slice(0, 30).join(', ')}`);
          parts.push('');
        }

        if (moduleProtocols.length > 0) {
          parts.push(`### 协议列表: ${moduleProtocols.slice(0, 20).join(', ')}`);
          parts.push('');
        }

        // 关键源文件名（帮助 AI 推断模块功能）
        if (moduleFiles.length > 0) {
          const keyFiles = moduleFiles.slice(0, 25).map(f => path.basename(f));
          parts.push(`### 关键源文件: ${keyFiles.join(', ')}`);
          parts.push('');
        }

        // 相关 recipes
        const related = knowledgeInfo.recipes.filter(r => {
          const json = r.toJSON ? r.toJSON() : r;
          return json.moduleName === target.name || json.tags?.includes(target.name) || json.title?.includes(target.name);
        });
        if (related.length > 0) {
          parts.push(`### 相关知识条目 (${related.length})`);
          for (const r of related.slice(0, 10)) {
            const json = r.toJSON ? r.toJSON() : r;
            parts.push(`- ${json.title}: ${json.description || ''}`);
            if (json.reasoning?.whyStandard) parts.push(`  为什么: ${json.reasoning.whyStandard}`);
          }
          parts.push('');
        }

        parts.push('要求: 撰写模块深度分析文档。');
        parts.push('包含: 模块职责说明(从文件名和类名推断功能意图)、核心类型分析(不是简单罗列而是解释每个类的角色)、依赖关系分析、设计模式识别。');
        parts.push('如果能推断出数据流或协作关系，请用 Mermaid 图表展示。');
        break;
      }

      case 'getting-started': {
        parts.push('## 任务: 撰写快速上手指南');
        parts.push('');

        if (projectInfo.hasPackageSwift) parts.push('构建系统: Swift Package Manager');
        if (projectInfo.hasPodfile) parts.push('构建系统: CocoaPods');
        if (projectInfo.hasXcodeproj) parts.push('构建系统: Xcode Project');
        parts.push('');

        if (spmInfo.targets.length > 0) {
          const mainTargets = spmInfo.targets.filter(t => t.type !== 'test');
          const testTargets = spmInfo.targets.filter(t => t.type === 'test');
          if (mainTargets.length > 0) parts.push(`主要 Target: ${mainTargets.map(t => t.name).join(', ')}`);
          if (testTargets.length > 0) parts.push(`测试 Target: ${testTargets.map(t => t.name).join(', ')}`);
          parts.push('');
        }

        if (astInfo.overview?.entryPoints?.length > 0) {
          parts.push(`入口点: ${astInfo.overview.entryPoints.join(', ')}`);
          parts.push('');
        }

        parts.push('要求: 撰写开发者快速上手指南。');
        parts.push('包含: 环境要求、项目获取、依赖安装、构建步骤(具体命令)、运行测试、项目目录结构说明。');
        parts.push('语句清晰，步骤明确，适合新人阅读。');
        break;
      }

      case 'patterns': {
        parts.push('## 任务: 撰写代码模式与最佳实践文档');
        parts.push('');

        const groups = {};
        for (const r of knowledgeInfo.recipes) {
          const json = r.toJSON ? r.toJSON() : r;
          const cat = json.category || 'Other';
          if (!groups[cat]) groups[cat] = [];
          groups[cat].push(json);
        }

        for (const [cat, items] of Object.entries(groups).sort()) {
          parts.push(`### ${cat} (${items.length} 条)`);
          for (const item of items.slice(0, 8)) {
            parts.push(`- ${item.title}: ${item.description || 'N/A'}`);
            if (item.doClause) parts.push(`  应当: ${item.doClause}`);
            if (item.dontClause) parts.push(`  避免: ${item.dontClause}`);
            if (item.content?.pattern) parts.push(`  代码片段: ${item.content.pattern.slice(0, 200)}`);
          }
          parts.push('');
        }

        parts.push('要求: 撰写代码模式文档。对每个分类进行总结分析，解释模式的意义和应用场景。');
        parts.push('不要只列出条目 — 为每个分类写一段总结，解释该类模式的整体意图。附带代码示例(从数据中取)。');
        break;
      }

      case 'pattern-category': {
        const pd = topic._patternData;
        parts.push(`## 任务: 撰写 "${pd.category}" 分类的代码模式文档`);
        parts.push('');

        for (const item of pd.recipes) {
          parts.push(`### ${item.title}`);
          if (item.description) parts.push(`描述: ${item.description}`);
          if (item.doClause) parts.push(`应当: ${item.doClause}`);
          if (item.dontClause) parts.push(`避免: ${item.dontClause}`);
          if (item.reasoning?.whyStandard) parts.push(`原因: ${item.reasoning.whyStandard}`);
          if (item.content?.pattern) {
            parts.push('代码:');
            parts.push('```');
            parts.push(item.content.pattern.slice(0, 500));
            parts.push('```');
          }
          parts.push('');
        }

        parts.push('要求: 撰写该分类的详细代码模式文档。');
        parts.push('先写一段总结性概述，然后对每个模式做分析，解释为什么要遵循，给出正确和错误的对比示例。');
        break;
      }

      case 'reference': {
        parts.push('## 任务: 撰写协议参考文档');
        parts.push('');

        const protoByModule = astInfo.protocolNamesByModule || {};
        for (const [mod, protos] of Object.entries(protoByModule).sort()) {
          if (protos.length > 0) {
            parts.push(`### ${mod} 模块: ${protos.join(', ')}`);
          }
        }
        parts.push('');
        parts.push(`总计: ${astInfo.protocols.length} 个协议, ${astInfo.classes.length} 个类/结构体`);
        parts.push('');
        parts.push('要求: 撰写协议参考文档。按模块分组，分析每个协议的用途和意义，描述协议之间的关系和设计意图。');
        break;
      }
    }

    return parts.join('\n');
  }

  /**
   * 构建非 AI 降级的丰富模板内容
   * 即使没有 AI，也要产出有意义的内容 (不是只有列表罗列)
   */
  _buildFallbackArticle(topic, data, isZh) {
    const { projectInfo, astInfo, spmInfo, knowledgeInfo } = data;

    switch (topic.type) {
      case 'overview':
        return this._renderIndex(projectInfo, astInfo, spmInfo, knowledgeInfo, isZh, topic._allTopics);
      case 'architecture':
        return this._renderArchitecture(projectInfo, astInfo, spmInfo, isZh);
      case 'getting-started':
        return this._renderGettingStarted(projectInfo, spmInfo, astInfo, isZh);
      case 'module':
        return this._renderModule(topic._moduleData.target, astInfo, knowledgeInfo, isZh, projectInfo);
      case 'patterns':
        return this._renderPatterns(knowledgeInfo, isZh);
      case 'pattern-category':
        return this._renderPatternCategory(topic._patternData, isZh);
      case 'reference':
        return this._renderProtocolReference(astInfo, isZh);
      default:
        return '';
    }
  }

  // ═══ Markdown 渲染器 ═══════════════════════════════════════

  _renderIndex(project, ast, spm, knowledge, isZh, allTopics) {
    const title = isZh ? '项目概述' : 'Project Overview';

    const lines = [
      `# ${project.name} — ${title}`,
      '',
      `> ${isZh ? '本文档由 AutoSnippet Repo Wiki 自动生成' : 'Auto-generated by AutoSnippet Repo Wiki'}`,
      `> ${isZh ? '生成时间' : 'Generated at'}: ${new Date().toISOString()}`,
      '',
    ];

    // ── 项目简介 ──
    lines.push(`## ${isZh ? '简介' : 'Introduction'}`);
    lines.push('');

    const types = [];
    if (project.hasPackageSwift) types.push('SPM (Swift Package Manager)');
    if (project.hasPodfile)      types.push('CocoaPods');
    if (project.hasXcodeproj)    types.push('Xcode Project');

    const overview = ast.overview || {};
    const mainTargets = spm.targets.filter(t => t.type !== 'test');
    const testTargets = spm.targets.filter(t => t.type === 'test');

    if (isZh) {
      lines.push(`**${project.name}** 是一个 ${types.join(' + ') || 'iOS'} 项目，`
        + `包含 ${project.sourceFiles.length} 个源文件`
        + (overview.totalClasses ? `、${overview.totalClasses} 个类/结构体` : '')
        + (overview.totalProtocols ? `、${overview.totalProtocols} 个协议` : '')
        + `。`
      );
      if (mainTargets.length > 0) {
        lines.push(`项目由 ${mainTargets.length} 个功能模块组成`
          + (testTargets.length > 0 ? `，配备 ${testTargets.length} 个测试模块` : '')
          + `。`);
      }
    } else {
      lines.push(`**${project.name}** is a ${types.join(' + ') || 'iOS'} project `
        + `containing ${project.sourceFiles.length} source files`
        + (overview.totalClasses ? `, ${overview.totalClasses} classes/structs` : '')
        + (overview.totalProtocols ? `, ${overview.totalProtocols} protocols` : '')
        + `.`
      );
      if (mainTargets.length > 0) {
        lines.push(`The project consists of ${mainTargets.length} functional modules`
          + (testTargets.length > 0 ? ` with ${testTargets.length} test modules` : '')
          + `.`);
      }
    }
    lines.push('');

    // ── 模块总览 ──
    if (spm.targets.length > 0) {
      lines.push(`## ${isZh ? '模块总览' : 'Module Overview'}`);
      lines.push('');
      lines.push(`| ${isZh ? '模块' : 'Module'} | ${isZh ? '类型' : 'Type'} | ${isZh ? '源文件' : 'Files'} | ${isZh ? '类数' : 'Classes'} | ${isZh ? '协议数' : 'Protocols'} |`);
      lines.push('|--------|------|--------|--------|----------|');
      for (const t of spm.targets) {
        const moduleFiles = this._getModuleSourceFiles(t, project);
        const classCount = ast.classNamesByModule?.[t.name]?.length || 0;
        const protoCount = ast.protocolNamesByModule?.[t.name]?.length || 0;
        const hasDoc = allTopics?.some(tp => tp.type === 'module' && tp._moduleData?.target.name === t.name);
        const nameCol = hasDoc ? `[${t.name}](modules/${_slug(t.name)}.md)` : t.name;
        lines.push(`| ${nameCol} | ${t.type || 'target'} | ${moduleFiles.length || '-'} | ${classCount || '-'} | ${protoCount || '-'} |`);
      }
      lines.push('');
    }

    // ── 技术栈 ──
    lines.push(`## ${isZh ? '技术栈' : 'Tech Stack'}`);
    lines.push('');
    if (project.languages && Object.keys(project.languages).length > 0) {
      lines.push(`| ${isZh ? '语言' : 'Language'} | ${isZh ? '文件数' : 'Files'} | ${isZh ? '占比' : 'Share'} |`);
      lines.push('|--------|-------|------|');
      const total = Object.values(project.languages).reduce((a, b) => a + b, 0);
      for (const [lang, count] of Object.entries(project.languages).sort((a, b) => b[1] - a[1])) {
        const pct = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
        lines.push(`| ${lang} | ${count} | ${pct}% |`);
      }
      lines.push('');
    }

    // ── 核心数据 ──
    lines.push(`## ${isZh ? '核心数据' : 'Key Metrics'}`);
    lines.push('');
    lines.push(`| ${isZh ? '指标' : 'Metric'} | ${isZh ? '数量' : 'Count'} |`);
    lines.push('|--------|-------|');
    lines.push(`| ${isZh ? '源文件数' : 'Source Files'} | ${project.sourceFiles.length} |`);
    if (overview.totalClasses)   lines.push(`| ${isZh ? '类/结构体' : 'Classes/Structs'} | ${overview.totalClasses} |`);
    if (overview.totalProtocols) lines.push(`| ${isZh ? '协议' : 'Protocols'} | ${overview.totalProtocols} |`);
    if (overview.totalMethods)   lines.push(`| ${isZh ? '方法总数' : 'Methods'} | ${overview.totalMethods} |`);
    if (spm.targets.length > 0)  lines.push(`| SPM Targets | ${spm.targets.length} |`);
    if (knowledge.recipes.length > 0) lines.push(`| ${isZh ? '知识库条目' : 'KB Recipes'} | ${knowledge.recipes.length} |`);
    lines.push('');

    // ── 文档导航 (动态，基于实际生成的主题) ──
    const navTopics = (allTopics || []).filter(t => t.type !== 'overview');
    if (navTopics.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push(`## ${isZh ? '📖 文档导航' : '📖 Documentation'}`);
      lines.push('');
      for (const t of navTopics) {
        lines.push(`- [${t.title}](${t.path})`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  _renderArchitecture(project, ast, spm, isZh) {
    const lines = [
      `# ${isZh ? '架构总览' : 'Architecture Overview'}`,
      '',
      `> ${isZh ? '本文档由 AutoSnippet Repo Wiki 自动生成' : 'Auto-generated by AutoSnippet Repo Wiki'}`,
      '',
    ];

    // 依赖图 (Mermaid)
    if (spm.targets.length > 0) {
      lines.push(`## ${isZh ? '模块依赖图' : 'Module Dependency Graph'}`);
      lines.push('');
      lines.push('```mermaid');
      lines.push('graph TD');

      // 渲染 target 节点和依赖边
      const rendered = new Set();
      for (const target of spm.targets) {
        const sid = _mermaidId(target.name);
        if (!rendered.has(sid)) {
          const shape = target.type === 'test' ? `${sid}[["${target.name} (Test)"]]` : `${sid}["${target.name}"]`;
          lines.push(`    ${shape}`);
          rendered.add(sid);
        }
      }

      // 如果有依赖图数据，渲染边
      if (spm.depGraph) {
        const edges = spm.depGraph.edges || [];
        for (const edge of Array.isArray(edges) ? edges : []) {
          if (edge.from && edge.to) {
            const fromId = _mermaidId(edge.from.split('::').pop() || edge.from);
            const toId = _mermaidId(edge.to.split('::').pop() || edge.to);
            lines.push(`    ${fromId} --> ${toId}`);
          }
        }
      }

      lines.push('```');
      lines.push('');
    }

    // 分层架构
    if (ast.overview) {
      const modules = ast.overview.topLevelModules || [];
      if (modules.length > 0) {
        lines.push(`## ${isZh ? '顶层模块' : 'Top-Level Modules'}`);
        lines.push('');
        lines.push(`| ${isZh ? '模块' : 'Module'} | ${isZh ? '类数量' : 'Classes'} |`);
        lines.push('|--------|---------|');
        const cpm = ast.overview.classesPerModule || {};
        for (const mod of modules) {
          lines.push(`| ${mod} | ${cpm[mod] || 0} |`);
        }
        lines.push('');
      }

      // 入口点
      if (ast.overview.entryPoints?.length > 0) {
        lines.push(`## ${isZh ? '入口点' : 'Entry Points'}`);
        lines.push('');
        for (const ep of ast.overview.entryPoints) {
          lines.push(`- \`${ep}\``);
        }
        lines.push('');
      }
    }

    // 继承层次 (from CodeEntityGraph)
    if (this.codeEntityGraph) {
      try {
        const topClasses = this._getInheritanceRoots();
        if (topClasses.length > 0) {
          lines.push(`## ${isZh ? '核心继承层次' : 'Key Inheritance Hierarchy'}`);
          lines.push('');
          lines.push('```mermaid');
          lines.push('classDiagram');
          for (const root of topClasses.slice(0, 20)) {
            lines.push(`    class ${_mermaidId(root.name)}`);
            for (const child of root.children || []) {
              lines.push(`    ${_mermaidId(root.name)} <|-- ${_mermaidId(child)}`);
            }
          }
          lines.push('```');
          lines.push('');
        }
      } catch { /* non-critical */ }
    }

    lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](index.md)`);
    lines.push('');
    return lines.join('\n');
  }

  _renderModule(target, ast, knowledge, isZh, projectInfo) {
    const lines = [
      `# ${target.name}`,
      '',
      `> ${isZh ? '模块文档 — 由 AutoSnippet Repo Wiki 自动生成' : 'Module doc — Auto-generated by AutoSnippet Repo Wiki'}`,
      '',
    ];

    // 收集模块数据
    const moduleFiles = projectInfo ? this._getModuleSourceFiles(target, projectInfo) : [];
    const moduleClasses = ast.classNamesByModule?.[target.name] || [];
    const moduleProtocols = ast.protocolNamesByModule?.[target.name] || [];
    const deps = target.dependencies || target.info?.dependencies || [];

    // ── 模块概述 ──
    lines.push(`## ${isZh ? '概述' : 'Overview'}`);
    lines.push('');

    // 推断模块功能 (基于名称和内容)
    const purpose = this._inferModulePurpose(target.name, moduleClasses, moduleProtocols, moduleFiles);
    if (purpose) {
      lines.push(isZh
        ? `**${target.name}** ${purpose.zh}，包含 ${moduleFiles.length} 个源文件、${moduleClasses.length} 个类/结构体${moduleProtocols.length > 0 ? `、${moduleProtocols.length} 个协议` : ''}。`
        : `**${target.name}** ${purpose.en}, containing ${moduleFiles.length} source files, ${moduleClasses.length} classes/structs${moduleProtocols.length > 0 ? `, ${moduleProtocols.length} protocols` : ''}.`
      );
    } else {
      lines.push(isZh
        ? `**${target.name}** 是项目中的一个 ${target.type || 'target'} 模块，包含 ${moduleFiles.length} 个源文件、${moduleClasses.length} 个类/结构体。`
        : `**${target.name}** is a ${target.type || 'target'} module in the project, containing ${moduleFiles.length} source files and ${moduleClasses.length} classes/structs.`
      );
    }
    lines.push('');

    // ── 模块信息表 ──
    lines.push(`| ${isZh ? '属性' : 'Property'} | ${isZh ? '值' : 'Value'} |`);
    lines.push('|--------|------|');
    lines.push(`| ${isZh ? '类型' : 'Type'} | ${target.type || 'target'} |`);
    if (target.packageName)               lines.push(`| ${isZh ? '所属包' : 'Package'} | ${target.packageName} |`);
    if (target.path || target.info?.path) lines.push(`| ${isZh ? '路径' : 'Path'} | \`${target.path || target.info.path}\` |`);
    if (moduleFiles.length > 0)           lines.push(`| ${isZh ? '源文件数' : 'Source Files'} | ${moduleFiles.length} |`);
    if (moduleClasses.length > 0)         lines.push(`| ${isZh ? '类/结构体' : 'Classes/Structs'} | ${moduleClasses.length} |`);
    if (moduleProtocols.length > 0)       lines.push(`| ${isZh ? '协议' : 'Protocols'} | ${moduleProtocols.length} |`);
    if (deps.length > 0)                  lines.push(`| ${isZh ? '依赖数' : 'Dependencies'} | ${deps.length} |`);
    lines.push('');

    // ── 依赖 ──
    if (deps.length > 0) {
      lines.push(`## ${isZh ? '依赖关系' : 'Dependencies'}`);
      lines.push('');
      lines.push(isZh
        ? `${target.name} 依赖以下 ${deps.length} 个模块:`
        : `${target.name} depends on ${deps.length} module(s):`
      );
      lines.push('');
      for (const dep of deps) {
        const depName = typeof dep === 'string' ? dep : dep.name || String(dep);
        lines.push(`- \`${depName}\``);
      }
      lines.push('');
    }

    // ── 核心类型分析 ──
    if (moduleClasses.length > 0 || moduleProtocols.length > 0) {
      lines.push(`## ${isZh ? '核心类型' : 'Core Types'}`);
      lines.push('');

      if (moduleProtocols.length > 0) {
        lines.push(`### ${isZh ? '协议' : 'Protocols'} (${moduleProtocols.length})`);
        lines.push('');
        lines.push(isZh
          ? `${target.name} 定义了 ${moduleProtocols.length} 个协议，用于规范模块的接口边界:`
          : `${target.name} defines ${moduleProtocols.length} protocols establishing the module's interface contracts:`
        );
        lines.push('');
        const sorted = [...moduleProtocols].sort();
        for (const p of sorted.slice(0, 20)) {
          lines.push(`- \`${p}\``);
        }
        if (sorted.length > 20) {
          lines.push(`- ... ${isZh ? `还有 ${sorted.length - 20} 个` : `and ${sorted.length - 20} more`}`);
        }
        lines.push('');
      }

      if (moduleClasses.length > 0) {
        lines.push(`### ${isZh ? '类/结构体' : 'Classes/Structs'} (${moduleClasses.length})`);
        lines.push('');
        const sorted = [...moduleClasses].sort();
        for (const c of sorted.slice(0, 30)) {
          lines.push(`- \`${c}\``);
        }
        if (sorted.length > 30) {
          lines.push(`- ... ${isZh ? `还有 ${sorted.length - 30} 个` : `and ${sorted.length - 30} more`}`);
        }
        lines.push('');
      }
    }

    // ── 源文件分布 ──
    if (moduleFiles.length > 0) {
      lines.push(`## ${isZh ? '源文件分布' : 'Source File Distribution'}`);
      lines.push('');

      // 按语言统计
      const langCount = {};
      for (const f of moduleFiles) {
        const ext = path.extname(f);
        const lang = { '.swift': 'Swift', '.m': 'ObjC', '.h': 'Header', '.mm': 'ObjC++' }[ext] || ext;
        langCount[lang] = (langCount[lang] || 0) + 1;
      }

      lines.push(`| ${isZh ? '语言' : 'Language'} | ${isZh ? '文件数' : 'Files'} |`);
      lines.push('|--------|-------|');
      for (const [lang, count] of Object.entries(langCount).sort((a, b) => b - a)) {
        lines.push(`| ${lang} | ${count} |`);
      }
      lines.push('');
    }

    // ── 该模块相关的 Recipes ──
    if (knowledge.recipes.length > 0) {
      const related = knowledge.recipes.filter(r => {
        const json = r.toJSON ? r.toJSON() : r;
        return json.moduleName === target.name ||
               json.tags?.includes(target.name) ||
               json.title?.includes(target.name);
      });
      if (related.length > 0) {
        lines.push(`## ${isZh ? '相关知识条目' : 'Related Recipes'}`);
        lines.push('');
        lines.push(isZh
          ? `团队知识库中有 ${related.length} 条与 ${target.name} 相关的条目:`
          : `The team knowledge base contains ${related.length} entries related to ${target.name}:`
        );
        lines.push('');
        for (const r of related) {
          const json = r.toJSON ? r.toJSON() : r;
          lines.push(`### ${json.title}`);
          lines.push('');
          if (json.description) lines.push(json.description);
          if (json.doClause) lines.push(`\n**${isZh ? '✅ 应当' : '✅ Do'}**: ${json.doClause}`);
          if (json.dontClause) lines.push(`**${isZh ? '❌ 避免' : "❌ Don't"}**: ${json.dontClause}`);
          lines.push('');
        }
      }
    }

    lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](../index.md)`);
    lines.push('');
    return lines.join('\n');
  }

  /**
   * 基于模块名称和内容推断模块功能
   * 对常见命名模式做智能推断
   */
  _inferModulePurpose(name, classes, protocols, files) {
    const lower = name.toLowerCase();
    const fileNames = files.map(f => path.basename(f).toLowerCase());

    // 常见模块功能推断规则
    const rules = [
      { match: /network|http|api|client|request|fetch/i, zh: '负责网络通信和 API 调用', en: 'handles network communication and API calls' },
      { match: /ui|view|component|widget|screen|page/i, zh: '提供用户界面组件', en: 'provides user interface components' },
      { match: /model|entity|domain|data/i, zh: '定义数据模型和领域实体', en: 'defines data models and domain entities' },
      { match: /storage|database|cache|persist|core\s*data|realm/i, zh: '负责数据持久化和存储', en: 'manages data persistence and storage' },
      { match: /auth|login|session|token|credential/i, zh: '处理认证授权和会话管理', en: 'handles authentication and session management' },
      { match: /util|helper|extension|common|shared|foundation/i, zh: '提供公共工具类和扩展方法', en: 'provides common utilities and extensions' },
      { match: /test|spec|mock/i, zh: '包含单元测试和 Mock', en: 'contains unit tests and mocks' },
      { match: /router|navigation|coordinator|flow/i, zh: '管理页面路由和导航流', en: 'manages page routing and navigation flow' },
      { match: /config|setting|preference|env/i, zh: '管理应用配置和环境设置', en: 'manages app configuration and environment settings' },
      { match: /log|analytics|track|monitor/i, zh: '提供日志记录和数据分析能力', en: 'provides logging and analytics capabilities' },
      { match: /media|image|video|audio|player/i, zh: '处理多媒体资源', en: 'handles multimedia resources' },
      { match: /service|manager|provider/i, zh: '提供核心业务服务', en: 'provides core business services' },
    ];

    // 先按模块名匹配
    for (const rule of rules) {
      if (rule.match.test(lower)) return rule;
    }

    // 再按类名匹配
    const classStr = classes.join(' ');
    for (const rule of rules) {
      if (rule.match.test(classStr)) return rule;
    }

    return null;
  }

  // _renderComponents removed in V3 — components are now part of module docs

  _renderPatterns(knowledge, isZh) {
    const lines = [
      `# ${isZh ? '代码模式与最佳实践' : 'Code Patterns & Best Practices'}`,
      '',
      `> ${isZh ? '团队沉淀的代码模式与最佳实践（来自 AutoSnippet 知识库）' : 'Code patterns and best practices from AutoSnippet knowledge base'}`,
      '',
    ];

    // 按 category 分组
    const groups = {};
    for (const r of knowledge.recipes) {
      const json = r.toJSON ? r.toJSON() : r;
      const cat = json.category || 'Other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(json);
    }

    // 总结
    const totalRecipes = knowledge.recipes.length;
    const catCount = Object.keys(groups).length;
    lines.push(isZh
      ? `本项目团队在 ${catCount} 个分类下共沉淀了 **${totalRecipes}** 条代码模式和最佳实践。以下按分类进行展示和分析。`
      : `The team has accumulated **${totalRecipes}** code patterns across ${catCount} categories. Below they are organized and analyzed by category.`
    );
    lines.push('');

    for (const [cat, items] of Object.entries(groups).sort()) {
      lines.push(`## ${cat} (${items.length})`);
      lines.push('');

      // 分类概述
      lines.push(isZh
        ? `${cat} 分类包含 ${items.length} 条规则，覆盖了该领域的核心规范。`
        : `The ${cat} category contains ${items.length} rules covering core conventions in this area.`
      );
      lines.push('');

      for (const item of items) {
        lines.push(`### ${item.title}`);
        lines.push('');
        if (item.description) {
          lines.push(item.description);
          lines.push('');
        }
        if (item.content?.pattern) {
          lines.push('```' + (item.language || 'swift'));
          lines.push(item.content.pattern);
          lines.push('```');
          lines.push('');
        }
        if (item.doClause) {
          lines.push(`**${isZh ? '✅ 应当' : '✅ Do'}**: ${item.doClause}`);
          lines.push('');
        }
        if (item.dontClause) {
          lines.push(`**${isZh ? '❌ 避免' : "❌ Don't"}**: ${item.dontClause}`);
          lines.push('');
        }
        if (item.reasoning?.whyStandard) {
          lines.push(`> ${isZh ? '💡 原因' : '💡 Rationale'}: ${item.reasoning.whyStandard}`);
          lines.push('');
        }
      }
    }

    lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](index.md)`);
    lines.push('');
    return lines.join('\n');
  }

  // ═══ V3 新增渲染器 ════════════════════════════════════════

  /**
   * 快速上手指南 (非 AI 降级模板)
   */
  _renderGettingStarted(project, spm, ast, isZh) {
    const lines = [
      `# ${isZh ? '快速上手' : 'Getting Started'}`,
      '',
      `> ${isZh ? '本文档由 AutoSnippet Repo Wiki 自动生成' : 'Auto-generated by AutoSnippet Repo Wiki'}`,
      '',
    ];

    // 环境要求
    lines.push(`## ${isZh ? '环境要求' : 'Prerequisites'}`);
    lines.push('');
    if (project.hasPackageSwift) {
      lines.push(isZh ? '- Swift 5.5+ (推荐 Swift 5.9+)' : '- Swift 5.5+ (Swift 5.9+ recommended)');
      lines.push(isZh ? '- Xcode 14+' : '- Xcode 14+');
    }
    if (project.hasPodfile) {
      lines.push(isZh ? '- CocoaPods 1.10+' : '- CocoaPods 1.10+');
    }
    if (project.hasXcodeproj) {
      lines.push(isZh ? '- Xcode (最新稳定版)' : '- Xcode (latest stable version)');
    }
    lines.push('');

    // 项目目录结构
    lines.push(`## ${isZh ? '项目结构' : 'Project Structure'}`);
    lines.push('');
    lines.push('```');
    lines.push(`${project.name}/`);
    if (spm.targets.length > 0) {
      const mainTargets = spm.targets.filter(t => t.type !== 'test');
      const testTargets = spm.targets.filter(t => t.type === 'test');
      if (mainTargets.length > 0) {
        lines.push('├── Sources/');
        for (let i = 0; i < mainTargets.length; i++) {
          const prefix = i === mainTargets.length - 1 && testTargets.length === 0 ? '│   └──' : '│   ├──';
          lines.push(`${prefix} ${mainTargets[i].name}/`);
        }
      }
      if (testTargets.length > 0) {
        lines.push('├── Tests/');
        for (let i = 0; i < testTargets.length; i++) {
          const prefix = i === testTargets.length - 1 ? '│   └──' : '│   ├──';
          lines.push(`${prefix} ${testTargets[i].name}/`);
        }
      }
    }
    if (project.hasPackageSwift) lines.push('├── Package.swift');
    if (project.hasPodfile) lines.push('├── Podfile');
    lines.push('```');
    lines.push('');

    // 构建步骤
    lines.push(`## ${isZh ? '构建与运行' : 'Build & Run'}`);
    lines.push('');
    if (project.hasPackageSwift) {
      lines.push(isZh ? '### 使用 Swift Package Manager' : '### Using Swift Package Manager');
      lines.push('');
      lines.push('```bash');
      lines.push(isZh ? '# 获取项目' : '# Clone the project');
      lines.push(`git clone <repository-url>`);
      lines.push(`cd ${project.name}`);
      lines.push('');
      lines.push(isZh ? '# 解析依赖' : '# Resolve dependencies');
      lines.push('swift package resolve');
      lines.push('');
      lines.push(isZh ? '# 构建' : '# Build');
      lines.push('swift build');
      lines.push('');
      lines.push(isZh ? '# 运行测试' : '# Run tests');
      lines.push('swift test');
      lines.push('```');
      lines.push('');
    }
    if (project.hasPodfile) {
      lines.push(isZh ? '### 使用 CocoaPods' : '### Using CocoaPods');
      lines.push('');
      lines.push('```bash');
      lines.push('pod install');
      lines.push('open *.xcworkspace');
      lines.push('```');
      lines.push('');
    }

    // 模块说明
    if (spm.targets.length > 0) {
      const mainTargets = spm.targets.filter(t => t.type !== 'test');
      if (mainTargets.length > 0) {
        lines.push(`## ${isZh ? '核心模块' : 'Core Modules'}`);
        lines.push('');
        lines.push(`| ${isZh ? '模块' : 'Module'} | ${isZh ? '类型' : 'Type'} | ${isZh ? '类型数' : 'Types'} | ${isZh ? '说明' : 'Description'} |`);
        lines.push('|--------|------|--------|------|');
        for (const t of mainTargets) {
          const cls = (ast.classNamesByModule?.[t.name] || []).length;
          const purpose = this._inferModulePurpose(t.name, ast.classNamesByModule?.[t.name] || [], ast.protocolNamesByModule?.[t.name] || [], []);
          const desc = purpose ? (isZh ? purpose.zh : purpose.en) : '-';
          lines.push(`| ${t.name} | ${t.type || 'library'} | ${cls} | ${desc} |`);
        }
        lines.push('');
      }
    }

    lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](index.md)`);
    lines.push('');
    return lines.join('\n');
  }

  /**
   * 按分类拆分的代码模式文档
   */
  _renderPatternCategory(patternData, isZh) {
    const { category, recipes } = patternData;
    const lines = [
      `# ${category}`,
      '',
      `> ${isZh ? `${category} 分类下的 ${recipes.length} 条代码模式（来自 AutoSnippet 知识库）` : `${recipes.length} code patterns in ${category} category (from AutoSnippet KB)`}`,
      '',
    ];

    // 分类概述
    lines.push(isZh
      ? `本文档收录了 ${category} 分类下的 ${recipes.length} 条代码模式和规范，这些规则由团队在开发实践中总结沉淀。`
      : `This document covers ${recipes.length} code patterns and conventions in the ${category} category, distilled from team development practices.`
    );
    lines.push('');

    for (const item of recipes) {
      lines.push(`## ${item.title}`);
      lines.push('');
      if (item.description) {
        lines.push(item.description);
        lines.push('');
      }
      if (item.doClause) {
        lines.push(`**${isZh ? '✅ 应当' : '✅ Do'}**: ${item.doClause}`);
        lines.push('');
      }
      if (item.dontClause) {
        lines.push(`**${isZh ? '❌ 避免' : "❌ Don't"}**: ${item.dontClause}`);
        lines.push('');
      }
      if (item.content?.pattern) {
        lines.push('```' + (item.language || 'swift'));
        lines.push(item.content.pattern);
        lines.push('```');
        lines.push('');
      }
      if (item.reasoning?.whyStandard) {
        lines.push(`> ${isZh ? '💡 原因' : '💡 Rationale'}: ${item.reasoning.whyStandard}`);
        lines.push('');
      }
    }

    lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](../index.md)`);
    lines.push('');
    return lines.join('\n');
  }

  /**
   * 协议参考文档
   */
  _renderProtocolReference(ast, isZh) {
    const lines = [
      `# ${isZh ? '协议参考' : 'Protocol Reference'}`,
      '',
      `> ${isZh ? `项目中定义的 ${ast.protocols.length} 个协议` : `${ast.protocols.length} protocols defined in the project`}`,
      '',
    ];

    lines.push(isZh
      ? `协议（Protocol）定义了类型需要遵循的接口契约。本项目共定义了 ${ast.protocols.length} 个协议，以下按模块分组展示。`
      : `Protocols define interface contracts that types must conform to. This project defines ${ast.protocols.length} protocols, organized by module below.`
    );
    lines.push('');

    // 按模块分组
    const protoByModule = ast.protocolNamesByModule || {};
    const grouped = new Set();

    for (const [mod, protos] of Object.entries(protoByModule).sort()) {
      if (protos.length === 0) continue;
      lines.push(`## ${mod}`);
      lines.push('');
      lines.push(isZh
        ? `${mod} 模块定义了 ${protos.length} 个协议:`
        : `${mod} module defines ${protos.length} protocols:`
      );
      lines.push('');
      for (const p of protos.sort()) {
        lines.push(`- \`${p}\``);
        grouped.add(p);
      }
      lines.push('');
    }

    // 未分组的协议
    const ungrouped = ast.protocols.filter(p => !grouped.has(p));
    if (ungrouped.length > 0) {
      lines.push(`## ${isZh ? '其他协议' : 'Other Protocols'}`);
      lines.push('');
      for (const p of ungrouped.sort()) {
        lines.push(`- \`${p}\``);
      }
      lines.push('');
    }

    lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](index.md)`);
    lines.push('');
    return lines.join('\n');
  }

  // ═══ V3 AI 系统 Prompt ═══════════════════════════════════

  /**
   * 构建 AI 系统 Prompt (V3 — 撰写完整文章，非润色骨架)
   */
  _buildAiSystemPrompt(isZh) {
    if (isZh) {
      return [
        '你是 AutoSnippet Repo Wiki 文档撰写专家。',
        '',
        '任务: 基于代码分析数据，撰写高质量、有深度的项目文档。',
        '',
        '写作原则:',
        '1. 所有类名、文件名、数字必须来自提供的数据，严禁编造',
        '2. 不要简单罗列数据 — 要分析和解释，描述"为什么这样设计"、"模块的职责是什么"',
        '3. 从文件名和类名推断功能意图，给出有见地的分析',
        '4. 用自然语言连贯行文，包含过渡段落和总结性描述',
        '5. 合理使用 Mermaid 图表（graph TD / classDiagram）、表格、代码块来辅助说明',
        '6. 用中文撰写',
        '7. 输出纯 Markdown，不要包裹在代码块中',
        '8. 每篇文章以一级标题 (#) 开始，结构清晰',
        '9. 篇幅适中：300-2000 字（根据主题复杂度调整）',
        '10. 文末包含返回链接: [← 返回概述](index.md) 或 [← 返回概述](../index.md)',
      ].join('\n');
    }
    return [
      'You are the AutoSnippet Repo Wiki documentation expert.',
      '',
      'Task: Write high-quality, insightful project documentation based on code analysis data.',
      '',
      'Writing principles:',
      '1. All class names, file names, and numbers must come from the provided data — never fabricate',
      '2. Do not simply list data — analyze and explain: describe design rationale, module responsibilities',
      '3. Infer functional intent from file names and class names, provide insightful analysis',
      '4. Write coherent prose with transition paragraphs and summaries',
      '5. Use Mermaid diagrams (graph TD / classDiagram), tables, and code blocks judiciously',
      '6. Write in English',
      '7. Output pure Markdown — do not wrap in code blocks',
      '8. Start each article with a level-1 heading (#), maintain clear structure',
      '9. Appropriate length: 300-2000 words (adjust by topic complexity)',
      '10. End with a back link: [← Back to Overview](index.md) or [← Back to Overview](../index.md)',
    ].join('\n');
  }

  // ═══ Phase 8: 同步 Cursor 端 MD ═══════════════════════════

  /**
   * 同步 Cursor 端保存的 MD 到 wiki 目录
   *
   * 同步源:
   *   1. .cursor/skills/autosnippet-devdocs/references/ (*.md)  → wiki/documents/
   *
   * @returns {Array<{path: string, hash: string, size: number, source: string}>}
   */
  _syncCursorDocs() {
    const synced = [];
    const isZh = this.options.language === 'zh';

    // ── Source 1: Channel D devdocs ──
    const devdocsDir = path.join(this.projectRoot, '.cursor', 'skills', 'autosnippet-devdocs', 'references');
    if (fs.existsSync(devdocsDir)) {
      this._ensureDir(path.join(this.wikiDir, 'documents'));
      const files = fs.readdirSync(devdocsDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(devdocsDir, file), 'utf-8');
          const header = `<!-- synced from .cursor/skills/autosnippet-devdocs/references/${file} -->\n\n`;
          const result = this._writeFile(`documents/${file}`, header + content);
          result.source = 'cursor-devdocs';
          synced.push(result);
        } catch { /* skip */ }
      }
    }

    // 生成目录索引
    this._generateSyncIndex(synced, isZh);

    logger.info(`[WikiGenerator] Synced ${synced.length} docs from Cursor`);
    this._emit(WikiPhase.SYNC_DOCS, 88, `同步完成: ${synced.length} 个文档`);
    return synced;
  }

  /**
   * 为同步目录生成索引页
   */
  _generateSyncIndex(synced, isZh) {
    const docFiles = synced.filter(f => f.path.startsWith('documents/'));

    if (docFiles.length > 0) {
      const lines = [
        `# ${isZh ? '开发文档' : 'Developer Documents'}`,
        '',
        `> ${isZh ? '由 Cursor Agent 创建并同步到 Wiki 的开发文档' : 'Development documents created by Cursor Agent and synced to Wiki'}`,
        '',
        `| ${isZh ? '文档' : 'Document'} | ${isZh ? '来源' : 'Source'} |`,
        '|--------|--------|',
      ];
      for (const f of docFiles) {
        const name = path.basename(f.path, '.md');
        lines.push(`| [${name}](${path.basename(f.path)}) | ${f.source} |`);
      }
      lines.push('');
      this._writeFile('documents/_index.md', lines.join('\n'));
    }
  }

  // ═══ Phase 9: 去重 ═════════════════════════════════════════

  /**
   * 两层去重
   *
   * Layer 1: Title slug 碰撞 — 同名文件不同目录 → hash 相同则删除副本
   * Layer 2: Content hash    — 跨文件内容完全相同 → 仅保留第一个
   *
   * @param {Array} files
   * @returns {{ removed: string[], kept: number }}
   */
  _dedup(files) {
    const removed = [];

    // Layer 1: slug 碰撞（同名文件跨目录）
    const slugMap = new Map(); // slug → first file
    for (const file of files) {
      const slug = path.basename(file.path, path.extname(file.path)).toLowerCase();
      if (slugMap.has(slug)) {
        const existing = slugMap.get(slug);
        // 完全相同 hash → 移除后来的
        if (existing.hash === file.hash) {
          const fullPath = path.join(this.wikiDir, file.path);
          try { fs.unlinkSync(fullPath); } catch { /* skip */ }
          removed.push(file.path);
          logger.info(`[WikiGenerator] Dedup: removed ${file.path} (same hash as ${existing.path})`);
        }
        // hash 不同 → 保留两个（不同目录允许同名）
      } else {
        slugMap.set(slug, file);
      }
    }

    // Layer 2: content hash 碰撞（不同文件名但内容相同）
    const hashMap = new Map(); // hash → first file path
    for (const file of files) {
      if (removed.includes(file.path)) continue;
      if (hashMap.has(file.hash)) {
        const firstPath = hashMap.get(file.hash);
        // 优先保留代码生成的（非 synced）
        const isFirstSynced = firstPath.startsWith('documents/') || firstPath.startsWith('skills/');
        const isCurrentSynced = file.path.startsWith('documents/') || file.path.startsWith('skills/');

        if (isCurrentSynced && !isFirstSynced) {
          // 当前是 synced，first 是 codegen → 删除 synced
          const fullPath = path.join(this.wikiDir, file.path);
          try { fs.unlinkSync(fullPath); } catch { /* skip */ }
          removed.push(file.path);
          logger.info(`[WikiGenerator] Dedup: removed synced ${file.path} (same content as ${firstPath})`);
        }
        // 其他情况保留两个
      } else {
        hashMap.set(file.hash, file.path);
      }
    }

    // 从 files 数组中移除已删除的
    for (let i = files.length - 1; i >= 0; i--) {
      if (removed.includes(files[i].path)) {
        files.splice(i, 1);
      }
    }

    if (removed.length > 0) {
      this._emit(WikiPhase.DEDUP, 93, `去重: 移除 ${removed.length} 个重复文件`);
    } else {
      this._emit(WikiPhase.DEDUP, 93, '无重复文件');
    }

    return { removed, kept: files.length };
  }

  // ═══ 辅助方法 ══════════════════════════════════════════════

  /** 从 CodeEntityGraph 提取继承根节点 */
  _getInheritanceRoots() {
    if (!this.codeEntityGraph) return [];
    try {
      // 尝试查询继承关系
      const entities = this.codeEntityGraph.queryEntities?.({ entityType: 'class', limit: 50 }) || [];
      const roots = [];
      for (const e of entities) {
        const parents = this.codeEntityGraph.queryEdges?.({ toId: e.entityId, relation: 'inherits' }) || [];
        const children = this.codeEntityGraph.queryEdges?.({ fromId: e.entityId, relation: 'inherits' }) || [];
        if (children.length > 0) {
          roots.push({ name: e.name, children: children.map(c => c.toId || c.to_id) });
        }
      }
      return roots.sort((a, b) => (b.children?.length || 0) - (a.children?.length || 0));
    } catch {
      return [];
    }
  }

  _emit(phase, progress, message) {
    try {
      this.onProgress(phase, progress, message);
    } catch { /* non-critical */ }
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _writeFile(relativePath, content) {
    const fullPath = path.join(this.wikiDir, relativePath);
    this._ensureDir(path.dirname(fullPath));
    fs.writeFileSync(fullPath, content, 'utf-8');

    const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
    return { path: relativePath, hash, size: Buffer.byteLength(content) };
  }

  _writeMeta(files, startTime, dedupResult) {
    const meta = {
      version: '3.0.0',
      generator: 'AutoSnippet WikiGenerator V3',
      generatedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      projectRoot: this.projectRoot,
      language: this.options.language,
      files: files.map(f => ({
        path: f.path,
        hash: f.hash,
        size: f.size,
        ...(f.source ? { source: f.source } : {}),
        ...(f.polished ? { polished: true } : {}),
      })),
      sourceHash: this._computeSourceHash(),
      ...(dedupResult ? { dedup: dedupResult } : {}),
    };
    fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    return meta;
  }

  _readMeta() {
    try {
      if (!fs.existsSync(this.metaPath)) return null;
      return JSON.parse(fs.readFileSync(this.metaPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** 检测源码是否有变更（简化：对比 sourceHash） */
  _detectChanges(meta) {
    if (!meta?.sourceHash) return true;
    return meta.sourceHash !== this._computeSourceHash();
  }

  /** 计算项目源文件的简易 hash（基于文件名列表 + 总大小） */
  _computeSourceHash() {
    try {
      const extSet = new Set(['.swift', '.m', '.h', '.mm']);
      let totalSize = 0;
      const names = [];
      this._walkDir(this.projectRoot, (filePath) => {
        const ext = path.extname(filePath);
        if (extSet.has(ext)) {
          const stat = fs.statSync(filePath);
          totalSize += stat.size;
          names.push(path.relative(this.projectRoot, filePath));
        }
      }, 2000);

      names.sort();
      const payload = names.join('\n') + '\n' + totalSize;
      return createHash('sha256').update(payload).digest('hex').slice(0, 16);
    } catch {
      return 'unknown';
    }
  }

  /**
   * 遍历目录（排除 build/Pods/DerivedData 等）
   */
  _walkDir(dir, callback, maxFiles = 500) {
    const excludeNames = new Set([
      'Pods', 'Carthage', 'node_modules', '.build', 'build', 'DerivedData',
      'vendor', '.git', '__tests__', 'Tests', 'AutoSnippet', '.cursor',
    ]);
    let count = 0;

    const walk = (d) => {
      if (count >= maxFiles) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (count >= maxFiles) return;
        if (excludeNames.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          callback(fullPath);
          count++;
        }
      }
    };

    walk(dir);
  }

  _abortedResult() {
    return { success: false, error: 'aborted', duration: 0 };
  }

  /**
   * 从文件相对路径推断所属模块名
   * SPM 约定: Sources/{ModuleName}/... → ModuleName
   * 否则取第一级目录名
   */
  _inferModuleFromPath(filePath) {
    const parts = filePath.split('/');
    const sourcesIdx = parts.indexOf('Sources');
    if (sourcesIdx >= 0 && sourcesIdx + 1 < parts.length) {
      return parts[sourcesIdx + 1];
    }
    return parts.length > 1 ? parts[0] : null;
  }

  /**
   * 获取某个 Target 对应的源文件列表
   * 按优先级匹配: target.path → target.info.path → sourceFilesByModule[name]
   */
  _getModuleSourceFiles(target, projectInfo) {
    const sfm = projectInfo.sourceFilesByModule || {};
    const name = target.name;

    // 1. 按模块名直接匹配（最常见: Sources/{name}/ 解析出的 key）
    if (sfm[name]?.length > 0) return sfm[name];

    // 2. 通过 target.path 或 target.info.path 匹配
    const targetPath = target.path || target.info?.path;
    if (targetPath) {
      const matched = (projectInfo.sourceFiles || []).filter(f =>
        f.startsWith(targetPath + '/') || f.startsWith(targetPath + path.sep)
      );
      if (matched.length > 0) return matched;
    }

    // 3. 大小写不敏感模糊匹配
    const lower = name.toLowerCase();
    for (const [key, files] of Object.entries(sfm)) {
      if (key.toLowerCase() === lower) return files;
    }

    return [];
  }
}

// ─── 工具函数 ────────────────────────────────────────────────

function _slug(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

function _mermaidId(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

export default WikiGenerator;
