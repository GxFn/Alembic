/**
 * AiScanService — `alembic ais [Target]` 的核心逻辑
 *
 * 按文件粒度扫描 Target 源码，通过 AgentService.run(scan-extract) 提取 Recipe。
 * Agent 的 knowledge.submit 已经通过 Core RecipeProductionGateway 创建 pending/staging，
 * 本服务只观察并汇总返回的真实 ID，不再执行第二次 create/publish。
 *
 * Agent(LLM) 直接分析代码 + 使用 AST 工具，输出 Recipe 结构化 JSON。
 * 本服务可脱离 MCP 独立在 CLI 运行。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  type AgentRunInput,
  type AgentService,
  runScanAgentTask,
  type SystemRunContextFactory,
} from '@alembic/agent/service';
import Logger from '@alembic/core/logging';
import { LanguageService } from '@alembic/core/shared';
import { getAiRuntimeStatus, getAiUnavailableMessage } from '../injection/AiRuntimeStatus.js';

export class AiScanService {
  agentService: AgentService | null;
  systemRunContextFactory: SystemRunContextFactory | null;
  container: {
    get: (name: string) => unknown;
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
      get: (name: string) => unknown;
      singletons?: Record<string, unknown>;
    };
    projectRoot: string;
  }) {
    this.container = container;
    this.projectRoot = projectRoot;
    this.logger = Logger.getInstance();
    this.agentService = null;
    this.systemRunContextFactory = null;
  }

  /**
   * 扫描指定 Target（或全部 Target）的源文件并提取 Recipe
   * @param targetName Target 名称；null 时扫描全部
   * @param opts { maxFiles, dryRun, concurrency }
   * @returns >}
   */
  async scan(targetName: string | null, opts: { maxFiles?: number; dryRun?: boolean } = {}) {
    const { maxFiles = 200, dryRun = false } = opts;
    const report = {
      created: 0,
      previewed: 0,
      entries: [] as Array<{ id: string; lifecycle: string; title?: string }>,
      files: 0,
      errors: [] as string[],
      skipped: 0,
    };

    // 1. 初始化 AgentService (统一 AgentRuntime 入口)
    try {
      this.agentService = this.container.get('agentService') as AgentService;
      this.systemRunContextFactory = this.container.get(
        'systemRunContextFactory'
      ) as SystemRunContextFactory;
      // 通过 AiProviderManager 统一检查 AI 可用性
      const aiStatus = getAiRuntimeStatus(this.container);
      if (!aiStatus.ready) {
        throw new Error(getAiUnavailableMessage(aiStatus));
      }
    } catch (err: unknown) {
      throw new Error(
        `AI Provider 不可用: ${(err as Error).message}\n请在 Alembic Dashboard 的 AI Settings 中配置 API Key`
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

        // 委托统一 AgentService.run(scan-extract) — Agent(LLM) 直接分析
        const agentService = this.agentService;
        const systemRunContextFactory = this.systemRunContextFactory;
        if (!agentService || !systemRunContextFactory) {
          throw new Error('AI scan requires initialized AgentService and SystemRunContextFactory');
        }
        const createdEntries: Array<{ id: string; lifecycle: string; title?: string }> = [];
        const observingAgentService = {
          run: async (input: AgentRunInput) => {
            const priorHook = input.execution?.onToolCall;
            return agentService.run({
              ...input,
              execution: {
                ...input.execution,
                ...(dryRun ? { toolChoiceOverride: 'none' as const } : {}),
                onToolCall: (name, args, result, iteration) => {
                  priorHook?.(name, args, result, iteration);
                  const created = projectCreatedRecipe(name, args, result);
                  if (created) {
                    createdEntries.push(created);
                  }
                },
              },
            });
          },
        } as AgentService;
        const extractResult = await runScanAgentTask({
          agentService: observingAgentService,
          systemRunContextFactory,
          label: file.targetName,
          files: [{ name: file.name, relativePath: file.relativePath, content: truncated }],
          task: 'extract',
        });
        const recipes = extractResult.recipes || [];

        if (dryRun) {
          const previewable = Array.isArray(recipes)
            ? recipes.filter(
                (recipe) => recipe?.content?.pattern && String(recipe.content.pattern).length >= 20
              ).length
            : 0;
          report.previewed += previewable;
          if (previewable === 0) {
            report.skipped++;
          }
          continue;
        }

        if (createdEntries.length === 0) {
          report.skipped++;
          continue;
        }
        report.entries.push(...createdEntries);
        report.created += createdEntries.length;
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

function projectCreatedRecipe(
  name: string,
  args: Record<string, unknown>,
  result: unknown
): { id: string; lifecycle: string; title?: string } | null {
  if (name !== 'knowledge' || args.action !== 'submit' || !result || typeof result !== 'object') {
    return null;
  }
  const envelope = result as { ok?: boolean; data?: unknown };
  if (!envelope.ok || !envelope.data || typeof envelope.data !== 'object') {
    return null;
  }
  const data = envelope.data as Record<string, unknown>;
  if (data.status !== 'created' || typeof data.id !== 'string') {
    return null;
  }
  return {
    id: data.id,
    lifecycle: typeof data.lifecycle === 'string' ? data.lifecycle : 'pending',
    ...(typeof data.title === 'string' ? { title: data.title } : {}),
  };
}

export default AiScanService;
