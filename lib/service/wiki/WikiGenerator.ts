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

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Logger from '../../infrastructure/logging/Logger.js';
import { LanguageService } from '../../shared/LanguageService.js';
import {
  buildAiSystemPrompt,
  buildArticlePrompt,
  buildFallbackArticle,
  type WikiData,
} from './WikiRenderers.js';
import {
  dedup,
  detectBuildSystems,
  getLangTerms,
  getModuleSourceFiles,
  inferModuleFromPath,
  profileFolders,
  slug,
  walkDir,
} from './WikiUtils.js';

const logger = Logger.getInstance();

/** Resolved WikiGenerator options */
interface WikiOptions {
  wikiDir: string;
  language: string;
  maxFiles: number;
  includeRecipes: boolean;
  includeDepGraph: boolean;
  includeComponents: boolean;
  [key: string]: unknown;
}

/** WikiGenerator constructor dependencies */
export interface WikiDeps {
  projectRoot: string;
  moduleService?: WikiModuleService | null;
  knowledgeService?: WikiKnowledgeService | null;
  projectGraph?: WikiProjectGraph | null;
  codeEntityGraph?: Record<string, unknown> | null;
  aiProvider?: WikiAiProvider | null;
  onProgress?: (phase: string, progress: number, message: string) => void;
  options?: Partial<WikiOptions>;
  [key: string]: unknown;
}

/** Minimal ProjectGraph interface */
export interface WikiProjectGraph {
  getOverview(): Record<string, unknown>;
  getAllClassNames(): string[];
  getAllProtocolNames(): string[];
  getClassInfo(name: string): { filePath?: string } | null;
  getProtocolInfo(name: string): { filePath?: string } | null;
}

/** Minimal ModuleService interface */
export interface WikiModuleService {
  load(): Promise<void>;
  listTargets(): Promise<WikiModuleTarget[]>;
  getDependencyGraph?(opts: Record<string, unknown>): Promise<unknown>;
  getProjectInfo(): Record<string, unknown>;
}

