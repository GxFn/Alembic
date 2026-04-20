/**
 * bootstrapRefine — Phase 6 AI 润色
 *
 * 对 Bootstrap Phase 5 产出的知识条目进行 AI 二次精炼：
 * - 改善模板化描述 → 更自然精准
 * - 补充高阶架构洞察
 * - 推断并填充 relations 关联
 * - 调整 confidence 评分
 *
 * 从 bootstrap.js 提取为独立模块
 */

import { envelope } from '../../envelope.js';
import type { KnowledgeEntryJSON, McpContext } from '../types.js';

/**
 * @param ctx MCP context { container, logger }
 * @param args { candidateIds?: string[], userPrompt?: string, dryRun?: boolean }
 */
interface BootstrapRefineArgs {
  candidateIds?: string[];
  userPrompt?: string;
  dryRun?: boolean;
}

export async function bootstrapRefine(ctx: McpContext, args: BootstrapRefineArgs) {
  const t0 = Date.now();
  const knowledgeService = ctx.container.get('knowledgeService');
  const aiProvider = ctx.container.get('aiProvider');

  if (!aiProvider) {
    return envelope({
      success: false,
      message: 'AI provider not configured',
      errorCode: 'MISSING_AI_PROVIDER',
    });
  }

  // Mock 模式下跳过 AI 润色
  if (aiProvider.name === 'mock') {
    return envelope({
      success: false,
      message: 'AI Provider 未配置，当前为 Mock 模式。请先配置 API Key。',
      errorCode: 'MOCK_MODE',
    });
  }

  // 接入 BootstrapTaskManager 双通道推送 refine:* 事件
  let onProgress: ((eventName: string, data: Record<string, unknown>) => void) | null = null;
  try {
    const taskManager = ctx.container.get('bootstrapTaskManager');
    onProgress = (eventName: string, data: Record<string, unknown>) =>
      taskManager.emitProgress(eventName, data);
  } catch {
    /* optional */
  }

  // 1. 收集待润色条目
  let entries: KnowledgeEntryJSON[];
  if (args.candidateIds?.length) {
    entries = [];
    for (const id of args.candidateIds) {
      const e = await knowledgeService.get(id);
      if (e) {
        entries.push(typeof e.toJSON === 'function' ? e.toJSON() : e);
      }
    }
  } else {
    const result = await knowledgeService.list(
      { lifecycle: 'pending', source: 'bootstrap' },
      { page: 1, pageSize: 200 }
    );
    entries = ((result.items || []) as KnowledgeEntryJSON[]).map((e) =>
      typeof e.toJSON === 'function' ? e.toJSON() : e
    );
  }

  if (entries.length === 0) {
    return envelope({
      success: true,
      data: { refined: 0, total: 0, errors: [], results: [] },
      meta: { tool: 'alembic_bootstrap', responseTimeMs: Date.now() - t0 },
    });
  }

  onProgress?.('refine:started', {
    total: entries.length,
    candidateIds: entries.map((e) => e.id),
  });

  // 2. 收集已发布 Recipe 标题（关联关系只能指向已发布 Recipe，不能在候选之间互关联）
  let publishedTitles: string[] = [];
  try {
    const published = await knowledgeService.list(
      { lifecycle: 'active' },
      { page: 1, pageSize: 200 }
    );
    publishedTitles = ((published.items || []) as KnowledgeEntryJSON[])
      .map((e) => e.title)
      .filter(Boolean);
  } catch {
    /* ignore */
  }

  // 3. 逐条 AI 润色
  const results: {
    id: string;
    title: string;
    preview?: Record<string, unknown>;
    refined?: boolean;
    fields?: string[];
  }[] = [];
  const errors: { id: string; title: string; error: string }[] = [];
  let refined = 0;
  let processed = 0;

  for (const entry of entries) {
    processed++;
    onProgress?.('refine:item-started', {
      candidateId: entry.id,
      title: entry.title,
      current: processed,
      total: entries.length,
      progress: Math.round(((processed - 1) / entries.length) * 100),
    });

    try {
      const before = {
        title: entry.title || '',
        description: entry.description || '',
        pattern: entry.content?.pattern || '',
        markdown: entry.content?.markdown || '',
        rationale: entry.content?.rationale || '',
        tags: entry.tags || [],
        confidence: entry.reasoning?.confidence ?? 0.6,
        relations: entry.relations || {},
        aiInsight: entry.aiInsight || null,
        agentNotes: entry.agentNotes || null,
      };

      const refineInstruction = args.userPrompt
        ? args.userPrompt
        : '请改善描述使其更专业简洁，补充高阶架构洞察';

      const prompt = `你是一位高级代码知识管理专家。请改进以下知识条目。

## ⭐ JSON key 规范（最高优先级）

返回的 JSON 必须且只能使用以下 9 个 key，大小写必须完全一致：

  description  → 摘要（string）
  pattern      → 代码/标准用法（string）
  markdown     → Markdown 文档（string）
  rationale    → 设计原理（string）
  tags         → 标签（string[]）
  confidence   → 置信度（number 0.0–1.0）
  aiInsight    → AI 洞察（string | null）
  agentNotes   → Agent 笔记（string[] | null）
  relations    → 关联关系（object）

## 当前条目信息

标题: ${before.title}
类型: ${entry.knowledgeType || '未知'}
语言: ${entry.language || '未知'}

【description】摘要
${before.description || '（空）'}

【pattern】代码/标准用法
${(before.pattern || '（空）').substring(0, 2000)}

【markdown】Markdown 文档
${(before.markdown || '（空）').substring(0, 2000)}

【rationale】设计原理
${before.rationale || '（空）'}

【tags】标签
${JSON.stringify(before.tags)}

【confidence】置信度
${before.confidence}

【relations】关联关系
${JSON.stringify(before.relations)}

【aiInsight】AI 洞察
${before.aiInsight || '（空）'}

【agentNotes】Agent 笔记
${JSON.stringify(before.agentNotes || [])}

${publishedTitles.length > 0 ? `已发布的 Recipe: ${publishedTitles.slice(0, 20).join(', ')}` : '（尚无已发布的 Recipe）'}

## 润色指令

${refineInstruction}

## 约束

1. 只修改需要改进的字段，未涉及的必须原样返回。
2. tags 采用合并策略（保留原有 + 补充新建议），不要删除已有标签。
3. relations 为 object 格式，key 为关系类型（如 inherits/implements/calls/depends_on/extends/related），value 为 Array<{target: string, description: string}>。示例: {"related": [{"target": "某 Recipe 标题", "description": "关联原因"}]}。
4. relations 只能指向已发布的 Recipe，不能在候选之间建立关联。如果没有已发布的 Recipe，relations 应保持为空 {}。
5. relations 必须精准：只在候选与某个 Recipe 有明确的技术依赖、继承、调用或扩展关系时才添加。仅仅因为属于同一项目或使用相同框架不构成关联。如果没有强关联，related 应为空数组。
6. 每个 key 都必须存在，key 名称必须与上述完全一致。

仅返回 JSON，不要添加任何其他文字或代码块标记。`;

      const parsed = await aiProvider.chatWithStructuredOutput(prompt, { temperature: 0.3 });

      if (!parsed) {
        errors.push({ id: entry.id, title: entry.title, error: 'AI returned no valid JSON' });
        onProgress?.('refine:item-failed', {
          candidateId: entry.id,
          title: entry.title,
          error: 'No valid JSON',
          current: processed,
          total: entries.length,
          progress: Math.round((processed / entries.length) * 100),
        });
        continue;
      }

      if (args.dryRun) {
        results.push({ id: entry.id, title: entry.title, preview: parsed });
        onProgress?.('refine:item-completed', {
          candidateId: entry.id,
          title: entry.title,
          refined: false,
          current: processed,
          total: entries.length,
          progress: Math.round((processed / entries.length) * 100),
        });
        continue;
      }

      // ─── key 别名归一化（与 candidates.js 保持一致） ───
      const KEY_ALIASES = {
        summary: 'description',
        desc: 'description',
        content: 'pattern',
        design: 'rationale',
        designRationale: 'rationale',
        markdownDoc: 'markdown',
        doc: 'markdown',
        tag: 'tags',
        label: 'tags',
        labels: 'tags',
        score: 'confidence',
        ai_insight: 'aiInsight',
        insight: 'aiInsight',
        aiinsight: 'aiInsight',
        agent_notes: 'agentNotes',
        notes: 'agentNotes',
        agentnotes: 'agentNotes',
        relation: 'relations',
      };
      const VALID_KEYS = new Set([
        'description',
        'pattern',
        'markdown',
        'rationale',
        'tags',
        'confidence',
        'aiInsight',
        'agentNotes',
        'relations',
      ]);
      const normalized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (VALID_KEYS.has(key)) {
          normalized[key] = value;
        } else {
          const mapped =
            (KEY_ALIASES as Record<string, string>)[key] ||
            (KEY_ALIASES as Record<string, string>)[key.toLowerCase?.()];
          if (mapped && !(mapped in normalized)) {
            normalized[mapped] = value;
          }
        }
      }
      for (const k of VALID_KEYS) {
        if (!(k in normalized)) {
          normalized[k] = (before as Record<string, unknown>)[k];
        }
      }

      // 构建更新数据
      const updateData: Record<string, unknown> = {};
      let changed = false;

      if (normalized.description != null && normalized.description !== before.description) {
        updateData.description = normalized.description;
        changed = true;
      }
      // tags 采用合并策略
      if (normalized.tags != null && Array.isArray(normalized.tags)) {
        const merged = [...new Set([...(before.tags || []), ...normalized.tags])];
        if (JSON.stringify(merged) !== JSON.stringify(before.tags)) {
          updateData.tags = merged;
          changed = true;
        }
      }
      if (
        typeof normalized.confidence === 'number' &&
        normalized.confidence !== before.confidence
      ) {
        updateData.reasoning = { ...(entry.reasoning || {}), confidence: normalized.confidence };
        changed = true;
      }
      if (normalized.aiInsight != null && normalized.aiInsight !== before.aiInsight) {
        updateData.aiInsight = normalized.aiInsight;
        changed = true;
      }
      if (normalized.agentNotes !== undefined) {
        const newNotes = JSON.stringify(normalized.agentNotes);
        if (newNotes !== JSON.stringify(before.agentNotes)) {
          updateData.agentNotes = normalized.agentNotes;
          changed = true;
        }
      }
      if (normalized.relations !== undefined) {
        const newRels = JSON.stringify(normalized.relations);
        if (newRels !== JSON.stringify(before.relations)) {
          updateData.relations = normalized.relations;
          changed = true;
        }
      }
      // content 嵌套写入
      const contentPatch: Record<string, unknown> = { ...(entry.content || {}) };
      let contentChanged = false;
      if (normalized.pattern != null && normalized.pattern !== before.pattern) {
        contentPatch.pattern = normalized.pattern;
        contentChanged = true;
      }
      if (normalized.markdown != null && normalized.markdown !== before.markdown) {
        contentPatch.markdown = normalized.markdown;
        contentChanged = true;
      }
      if (normalized.rationale != null && normalized.rationale !== before.rationale) {
        contentPatch.rationale = normalized.rationale;
        contentChanged = true;
      }
      if (contentChanged) {
        updateData.content = contentPatch;
        changed = true;
      }

      if (changed) {
        await knowledgeService.update(entry.id, updateData);
        refined++;
      }

      results.push({
        id: entry.id,
        title: entry.title,
        refined: changed,
        fields: Object.keys(parsed),
      });
      onProgress?.('refine:item-completed', {
        candidateId: entry.id,
        title: entry.title,
        refined: changed,
        current: processed,
        total: entries.length,
        progress: Math.round((processed / entries.length) * 100),
        refinedSoFar: refined,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push({ id: entry.id, title: entry.title, error: errMsg });
      onProgress?.('refine:item-failed', {
        candidateId: entry.id,
        title: entry.title,
        error: errMsg,
        current: processed,
        total: entries.length,
        progress: Math.round((processed / entries.length) * 100),
      });
    }
  }

  onProgress?.('refine:completed', { total: entries.length, refined, failed: errors.length });

  return envelope({
    success: true,
    data: {
      refined,
      total: entries.length,
      errors,
      results,
      message: `Phase 6 AI 润色完成: ${refined}/${entries.length} 条知识条目已更新${args.dryRun ? '（预览模式）' : ''}`,
    },
    meta: { tool: 'alembic_bootstrap', responseTimeMs: Date.now() - t0 },
  });
}
