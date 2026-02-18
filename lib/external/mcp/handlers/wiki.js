/**
 * MCP Handlers — Repo Wiki 生成 & 查询
 *
 * 提供给 IDE AI Agent 的 Wiki 操作工具：
 *   - generateWiki:  触发全量 / 增量 Wiki 生成
 *   - wikiStatus:    查询 Wiki 生成状态 & 已有文件列表
 *   - readWikiFile:  读取单个 Wiki 文件内容
 */

import fs from 'node:fs';
import path from 'node:path';
import { envelope } from '../envelope.js';
import { WikiGenerator } from '../../../service/wiki/WikiGenerator.js';
import Logger from '../../../infrastructure/logging/Logger.js';

const logger = Logger.getInstance();

// ─── 进程内任务状态（与 HTTP routes/wiki.js 独立） ─────────

let mcpWikiTask = {
  status: 'idle',   // idle | running | done | error
  phase: null,
  progress: 0,
  message: null,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};

/** @type {WikiGenerator|null} */
let currentGenerator = null;

function resetTask() {
  mcpWikiTask = {
    status: 'idle', phase: null, progress: 0, message: null,
    startedAt: null, finishedAt: null, result: null, error: null,
  };
  currentGenerator = null;
}

// ─── generateWiki ───────────────────────────────────────────

/**
 * 触发 Repo Wiki 生成 (autosnippet_wiki_generate)
 *
 * 支持全量生成和增量更新两种模式。
 * 生成过程异步执行，Agent 可通过 autosnippet_wiki_status 轮询进度。
 */
export async function generateWiki(ctx, args) {
  const { mode = 'full' } = args;

  // 如果已在运行
  if (mcpWikiTask.status === 'running') {
    return envelope({
      success: false,
      message: 'Wiki 生成正在进行中，请等待完成或调用 autosnippet_wiki_status 查看进度。',
      errorCode: 'WIKI_BUSY',
      data: { phase: mcpWikiTask.phase, progress: mcpWikiTask.progress },
      meta: { tool: 'autosnippet_wiki_generate' },
    });
  }

  const container = ctx.container;
  const projectRoot = container.singletons?._projectRoot
    || process.env.ASD_PROJECT_DIR
    || process.cwd();

  // 收集可用服务（全部可选，WikiGenerator 会优雅降级）
  let spmService = null, knowledgeService = null, projectGraph = null, codeEntityGraph = null;
  try { spmService = container.get('spmService'); } catch { /* optional */ }
  try { knowledgeService = container.get('knowledgeService'); } catch { /* optional */ }
  try { projectGraph = container.get('projectGraph'); } catch { /* optional */ }
  try { codeEntityGraph = container.get('codeEntityGraph'); } catch { /* optional */ }

  const generator = new WikiGenerator({
    projectRoot,
    spmService,
    knowledgeService,
    projectGraph,
    codeEntityGraph,
    aiProvider: container.singletons?.aiProvider || null,
    onProgress: (phase, progress, message) => {
      mcpWikiTask.phase = phase;
      mcpWikiTask.progress = progress;
      mcpWikiTask.message = message;
    },
    options: {
      language: args.language || 'zh',
      includeRecipes: args.include_recipes !== false,
      includeDepGraph: args.include_dep_graph !== false,
      includeComponents: args.include_components !== false,
    },
  });

  currentGenerator = generator;
  mcpWikiTask.status = 'running';
  mcpWikiTask.startedAt = Date.now();
  mcpWikiTask.progress = 0;
  mcpWikiTask.phase = 'init';
  mcpWikiTask.message = '正在初始化 Wiki 生成...';
  mcpWikiTask.error = null;
  mcpWikiTask.result = null;

  // 异步执行生成
  const genPromise = mode === 'incremental'
    ? generator.update()
    : generator.generate();

  genPromise
    .then(result => {
      mcpWikiTask.status = 'done';
      mcpWikiTask.progress = 100;
      mcpWikiTask.finishedAt = Date.now();
      mcpWikiTask.result = result;
      mcpWikiTask.message = `Wiki 生成完成，共 ${result.filesGenerated || 0} 个文件。`;
      logger.info('[MCP Wiki] Generation completed', { filesGenerated: result.filesGenerated });
    })
    .catch(err => {
      mcpWikiTask.status = 'error';
      mcpWikiTask.finishedAt = Date.now();
      mcpWikiTask.error = err.message;
      mcpWikiTask.message = `Wiki 生成失败: ${err.message}`;
      logger.error('[MCP Wiki] Generation failed', { error: err.message });
    });

  return envelope({
    success: true,
    data: {
      message: mode === 'incremental'
        ? 'Wiki 增量更新已启动，调用 autosnippet_wiki_status 查看进度。'
        : 'Wiki 全量生成已启动，调用 autosnippet_wiki_status 查看进度。',
      mode,
      status: 'running',
    },
    meta: { tool: 'autosnippet_wiki_generate' },
  });
}

