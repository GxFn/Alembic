/**
 * WorkspaceResolver — Ghost Mode 感知的工作区路径解析器
 *
 * 核心思想：提供 `dataRoot` — 所有运行时数据和知识库的根目录。
 *   - 标准模式: dataRoot = projectRoot（与原有行为完全一致）
 *   - Ghost 模式: dataRoot = ~/.asd/workspaces/<id>/（零项目侵入）
 *
 * 消费者只需将 `path.join(projectRoot, '.asd', ...)` 改为
 * `path.join(resolver.dataRoot, '.asd', ...)` 即可自动适配 Ghost 模式。
 *
 * projectRoot 始终指向真实项目目录（用于代码分析、AST 解析等）。
 */

import path from 'node:path';
import { detectKnowledgeBaseDir } from './ProjectMarkers.js';
import { getGhostWorkspaceDir, ProjectRegistry } from './ProjectRegistry.js';

export class WorkspaceResolver {
  /** 真实项目根目录（用于代码分析） */
  readonly projectRoot: string;

  /** 数据根目录（所有 .asd/ 和知识库写入的基准路径） */
  readonly dataRoot: string;

  /** 是否处于 Ghost 模式 */
  readonly ghost: boolean;

  /** 项目 ID（来自 ProjectRegistry） */
  readonly projectId: string | null;

  /** 知识库目录名（如 'Alembic'） */
  readonly knowledgeBaseDir: string;

  constructor(opts: {
    projectRoot: string;
    ghost?: boolean;
    projectId?: string;
    knowledgeBaseDir?: string;
  }) {
    this.projectRoot = path.resolve(opts.projectRoot);
    this.ghost = opts.ghost ?? false;
    this.knowledgeBaseDir = opts.knowledgeBaseDir ?? detectKnowledgeBaseDir(this.projectRoot);

    if (this.ghost) {
      // Ghost 模式：从 ProjectRegistry 查 ID 或用显式传入的 ID
      this.projectId = opts.projectId ?? ProjectRegistry.get(this.projectRoot)?.id ?? null;
      if (!this.projectId) {
        throw new Error(
          `[WorkspaceResolver] Ghost 模式需要项目已注册。请先运行 alembic setup --ghost`
        );
      }
      this.dataRoot = getGhostWorkspaceDir(this.projectId);
    } else {
      this.projectId = opts.projectId ?? null;
      this.dataRoot = this.projectRoot;
    }
  }

  /**
   * 从 ProjectRegistry 自动创建 resolver
   * 自动检测项目是否为 Ghost 模式
   */
  static fromProject(projectRoot: string): WorkspaceResolver {
    const entry = ProjectRegistry.get(projectRoot);
    return new WorkspaceResolver({
      projectRoot,
      ghost: entry?.ghost ?? false,
      projectId: entry?.id,
    });
  }

  // ─── 运行时路径（.asd/ 下） ──────────────────────

  /** 运行时目录: .asd/ */
  get runtimeDir(): string {
    return path.join(this.dataRoot, '.asd');
  }

  /** 数据库路径: .asd/alembic.db */
  get databasePath(): string {
    return path.join(this.runtimeDir, 'alembic.db');
  }

  /** 日志目录: .asd/logs */
  get logsDir(): string {
    return path.join(this.runtimeDir, 'logs');
  }

  /** 报告目录: .asd/logs/reports */
  get reportsDir(): string {
    return path.join(this.runtimeDir, 'logs', 'reports');
  }

  /** 信号日志目录: .asd/logs/signals */
  get signalsDir(): string {
    return path.join(this.runtimeDir, 'logs', 'signals');
  }

  /** 错误追踪目录: .asd/logs/errors */
  get errorsDir(): string {
    return path.join(this.runtimeDir, 'logs', 'errors');
  }

  /** 对话存储目录: .asd/conversations */
  get conversationsDir(): string {
    return path.join(this.runtimeDir, 'conversations');
  }

  /** 缓存目录: .asd/cache */
  get cacheDir(): string {
    return path.join(this.runtimeDir, 'cache');
  }

  /** 记忆文件: .asd/memory.jsonl (legacy) */
  get memoryPath(): string {
    return path.join(this.runtimeDir, 'memory.jsonl');
  }

  /** 项目配置: .asd/config.json */
  get configPath(): string {
    return path.join(this.runtimeDir, 'config.json');
  }

  /** Bootstrap 检查点: .asd/bootstrap-checkpoint */
  get checkpointPath(): string {
    return path.join(this.runtimeDir, 'bootstrap-checkpoint');
  }

  /** 上下文存储: .asd/context */
  get contextDir(): string {
    return path.join(this.runtimeDir, 'context');
  }

  /** 记忆嵌入: .asd/context/memory_embeddings.json */
  get memoryEmbeddingsPath(): string {
    return path.join(this.runtimeDir, 'context', 'memory_embeddings.json');
  }

  /** 自动审批标记: .asd/.auto-approve-pending */
  get autoApprovePendingPath(): string {
    return path.join(this.runtimeDir, '.auto-approve-pending');
  }

  /** Skills 迁移目录: .asd/skills */
  get runtimeSkillsDir(): string {
    return path.join(this.runtimeDir, 'skills');
  }

  // ─── 知识库路径（Alembic/ 下） ────────────────────

  /** 知识库根目录: Alembic/ */
  get knowledgeDir(): string {
    return path.join(this.dataRoot, this.knowledgeBaseDir);
  }

  /** Recipes 目录: Alembic/recipes */
  get recipesDir(): string {
    return path.join(this.knowledgeDir, 'recipes');
  }

  /** Candidates 目录: Alembic/candidates */
  get candidatesDir(): string {
    return path.join(this.knowledgeDir, 'candidates');
  }

  /** Skills 目录: Alembic/skills */
  get skillsDir(): string {
    return path.join(this.knowledgeDir, 'skills');
  }

  /** Wiki 目录: Alembic/wiki */
  get wikiDir(): string {
    return path.join(this.knowledgeDir, 'wiki');
  }

  /** Boxspec 文件: Alembic/Alembic.boxspec.json */
  get specPath(): string {
    return path.join(this.knowledgeDir, 'Alembic.boxspec.json');
  }

  /** Recipes 索引: Alembic/recipes/index.json */
  get recipesIndexPath(): string {
    return path.join(this.recipesDir, 'index.json');
  }
}

export default WorkspaceResolver;
