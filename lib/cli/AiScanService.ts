/**
 * AiScanService — `alembic ais [Target]` 的核心逻辑
 *
 * 按文件粒度扫描 Target 源码，通过 AgentFactory.scanKnowledge 提取 Recipe，
 * 创建后自动发布（PENDING → ACTIVE），无需 Dashboard 人工审核。
 *
 * Agent(LLM) 直接分析代码 + 使用 AST 工具，输出 Recipe 结构化 JSON。
 * 本服务可脱离 MCP 独立在 CLI 运行。
 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '../infrastructure/logging/Logger.js';
import { LanguageService } from '../shared/LanguageService.js';

export class AiScanService {
  agentFactory: {
    scanKnowledge: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  } | null;
  container: {
    get: (name: string) => Record<string, unknown>;
    singletons?: Record<string, unknown>;
  };
  logger: ReturnType<typeof Logger.getInstance>;
  projectRoot: string;
  /**
   * @param opts.container ServiceContainer 实例
   * @param opts.projectRoot 项目根目录
   */
  constructor({
    container,
    projectRoot,
  }: {
    container: {
      get: (name: string) => Record<string, unknown>;
      singletons?: Record<string, unknown>;
    };
    projectRoot: string;
  }) {
    this.container = container;
    this.projectRoot = projectRoot;
    this.logger = Logger.getInstance();
    this.agentFactory = null;
  }

  /**
   * 扫描指定 Target（或全部 Target）的源文件并提取 Recipe，创建后直接发布
   * @param targetName Target 名称；null 时扫描全部
   * @param opts { maxFiles, dryRun, concurrency }
   * @returns >}
   */
  async scan(targetName: string | null, opts: { maxFiles?: number; dryRun?: boolean } = {}) {
    const { maxFiles = 200, dryRun = false } = opts;
    const report = { published: 0, files: 0, errors: [] as string[], skipped: 0 };

    // 1. 初始化 AgentFactory (内置 AI Provider + ToolExecutionPipeline + 中间件)
    try {
      this.agentFactory = this.container.get('agentFactory') as typeof this.agentFactory;
      // 通过 AiProviderManager 统一检查 AI 可用性
      const manager = this.container.singletons?._aiProviderManager as { isMock: boolean };
      if (manager.isMock) {
        throw new Error('AI Provider 为 mock 模式');
      }
    } catch (err: unknown) {
      throw new Error(
        `AI Provider 不可用: ${(err as Error).message}\n请在 .env 中配置 ALEMBIC_GOOGLE_API_KEY / ALEMBIC_OPENAI_API_KEY 等`
      );
    }

    // 2. 收集源文件
    const files = await this._collectFiles(targetName, maxFiles);
    if (files.length === 0) {
      report.errors.push(
        targetName ? `Target "${targetName}" 未找到或无源文件` : '未找到任何 SPM Target 源文件'
      );
      return report;
    }

    report.files = files.length;
    const knowledgeService = this.container.get('knowledgeService') as {
      create: (
        data: Record<string, unknown>,
        opts: Record<string, unknown>
      ) => Promise<{ id: string }>;
      publish: (id: string, opts: Record<string, unknown>) => Promise<void>;
    };

    // 3. 按文件调用 AI 提取 (通过 Agent 统一管道)
    for (const file of files) {
      try {
        const content = fs.readFileSync(file.path, 'utf8');
        const lines = content.split('\n').length;

        // 跳过过小的文件（< 10 行）
        if (lines < 10) {
          report.skipped++;
          continue;
        }

        // 截断过大的文件（> 500 行只取前 500 行）
        const truncated =
          lines > 500
            ? `${content.split('\n').slice(0, 500).join('\n')}\n// ... (truncated)`
            : content;

        const fileData = [{ name: file.name, content: truncated }];

        // 委托 AgentFactory.scanKnowledge — Agent(LLM) 直接分析
        const extractResult = await this.agentFactory!.scanKnowledge({
          label: file.targetName,
          files: fileData,
          task: 'extract',
        });
        const recipes = extractResult.recipes || [];

        if (!Array.isArray(recipes) || recipes.length === 0) {
          report.skipped++;
          continue;
        }

        // 4. 创建并发布 Recipe
        // Agent 已完成: 代码分析 + Recipe JSON 输出
        // 此处仅补充 AiScanService 专属元数据
        for (const recipe of recipes) {
          if (!recipe.content?.pattern || recipe.content.pattern.length < 20) {
            continue;
          }

          if (dryRun) {
            report.published++;
            continue;
          }

          try {
            // AiScanService 专属标记
            recipe.source = 'ai-scan';
            recipe.tags = [...new Set([...(recipe.tags || []), 'ai-scan', file.targetName])];
            recipe.moduleName = file.targetName;
            // 注意：不设置 sourceFile，由 KnowledgeFileWriter 持久化时自动设置为 md 文件路径

            if (!recipe.aiInsight && recipe.description) {
              recipe.aiInsight = recipe.description;
            }

            const saved = await knowledgeService.create(recipe, { userId: 'ai-scan' });

            // 直接发布：PENDING → ACTIVE
            await knowledgeService.publish(saved.id, { userId: 'ai-scan' });

            report.published++;
          } catch (err: unknown) {
            report.errors.push(`${file.name}: recipe publish failed — ${(err as Error).message}`);
          }
        }
      } catch (err: unknown) {
        report.errors.push(`${file.name}: ${(err as Error).message}`);
      }
    }

    return report;
  }

  /** 收集 Target 源文件 */
  async _collectFiles(targetName: string | null, maxFiles: number) {
    const files: { name: string; path: string; relativePath: string; targetName: string }[] = [];

    try {
      // 使用 ModuleService（多语言统一入口）
      let service: import('../service/module/ModuleService.js').ModuleService;
      try {
        const { ModuleService } = await import('../service/module/ModuleService.js');
        service = new ModuleService(this.projectRoot);
      } catch (e: unknown) {
        this.logger.warn(`[AiScanService] ModuleService 加载失败: ${(e as Error).message}`);
        return files;
      }
      await service.load();

      const targets = await service.listTargets();
      const filtered = targetName
        ? targets.filter((t) => {
            const name = typeof t === 'string' ? t : String(t.name ?? '');
            return name === targetName || name.toLowerCase() === targetName.toLowerCase();
          })
        : targets;

      if (filtered.length === 0 && targetName) {
        return files;
      }

      const seenPaths = new Set();
      for (const t of filtered) {
        const tName = typeof t === 'string' ? t : String((t as Record<string, unknown>).name ?? '');
        try {
          const fileList = await service.getTargetFiles(t);
          for (const f of fileList) {
            const fp = (typeof f === 'string' ? f : f.path) as string;
            if (seenPaths.has(fp)) {
              continue;
            }
            seenPaths.add(fp);
            files.push({
              name: ((f as Record<string, unknown>).name as string) || path.basename(fp),
              path: fp,
              relativePath:
                ((f as Record<string, unknown>).relativePath as string) || path.basename(fp),
              targetName: tName,
            });
            if (files.length >= maxFiles) {
              break;
            }
          }
        } catch {
          /* skip target */
        }
        if (files.length >= maxFiles) {
          break;
        }
      }
    } catch (err: unknown) {
      this.logger.warn(
        `SPM file collection failed: ${(err as Error).message}, falling back to directory scan`
      );
      // Fallback: 直接扫描目录
      const srcDirs = ['Sources', 'src', 'lib'];
      for (const dir of srcDirs) {
        const dirPath = path.join(this.projectRoot, dir);
        if (fs.existsSync(dirPath)) {
          this._walkDir(dirPath, files, maxFiles, dir);
        }
      }
    }

    return files;
  }

  /** 递归扫描目录（fallback） */
  _walkDir(
    dir: string,
    files: Array<{ name: string; path: string; relativePath: string; targetName: string }>,
    maxFiles: number,
    targetName: string
  ) {
    if (files.length >= maxFiles) {
      return;
    }
    const sourceExts = LanguageService.sourceExts;
    const skipDirs = LanguageService.scanSkipDirs;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      if (entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          continue;
        }
        this._walkDir(fullPath, files, maxFiles, targetName);
      } else if (sourceExts.has(path.extname(entry.name).toLowerCase())) {
        files.push({
          name: entry.name,
          path: fullPath,
          relativePath: path.relative(this.projectRoot, fullPath),
          targetName,
        });
      }
    }
  }

  /** 从文件名推断语言 */
  _inferLanguage(filename: string) {
    return LanguageService.inferLang(filename);
  }
}

export default AiScanService;