// ─── wikiStatus ─────────────────────────────────────────────

/**
 * 查询 Wiki 状态 (autosnippet_wiki_status)
 *
 * 返回当前生成进度 + 已有 Wiki 文件列表。
 */
export async function wikiStatus(ctx, _args) {
  const container = ctx.container;
  const projectRoot = container.singletons?._projectRoot
    || process.env.ASD_PROJECT_DIR
    || process.cwd();

  const wikiDir = path.join(projectRoot, 'AutoSnippet', 'wiki');
  const files = [];

  // 收集已有 Wiki 文件
  if (fs.existsSync(wikiDir)) {
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else if (entry.name.endsWith('.md') || entry.name === 'meta.json') {
          const stat = fs.statSync(path.join(dir, entry.name));
          files.push({ path: rel, size: stat.size, modified: stat.mtime.toISOString() });
        }
      }
    };
    walk(wikiDir);
  }

  // 读取 meta.json（如果有）
  let meta = null;
  const metaPath = path.join(wikiDir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { /* ignore */ }
  }

  return envelope({
    success: true,
    data: {
      task: {
        status: mcpWikiTask.status,
        phase: mcpWikiTask.phase,
        progress: mcpWikiTask.progress,
        message: mcpWikiTask.message,
        startedAt: mcpWikiTask.startedAt,
        finishedAt: mcpWikiTask.finishedAt,
        error: mcpWikiTask.error,
      },
      wiki: {
        exists: files.length > 0,
        fileCount: files.length,
        files,
        meta,
      },
    },
    meta: { tool: 'autosnippet_wiki_status' },
  });
}

// ─── readWikiFile ───────────────────────────────────────────

/**
 * 读取 Wiki 文件内容 (autosnippet_wiki_read)
 *
 * 支持读取任意 Wiki 目录下的 .md 或 .json 文件。
 */
export async function readWikiFile(ctx, args) {
  const filePath = args.path;
  if (!filePath) {
    throw new Error('path 参数必填（如 "index.md" 或 "modules/NetworkKit.md"）');
  }

  const container = ctx.container;
  const projectRoot = container.singletons?._projectRoot
    || process.env.ASD_PROJECT_DIR
    || process.cwd();

  const wikiDir = path.join(projectRoot, 'AutoSnippet', 'wiki');
  const fullPath = path.join(wikiDir, filePath);

  // 安全检查 — 防止路径遍历
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(wikiDir))) {
    throw new Error('路径不合法，不能访问 Wiki 目录外的文件');
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Wiki 文件不存在: ${filePath}。请先调用 autosnippet_wiki_generate 生成 Wiki。`);
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  const stat = fs.statSync(resolved);

  return envelope({
    success: true,
    data: {
      path: filePath,
      content,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    },
    meta: { tool: 'autosnippet_wiki_read' },
  });
}