/** Module target descriptor */
interface WikiModuleTarget {
  name: string;
  path?: string;
  type?: string;
  dependencies?: unknown[];
  info?: { dependencies?: unknown[]; path?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Minimal KnowledgeService interface */
export interface WikiKnowledgeService {
  list(filter: Record<string, unknown>): Promise<{
    data?: Record<string, unknown>[];
    items?: Record<string, unknown>[];
    [key: string]: unknown;
  }>;
  getStats?(): Promise<Record<string, unknown> | null>;
}

/** Minimal AiProvider interface */
export interface WikiAiProvider {
  chat(prompt: string, options: Record<string, unknown>): Promise<string>;
}

/** Topic descriptor from _discoverTopics */
interface WikiTopic {
  id: string;
  path: string;
  title: string;
  type: string;
  priority: number;
  _moduleData?: Record<string, unknown>;
  _patternData?: Record<string, unknown>;
  _folderProfiles?: Record<string, unknown>[];
  _folderProfile?: Record<string, unknown>;
  _allTopics?: WikiTopic[];
  [key: string]: unknown;
}

/** File write result */
interface WikiFileResult {
  path: string;
  hash: string;
  size: number;
  source?: string;
  polished?: boolean;
}

/** Scan project result */
interface ProjectScanInfo {
  name: string;
  root: string;
  buildSystems: { eco: string; buildTool: string }[];
  sourceFiles: string[];
  languages: Record<string, number>;
  langProfile: Record<string, unknown> | null;
  primaryLanguage: string;
  hasPackageSwift: boolean;
  hasPodfile: boolean;
  hasXcodeproj: boolean;
  sourceFilesByModule: Record<string, string[]>;
  [key: string]: unknown;
}

// ─── Wiki 生成阶段 ──────────────────────────────────────────

export const WikiPhase = Object.freeze({
  INIT: 'init', // 初始化 & 自检
  SCAN: 'scan', // 扫描项目结构
  AST_ANALYZE: 'ast-analyze', // AST 深度分析
  SPM_PARSE: 'spm-parse', // SPM 依赖解析
  KNOWLEDGE: 'knowledge', // 整合已有 Recipes
  GENERATE: 'generate', // 生成 Markdown 骨架
  AI_COMPOSE: 'ai-compose', // AI 合成写作增强
  SYNC_DOCS: 'sync-docs', // 同步 Cursor 端 MD
  DEDUP: 'dedup', // 去重
  FINALIZE: 'finalize', // 写入 meta.json
});

// ─── 默认配置 ────────────────────────────────────────────────

const DEFAULTS = {
  wikiDir: 'AutoSnippet/wiki',
  language: 'zh', // 'zh' | 'en'
  maxFiles: 500,
  includeRecipes: true,
  includeDepGraph: true,
  includeComponents: true,
};

// ─── WikiGenerator ────────────────────────────────────────────

export class WikiGenerator {
  projectRoot: string;
  wikiDir: string;
  _aborted: boolean;
  aiProvider: WikiAiProvider | null;
  codeEntityGraph: Record<string, unknown> | null;
  knowledgeService: WikiKnowledgeService | null;
  metaPath: string;
  moduleService: WikiModuleService | null;
  onProgress: (phase: string, progress: number, message: string) => void;
  options: WikiOptions;
  projectGraph: WikiProjectGraph | null;
  /**
   * @param {object} deps
   * @param {string} deps.projectRoot
   * @param {import('../../service/module/ModuleService.js').ModuleService} [deps.moduleService]
   * @param {import('../../platform/ios/spm/SpmHelper.js').SpmHelper} [deps.spmService] 向后兼容
   * @param {import('../../service/knowledge/KnowledgeService.js').KnowledgeService} [deps.knowledgeService]
   * @param {import('../../core/ast/ProjectGraph.js').default} [deps.projectGraph]
   * @param {import('../../service/knowledge/CodeEntityGraph.js').CodeEntityGraph} [deps.codeEntityGraph]
   * @param {import('../../external/ai/AiProvider.js').AiProvider} [deps.aiProvider]
   * @param {Function} [deps.onProgress] - (phase, progress, message) => void
   * @param {object} [deps.options]
   */
  constructor(deps: WikiDeps) {
    this.projectRoot = deps.projectRoot;
    this.moduleService = deps.moduleService || null;
    this.knowledgeService = deps.knowledgeService || null;
    this.projectGraph = deps.projectGraph || null;
    this.codeEntityGraph = deps.codeEntityGraph || null;
    this.aiProvider = deps.aiProvider || null;
    this.onProgress = deps.onProgress || (() => {});
    this.options = { ...DEFAULTS, ...deps.options } as WikiOptions;

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
      if (this._aborted) {
        return this._abortedResult();
      }

      // Phase 3: AST analyze
      this._emit(WikiPhase.AST_ANALYZE, 15, '执行 AST 深度分析...');
      const astInfo = await this._analyzeAST();
      if (this._aborted) {
        return this._abortedResult();
      }

      // Phase 4: Module/SPM parse
      this._emit(WikiPhase.SPM_PARSE, 30, '解析模块依赖关系...');
      const moduleInfo = await this._parseModules();
      if (this._aborted) {
        return this._abortedResult();
      }

      // Phase 5: Knowledge integration
      this._emit(WikiPhase.KNOWLEDGE, 45, '整合知识库 Recipes...');
      const knowledgeInfo = await this._integrateKnowledge();
      if (this._aborted) {
        return this._abortedResult();
      }

      // Phase 6: Content-driven topic discovery (V3)
      this._emit(WikiPhase.GENERATE, 50, '分析项目数据，发现文档主题...');
      const structuredData: WikiData = {
        projectInfo,
        astInfo,
        moduleInfo,
        knowledgeInfo,
      } as WikiData;
      const topics = this._discoverTopics(projectInfo, astInfo, moduleInfo, knowledgeInfo);
      if (this._aborted) {
        return this._abortedResult();
      }

      // Phase 7: AI-first article composition (V3)
      this._emit(WikiPhase.AI_COMPOSE, 55, `撰写 ${topics.length} 篇文档...`);
      const files = await this._composeArticles(topics, structuredData);
      if (this._aborted) {
        return this._abortedResult();
      }

      // Phase 8: Sync Cursor docs
      this._emit(WikiPhase.SYNC_DOCS, 80, '同步 Cursor 端文档...');
      const syncedFiles = this._syncCursorDocs();
      files.push(...syncedFiles);
      if (this._aborted) {
        return this._abortedResult();
      }

      // Phase 9: Dedup
      this._emit(WikiPhase.DEDUP, 90, '去重检查...');
      const dedupResult = dedup(files, this.wikiDir, this._emit.bind(this));

      // Phase 10: Finalize
      this._emit(WikiPhase.FINALIZE, 95, '写入元数据...');
      const meta = this._writeMeta(files, startTime, dedupResult);

      const duration = Date.now() - startTime;
      this._emit(WikiPhase.FINALIZE, 100, `Wiki 生成完成，耗时 ${(duration / 1000).toFixed(1)}s`);

      return {
        success: true,
        filesGenerated: files.length,
        aiComposed: files.filter((f) => f.polished).length,
        syncedDocs: syncedFiles.length,
        dedup: dedupResult,
        duration,
        wikiDir: this.wikiDir,
        meta,
      };
    } catch (err: unknown) {
      logger.error('[WikiGenerator] Generation failed', { error: (err as Error).message });
      this._emit('error', -1, `生成失败: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message, duration: Date.now() - startTime };
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
    const info: ProjectScanInfo = {
      name: path.basename(this.projectRoot),
      root: this.projectRoot,
      // 通用构建系统检测（替代硬编码 iOS 三件套）
      buildSystems: [], // [{eco, buildTool}]
      sourceFiles: [],
      languages: {},
      langProfile: null, // LanguageService.detectProfile() 结果
      primaryLanguage: 'unknown',
      // 保留向后兼容字段
      hasPackageSwift: false,
      hasPodfile: false,
      hasXcodeproj: false,
      sourceFilesByModule: {},
    };

    // 检测项目类型
    const entries = fs.readdirSync(this.projectRoot, { withFileTypes: true });
    const entryNames = entries.map((e) => e.name);

    // 通用构建系统检测 (支持一级子目录 monorepo)
    info.buildSystems = detectBuildSystems(entryNames, this.projectRoot);

    // 向后兼容三字段
    for (const e of entries) {
      if (e.name === 'Package.swift') {
        info.hasPackageSwift = true;
      }
      if (e.name === 'Podfile') {
        info.hasPodfile = true;
      }
      if (e.name.endsWith('.xcodeproj') || e.name.endsWith('.xcworkspace')) {
        info.hasXcodeproj = true;
      }
    }

    // 统计源文件
    const extMap: Record<string, string> = {};
    for (const ext of LanguageService.sourceExts) {
      extMap[ext] = LanguageService.displayNameFromExt(ext) || ext;
    }
    walkDir(
      this.projectRoot,
      (filePath: string) => {
        const ext = path.extname(filePath);
        if (extMap[ext]) {
          info.sourceFiles.push(path.relative(this.projectRoot, filePath));
          const displayLang = LanguageService.displayNameFromExt(ext);
          info.languages[displayLang] = (info.languages[displayLang] || 0) + 1;
        }
      },
      this.options.maxFiles
    );

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
        // 通用: 使用多语言路径推断
        mod = inferModuleFromPath(f);
      }
      if (mod) {
        if (!info.sourceFilesByModule[mod]) {
          info.sourceFilesByModule[mod] = [];
        }
        info.sourceFilesByModule[mod].push(f);
      }
    }

    // 利用 LanguageService.detectProfile() 获取多语言画像
    const bareStats: Record<string, number> = {};
    for (const f of info.sourceFiles) {
      const ext = path.extname(f).replace('.', '');
      if (ext) {
        bareStats[ext] = (bareStats[ext] || 0) + 1;
      }
    }
    info.langProfile = LanguageService.detectProfile(bareStats);
    info.primaryLanguage = info.langProfile.primary as string;

    this._emit(
      WikiPhase.SCAN,
      12,
      `发现 ${info.sourceFiles.length} 个源文件 (${LanguageService.displayName(info.primaryLanguage)})`
    );
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
      const classNamesByModule: Record<string, string[]> = {};
      const protocolNamesByModule: Record<string, string[]> = {};

      for (const name of allClasses) {
        const info = this.projectGraph.getClassInfo(name);
        if (info?.filePath) {
          const mod = inferModuleFromPath(info.filePath);
          if (mod) {
            if (!classNamesByModule[mod]) {
              classNamesByModule[mod] = [];
            }
            classNamesByModule[mod].push(name);
          }
        }
      }

      for (const name of allProtocols) {
        const info = this.projectGraph.getProtocolInfo(name);
        if (info?.filePath) {
          const mod = inferModuleFromPath(info.filePath);
          if (mod) {
            if (!protocolNamesByModule[mod]) {
              protocolNamesByModule[mod] = [];
            }
            protocolNamesByModule[mod].push(name);
          }
        }
      }

      this._emit(
        WikiPhase.AST_ANALYZE,
        25,
        `AST 分析: ${overview.totalClasses} 个类, ${overview.totalProtocols} 个协议`
      );
      return {
        overview,
        classes: allClasses,
        protocols: allProtocols,
        classNamesByModule,
        protocolNamesByModule,
      };
    }

    // 没有现成的 ProjectGraph — 返回空壳（不阻塞生成）
    return {
      overview: null,
      classes: [],
      protocols: [],
      classNamesByModule: {},
      protocolNamesByModule: {},
    };
  }

  /**
   * 模块依赖解析
   * 通过 moduleService 统一处理所有语言的模块扫描
   */
  async _parseModules() {
    if (!this.moduleService) {
      return { targets: [], depGraph: null };
    }

    try {
      await this.moduleService.load();
      const targets = await this.moduleService.listTargets();
      let depGraph: unknown = null;
      if (this.options.includeDepGraph) {
        try {
          depGraph = await this.moduleService.getDependencyGraph?.({ level: 'target' });
        } catch {
          /* non-critical */
        }
      }
      const info = this.moduleService.getProjectInfo();
      this._emit(WikiPhase.SPM_PARSE, 40, `模块: ${targets.length} 个 (${info.primaryLanguage})`);
      return { targets, depGraph, projectInfo: info };
    } catch (err: unknown) {
      logger.warn('[WikiGenerator] ModuleService parse failed', { error: (err as Error).message });
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
      const recipes = result.data || result.items || result || [];
      const stats = (await this.knowledgeService.getStats?.()) || null;
      this._emit(WikiPhase.KNOWLEDGE, 55, `知识库: ${recipes.length} 条活跃 Recipe`);
      return { recipes: Array.isArray(recipes) ? recipes : [], stats };
    } catch (err: unknown) {
      logger.warn('[WikiGenerator] Knowledge integration failed', {
        error: (err as Error).message,
      });
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
  _discoverTopics(
    projectInfo: ProjectScanInfo,
    astInfo: Record<string, unknown>,
    moduleInfo: {
      targets: WikiModuleTarget[];
      depGraph?: unknown;
      projectInfo?: Record<string, unknown>;
    },
    knowledgeInfo: { recipes: Record<string, unknown>[]; stats: Record<string, unknown> | null }
  ) {
    const topics: WikiTopic[] = [];
    const isZh = this.options.language === 'zh';
    const langTerms = getLangTerms(projectInfo.primaryLanguage);

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
    const sourceModuleKeys = Object.keys(projectInfo.sourceFilesByModule || {});
    const hasMultiModule =
      moduleInfo.targets.length >= 2 || moduleKeys.length >= 2 || sourceModuleKeys.length >= 2;
    const hasDepGraph = moduleInfo.depGraph != null;
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
    const hasEntryPoints = ((astInfo.overview as any)?.entryPoints?.length || 0) > 0;
    const hasBuildSystem =
      projectInfo.buildSystems.length > 0 ||
      projectInfo.hasPackageSwift ||
      projectInfo.hasPodfile ||
      projectInfo.hasXcodeproj;

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
    const discoverers = (moduleInfo.projectInfo?.discoverers ?? []) as any[];
    const genericOnlyDiscovery = discoverers.length === 1 && discoverers[0]?.id === 'generic';
    const monolithSingleTarget =
      moduleInfo.targets.length === 1 &&
      (moduleInfo.targets[0]?.path === projectInfo.root ||
        moduleInfo.targets[0]?.name === projectInfo.name);
    const shouldUseInferredModules =
      sourceModuleKeys.length >= 2 &&
      (moduleInfo.targets.length === 0 || (genericOnlyDiscovery && monolithSingleTarget));

    if (moduleInfo.targets.length > 0 && !shouldUseInferredModules) {
      // 使用 moduleService 发现的 targets
      for (const target of moduleInfo.targets) {
        const moduleFiles = getModuleSourceFiles(target, projectInfo);
        const classCount = ((astInfo.classNamesByModule as any)?.[target.name] || []).length;
        const protoCount = ((astInfo.protocolNamesByModule as any)?.[target.name] || []).length;
        const depCount = (target.dependencies || target.info?.dependencies || []).length;

        // 丰富度评分: 文件数 + 类数×2 + 协议数×2 + 依赖数
        const richness = moduleFiles.length + classCount * 2 + protoCount * 2 + depCount;

        // 跳过过于单薄的模块 (少于3分不值得独立文档)
        if (richness < 3) {
          continue;
        }

        topics.push({
          id: `module-${slug(target.name)}`,
          path: `modules/${slug(target.name)}.md`,
          title: target.name,
          type: 'module',
          priority: 50 + Math.min(richness, 30),
          _moduleData: { target, moduleFiles, classCount, protoCount },
        });
      }
    } else if (shouldUseInferredModules) {
      // 无有效模块边界(无 targets 或 generic 单 target) → 从 sourceFilesByModule 推断模块
      const sfm = projectInfo.sourceFilesByModule || {};
      const sorted = (Object.entries(sfm) as [string, string[]][]).sort(
        (a, b) => b[1].length - a[1].length
      );
      for (const [modName, modFiles] of sorted) {
        if (modFiles.length < 2) {
          continue;
        }
        const classCount = ((astInfo.classNamesByModule as any)?.[modName] || []).length;
        const protoCount = ((astInfo.protocolNamesByModule as any)?.[modName] || []).length;
        const richness = modFiles.length + classCount * 2 + protoCount * 2;
        if (richness < 3) {
          continue;
        }
        topics.push({
          id: `module-${slug(modName)}`,
          path: `modules/${slug(modName)}.md`,
          title: modName,
          type: 'module',
          priority: 50 + Math.min(richness, 30),
          _moduleData: {
            target: { name: modName, type: 'inferred' },
            moduleFiles: modFiles,
            classCount,
            protoCount,
          },
        });
      }
    }

    // ── 5. 代码模式/最佳实践 (来自知识库 Recipes) ──
    if (knowledgeInfo.recipes.length > 0) {
      const groups: Record<string, Record<string, unknown>[]> = {};
      for (const r of knowledgeInfo.recipes) {
        const json = (r as any).toJSON ? (r as any).toJSON() : r;
        const cat = json.category || 'Other';
        if (!groups[cat]) {
          groups[cat] = [];
        }
        groups[cat].push(json);
      }

      const catEntries = (Object.entries(groups) as [string, Record<string, unknown>[]][]).sort(
        (a, b) => b[1].length - a[1].length
      );

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
          if (items.length < 2) {
            continue;
          }
          topics.push({
            id: `pattern-${slug(cat)}`,
            path: `patterns/${slug(cat)}.md`,
            title: isZh ? `${cat} 模式` : `${cat} Patterns`,
            type: 'pattern-category',
            priority: 30 + items.length,
            _patternData: { category: cat, recipes: items },
          });
        }
      }
    }

    // ── 6. 协议/接口参考 (数量足够多时) ──
    if ((astInfo.protocols as unknown[]).length >= 8) {
      const ifaceLabel = isZh ? langTerms.interfaceLabel.zh : langTerms.interfaceLabel.en;
      topics.push({
        id: 'protocols',
        path: 'protocols.md',
        title: isZh ? `${ifaceLabel}参考` : `${ifaceLabel} Reference`,
        type: 'reference',
        priority: 35,
      });
    }

    // ── 7. 文件夹画像文档 ──
    //   触发条件 (满足任一即启用):
    //   a) AST 稀疏: 类/协议 < 5 且无模块文档
    //   b) generic monolith: 仅 generic discoverer + 单 target + 多目录
    //   c) 核心文章过少: 当前主题 ≤ 4 篇 → 用文件夹分析补充内容丰富度
    const astEntityCount =
      ((astInfo.classes as unknown[])?.length || 0) +
      ((astInfo.protocols as unknown[])?.length || 0);
    const hasModuleDocs = topics.some((t) => t.type === 'module');
    const astSparse = astEntityCount < 5 && !hasModuleDocs;
    const shouldProfileForGenericMonolith =
      genericOnlyDiscovery && monolithSingleTarget && sourceModuleKeys.length >= 2;
    const tooFewCoreArticles = topics.length <= 4 && sourceModuleKeys.length >= 2;
    const shouldEnableFolderProfiling =
      astSparse || shouldProfileForGenericMonolith || tooFewCoreArticles;

    if (shouldEnableFolderProfiling) {
      const rawFolderProfiles = profileFolders(projectInfo, {
        minFiles: 3,
        maxFolders: 15,
      });

      // 按 relPath 去重，避免同一路径重复产出同名文档
      const folderProfiles: Record<string, unknown>[] = [];
      const seenFolderRelPath = new Set();
      for (const fp of rawFolderProfiles) {
        if (seenFolderRelPath.has(fp.relPath)) {
          continue;
        }
        seenFolderRelPath.add(fp.relPath);
        folderProfiles.push(fp);
      }

      if (folderProfiles.length > 0) {
        // 总览文档: 文件夹结构分析
        topics.push({
          id: 'folder-overview',
          path: 'folder-structure.md',
          title: isZh ? '项目结构分析' : 'Project Structure Analysis',
          type: 'folder-overview',
          priority: 80,
          _folderProfiles: folderProfiles,
        });

        // 为每个重要文件夹生成独立文档 (仅 fileCount ≥ 5 的大文件夹)
        // 限制最多 10 个 folder-profile 文档，避免碎片化
        const MAX_FOLDER_DOCS = 10;
        let folderDocCount = 0;
        for (const fp of folderProfiles) {
          if (folderDocCount >= MAX_FOLDER_DOCS) {
            break;
          }
          if ((fp.fileCount as number) < 5) {
            continue;
          }
          const folderDocSlug = slug((fp.relPath as string).replaceAll('/', '-'));
          // 文件夹丰富度评分: 文件数 + 入口点×3 + 命名模式数×2 + imports数 + headerComments数×2 + (有README +5)
          const richness =
            (fp.fileCount as number) +
            (fp.entryPoints as unknown[]).length * 3 +
            (fp.namingPatterns as unknown[]).length * 2 +
            (fp.imports as unknown[]).length +
            (fp.headerComments as unknown[]).length * 2 +
            (fp.readme ? 5 : 0);

          if (richness < 10) {
            continue; // 过于单薄的文件夹不值得独立文档
          }

          topics.push({
            id: `folder-${folderDocSlug}`,
            path: `folders/${folderDocSlug}.md`,
            title: fp.relPath as string,
            type: 'folder-profile',
            priority: 45 + Math.min(richness, 25),
            _folderProfile: fp,
          });
          folderDocCount++;
        }

        const folderProfileReason = astSparse
          ? 'AST sparse'
          : tooFewCoreArticles
            ? `few core articles (${topics.length - topics.filter((t) => t.type === 'folder-overview' || t.type === 'folder-profile').length} core)`
            : 'generic monolith';
        logger.info(
          `[WikiGenerator] Folder profiling (${folderProfileReason}): ${folderProfiles.length} folders analyzed, ` +
            `${topics.filter((t) => t.type === 'folder-profile').length} folder docs planned`
        );
      }
    }

    // 按优先级排序
    topics.sort((a, b) => b.priority - a.priority);

    logger.info(
      `[WikiGenerator] Discovered ${topics.length} topics: ${topics.map((t) => t.id).join(', ')}`
    );
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
   * @param {object} structuredData - { projectInfo, astInfo, moduleInfo, knowledgeInfo }
   * @returns {Promise<Array<{path: string, hash: string, size: number}>>}
   */
  async _composeArticles(topics: WikiTopic[], structuredData: WikiData) {
    const files: WikiFileResult[] = [];
    const isZh = this.options.language === 'zh';
    const MIN_ARTICLE_CHARS = 200;

    // 确保必要的子目录存在
    this._ensureDir(this.wikiDir);
    const needsModulesDir = topics.some((t: WikiTopic) => t.path.startsWith('modules/'));
    const needsPatternsDir = topics.some((t: WikiTopic) => t.path.startsWith('patterns/'));
    const needsFoldersDir = topics.some((t: WikiTopic) => t.path.startsWith('folders/'));
    if (needsModulesDir) {
      this._ensureDir(path.join(this.wikiDir, 'modules'));
    }
    if (needsPatternsDir) {
      this._ensureDir(path.join(this.wikiDir, 'patterns'));
    }
    if (needsFoldersDir) {
      this._ensureDir(path.join(this.wikiDir, 'folders'));
    }

    let composed = 0;
    const systemPrompt = buildAiSystemPrompt(isZh);

    // 跟踪实际写入的主题 (用于 overview 导航)
    const writtenTopics: WikiTopic[] = [];
    let overviewTopicIdx = -1;

    for (let i = 0; i < topics.length; i++) {
      if (this._aborted) {
        break;
      }

      const topic = topics[i];
      if (topic.type === 'overview') {
        overviewTopicIdx = i;
        // 先用全部主题作为占位，最后回写
        topic._allTopics = topics;
      }

      const progress = 58 + Math.round((i / topics.length) * 22);
      this._emit(WikiPhase.AI_COMPOSE, progress, `撰写: ${topic.title}`);

      let content: string | null = null;

      // === 1. 尝试 AI 撰写完整文章 ===
      if (this.aiProvider) {
        try {
          const prompt = buildArticlePrompt(topic, structuredData, isZh, this.codeEntityGraph);
          const aiResult = await Promise.race([
            this.aiProvider.chat(prompt, { systemPrompt, temperature: 0.3, maxTokens: 4096 }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('AI compose timeout')), 45_000)
            ),
          ]);

          if (aiResult && typeof aiResult === 'string' && aiResult.length >= MIN_ARTICLE_CHARS) {
            content = aiResult;
            composed++;
          }
        } catch (err: unknown) {
          logger.warn(
            `[WikiGenerator] AI compose failed for ${topic.id}: ${(err as Error).message}`
          );
        }
      }

      // === 2. 降级: 丰富的模板内容 ===
      if (!content) {
        content = buildFallbackArticle(topic, structuredData, isZh, this.codeEntityGraph);
      }

      // === 3. 质量关卡 ===
      if (!content || content.length < MIN_ARTICLE_CHARS) {
        logger.info(
          `[WikiGenerator] Skipping thin topic: ${topic.id} (${content?.length || 0} chars)`
        );
        continue;
      }

      // 写入文件
      const fileInfo: WikiFileResult = this._writeFile(topic.path, content);
      if (
        composed > 0 &&
        content !== buildFallbackArticle(topic, structuredData, isZh, this.codeEntityGraph)
      ) {
        fileInfo.polished = true;
      }
      files.push(fileInfo);
      writtenTopics.push(topic);
    }

    // 回写 overview: 只包含实际生成的页面导航 (避免断链)
    if (overviewTopicIdx >= 0 && writtenTopics.length > 0) {
      const overviewTopic = topics[overviewTopicIdx];
      overviewTopic._allTopics = writtenTopics;
      let overviewContent: string | null = null;
      // overview 始终存在于 files 中（因为 priority 最高且始终生成）
      // 重新用实际 writtenTopics 渲染
      overviewContent = buildFallbackArticle(
        overviewTopic,
        structuredData,
        isZh,
        this.codeEntityGraph
      );
      // 如果之前 AI compose 过 overview，保留 AI 版本（AI 版本已在初次写入时处理导航）
      const overviewFile = files.find((f) => f.path === overviewTopic.path);
      if (overviewFile && !overviewFile.polished && overviewContent) {
        this._writeFile(overviewTopic.path, overviewContent);
      }
    }

    logger.info(`[WikiGenerator] Composed ${files.length} articles (${composed} AI-enhanced)`);
    this._emit(
      WikiPhase.AI_COMPOSE,
      80,
      `撰写完成: ${files.length} 篇文档 (${composed} 篇 AI 增强)`
    );
    return files;
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
    const synced: WikiFileResult[] = [];
    const isZh = this.options.language === 'zh';

    // ── Source 1: Channel D devdocs ──
    const devdocsDir = path.join(
      this.projectRoot,
      '.cursor',
      'skills',
      'autosnippet-devdocs',
      'references'
    );
    if (fs.existsSync(devdocsDir)) {
      this._ensureDir(path.join(this.wikiDir, 'documents'));
      const files = fs.readdirSync(devdocsDir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(devdocsDir, file), 'utf-8');
          const header = `<!-- synced from .cursor/skills/autosnippet-devdocs/references/${file} -->\n\n`;
          const result: WikiFileResult = this._writeFile(`documents/${file}`, header + content);
          result.source = 'cursor-devdocs';
          synced.push(result);
        } catch {
          /* skip */
        }
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
  _generateSyncIndex(synced: WikiFileResult[], isZh: boolean) {
    const docFiles = synced.filter((f: WikiFileResult) => f.path.startsWith('documents/'));

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

  _emit(phase: string, progress: number, message: string) {
    try {
      this.onProgress(phase, progress, message);
    } catch {
      /* non-critical */
    }
  }

  _ensureDir(dir: string) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _writeFile(relativePath: string, content: string): WikiFileResult {
    const fullPath = path.join(this.wikiDir, relativePath);
    this._ensureDir(path.dirname(fullPath));
    fs.writeFileSync(fullPath, content, 'utf-8');

    const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
    return { path: relativePath, hash, size: Buffer.byteLength(content) };
  }

  _writeMeta(
    files: WikiFileResult[],
    startTime: number,
    dedupResult: { removed: string[]; kept: number } | null
  ) {
    const meta = {
      version: '3.0.0',
      generator: 'AutoSnippet WikiGenerator V3',
      generatedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      projectRoot: this.projectRoot,
      language: this.options.language,
      files: files.map((f: WikiFileResult) => ({
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
      if (!fs.existsSync(this.metaPath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(this.metaPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** 检测源码是否有变更（简化：对比 sourceHash） */
  _detectChanges(meta: { sourceHash?: string; [key: string]: unknown }) {
    if (!meta?.sourceHash) {
      return true;
    }
    return meta.sourceHash !== this._computeSourceHash();
  }

  /** 计算项目源文件的简易 hash（基于文件名列表 + 总大小） */
  _computeSourceHash() {
    try {
      const extSet = LanguageService.sourceExts;
      let totalSize = 0;
      const names: string[] = [];
      walkDir(
        this.projectRoot,
        (filePath: string) => {
          const ext = path.extname(filePath);
          if (extSet.has(ext)) {
            const stat = fs.statSync(filePath);
            totalSize += stat.size;
            names.push(path.relative(this.projectRoot, filePath));
          }
        },
        2000
      );

      names.sort();
      const payload = `${names.join('\n')}\n${totalSize}`;
      return createHash('sha256').update(payload).digest('hex').slice(0, 16);
    } catch {
      return 'unknown';
    }
  }

  _abortedResult() {
    return { success: false, error: 'aborted', duration: 0 };
  }
}

export default WikiGenerator;
