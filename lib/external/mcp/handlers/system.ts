/**
 * MCP Handlers — 系统类
 * health
 */

import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '#shared/package-root.js';
import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { envelope } from '../envelope.js';
import type { KnowledgeBaseStats, McpContext } from './types.js';

export async function health(ctx: McpContext) {
  const checks = { database: false, gateway: false, vectorStore: false };
  const issues: string[] = [];
  let knowledgeBase: KnowledgeBaseStats | null = null;

  // 1) AI 配置
  let aiInfo = { provider: 'unknown', hasKey: false };
  try {
    const { getAiConfigInfo } = await import('#external/ai/AiFactory.js');
    aiInfo = getAiConfigInfo();
  } catch (e: unknown) {
    issues.push(`ai: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) Database 连通性 + 知识库统计
  try {
    const knowledgeRepo = ctx.container.get('knowledgeRepository') as {
      getStats(): Promise<Record<string, number>>;
    } | null;
    if (knowledgeRepo) {
      const stats = (await knowledgeRepo.getStats()) as Record<string, number> | null;
      checks.database = true;
      if (stats) {
        knowledgeBase = {
          recipes: {
            total: stats.total,
            active: stats.active,
            rules: stats.rules,
            patterns: stats.patterns,
            facts: stats.facts,
          },
          candidates: { total: stats.total, pending: stats.pending },
        };
      }
    }
  } catch (e: unknown) {
    issues.push(`database: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3) Gateway 可用性
  try {
    const gw = ctx.container.get('gateway');
    checks.gateway = !!gw;
  } catch (e: unknown) {
    issues.push(`gateway: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4) VectorStore 可用性
  try {
    const vs = ctx.container.get('vectorStore');
    if (vs) {
      const vsStats = typeof vs.getStats === 'function' ? await vs.getStats() : null;
      checks.vectorStore = true;
      if (vsStats) {
        knowledgeBase =
          knowledgeBase ||
          ({
            recipes: { total: 0, active: 0, rules: 0, patterns: 0, facts: 0 },
            candidates: { total: 0, pending: 0 },
          } as KnowledgeBaseStats);
        knowledgeBase.vectorIndex = {
          documentCount: vsStats.documentCount ?? vsStats.totalDocuments ?? 0,
        };
      }
    }
  } catch (e: unknown) {
    issues.push(`vectorStore: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 5) 版本号（从 AutoSnippet 包自身的 package.json 读取，不依赖 cwd）
  if (!_pkgVersion) {
    try {
      const pkgPath = path.resolve(PACKAGE_ROOT, 'package.json');
      _pkgVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '2.0.0';
    } catch {
      _pkgVersion = '2.0.0';
    }
  }

  // 6) 综合状态
  const allCritical = checks.database; // DB 是唯一硬性依赖
  const status = allCritical ? 'ok' : 'degraded';

  // 如果 DB 不可用但冷启动仍可执行，附加提示避免 Agent 浪费时间修复 DB
  const actionHints: string[] = [];
  if (!checks.database) {
    actionHints.push(
      'DB 不可用不影响冷启动：autosnippet_bootstrap 不依赖数据库（纯文件系统分析），可直接调用。DB 会在首次 submit_knowledge 时自动重试初始化。'
    );
  }
  if (!knowledgeBase || knowledgeBase.recipes.total === 0) {
    actionHints.push(
      '知识库为空，建议执行冷启动：(1) 调用 autosnippet_bootstrap 获取 Mission Briefing → (2) 按维度分析代码并提交知识 → (3) 调用 autosnippet_dimension_complete 完成每个维度。'
    );
    actionHints.push(
      '💡 冷启动指引：调用 autosnippet_bootstrap 获取 Mission Briefing → 按维度分析代码 → 调用 autosnippet_dimension_complete 完成每个维度'
    );
  }

  return envelope({
    success: true,
    data: {
      status,
      version: _pkgVersion,
      uptime: Math.floor((Date.now() - (ctx.startedAt ?? Date.now())) / 1000),
      projectRoot: resolveProjectRoot(ctx.container),
      ai: aiInfo,
      checks,
      services: ctx.container.getServiceNames?.() ?? [],
      knowledgeBase,
      // P3: Session 信息
      ...(ctx.session
        ? {
            session: {
              id: ctx.session.id,
              intentPhase: ctx.session.intent?.phase ?? 'idle',
              toolCallCount: ctx.session.toolCallCount,
              toolsUsed: Array.from(ctx.session.toolsUsed),
              durationMs: Date.now() - ctx.session.startedAt,
            },
          }
        : {}),
      ...(issues.length ? { issues } : {}),
      ...(actionHints.length ? { actionHints } : {}),
    },
    meta: { tool: 'autosnippet_health' },
  });
}

let _pkgVersion: string | null = null;
