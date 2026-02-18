/**
 * Candidates API 路由
 * 候选条目的 AI 补齐、润色预览/应用
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { ValidationError } from '../../shared/errors/index.js';
import Logger from '../../infrastructure/logging/Logger.js';

const router = express.Router();
const logger = Logger.getInstance();

/* ═══ AI 语义字段补齐 ════════════════════════════════════ */

/**
 * POST /api/v1/candidates/enrich
 * 对若干候选条目进行 AI 语义字段补全
 * Body: { candidateIds: string[] }
 */
router.post('/enrich', asyncHandler(async (req, res) => {
  const { candidateIds } = req.body;
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    throw new ValidationError('candidateIds array is required and must not be empty');
  }
  if (candidateIds.length > 20) {
    throw new ValidationError('Max 20 candidates per enrichment call');
  }

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const aiProvider = container.get('aiProvider');

  // 收集候选条目
  const candidates = [];
  for (const id of candidateIds) {
    try {
      const entry = await knowledgeService.get(id);
      if (entry) {
        const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
        candidates.push({
          id: json.id,
          title: json.title,
          language: json.language,
          category: json.category,
          description: json.description,
          code: json.content?.pattern || '',
          rationale: json.content?.rationale,
          knowledgeType: json.knowledgeType,
          complexity: json.complexity,
          scope: json.scope,
          steps: json.content?.steps,
          constraints: json.constraints,
        });
      }
    } catch (err) {
      logger.warn(`enrich: failed to load candidate ${id}`, { error: err.message });
    }
  }

  if (candidates.length === 0) {
    return res.json({ success: true, data: { enriched: 0, total: 0, results: [] } });
  }

  let enrichedCount = 0;
  const results = [];

  if (aiProvider) {
    try {
      const enriched = await aiProvider.enrichCandidates(candidates);
      for (const item of enriched) {
        const idx = item.index ?? 0;
        const cand = candidates[idx];
        if (!cand) continue;

        const updateData = {};
        let changed = false;

        if (item.rationale && !cand.rationale) {
          updateData['content.rationale'] = item.rationale;
          // 需要合并到 content 对象
          const entry = await knowledgeService.get(cand.id);
          const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
          updateData.content = { ...(json.content || {}), rationale: item.rationale };
          changed = true;
        }
        if (item.knowledgeType && !cand.knowledgeType) {
          updateData.knowledgeType = item.knowledgeType;
          changed = true;
        }
        if (item.complexity && !cand.complexity) {
          updateData.complexity = item.complexity;
          changed = true;
        }
        if (item.scope && !cand.scope) {
          updateData.scope = item.scope;
          changed = true;
        }
        if (item.steps && (!cand.steps || cand.steps.length === 0)) {
          const entry = await knowledgeService.get(cand.id);
          const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
          updateData.content = { ...(json.content || {}), ...(updateData.content || {}), steps: item.steps };
          changed = true;
        }
        if (item.constraints && !cand.constraints?.preconditions?.length) {
          updateData.constraints = item.constraints;
          changed = true;
        }

        if (changed) {
          await knowledgeService.update(cand.id, updateData, { userId: 'dashboard-enrich' });
          enrichedCount++;
        }
        results.push({ id: cand.id, enriched: changed, filledFields: Object.keys(item).filter(k => k !== 'index') });
      }
    } catch (err) {
      logger.warn('AI enrichCandidates failed', { error: err.message });
    }
  }

  res.json({
    success: true,
    data: { enriched: enrichedCount, total: candidates.length, results },
  });
}));

/* ═══ Bootstrap 内容润色 ═════════════════════════════════ */

/**
 * POST /api/v1/candidates/bootstrap-refine
 * AI 内容润色（适用于 Bootstrap 产出的批量候选）
 * Body: { candidateIds?: string[], userPrompt?: string, dryRun?: boolean }
 */
router.post('/bootstrap-refine', asyncHandler(async (req, res) => {
  const { candidateIds, userPrompt, dryRun } = req.body;

  const container = getServiceContainer();

  // 复用 MCP handler 的 bootstrapRefine 逻辑
  const { bootstrapRefine } = await import('../../external/mcp/handlers/bootstrap.js');
  const ctx = { container, logger };
  const result = await bootstrapRefine(ctx, { candidateIds, userPrompt, dryRun });

  const data = result?.data || result?.content?.[0]?.text
    ? JSON.parse(result.content[0].text)?.data
    : { refined: 0, total: 0, errors: [], results: [] };

  res.json({ success: true, data });
}));

/* ═══ 对话式润色 — 工具函数 ═══════════════════════════════ */

/**
 * 从 KnowledgeEntry 提取前端 DiffView 所需的 before 字段
 * 与前端 extractBefore() 保持一致
 */
function extractBeforeFields(json) {
  return {
    title: json.title || '',
    description: json.description || '',
    pattern: json.content?.pattern || '',
    tags: json.tags || [],
    confidence: json.reasoning?.confidence ?? 0.6,
    relations: json.relations || {},
    aiInsight: json.aiInsight || null,
    agentNotes: json.agentNotes || null,
  };
}

/**
 * 构造直接润色提示词 —— 以用户 prompt 为主指令
 * @param {object} before - extractBeforeFields 的输出
 * @param {string} userPrompt - 用户输入的润色指令
 * @returns {string}
 */
function buildRefinePrompt(before, userPrompt) {
  return `你是一位知识库条目润色助手。你必须**严格按照用户指令**修改知识条目。

## 可修改字段（字段名 → UI 名称）

| JSON key      | UI 标签   | 说明                     |
|---------------|-----------|--------------------------|
| description   | 摘要       | 条目的简要概述             |
| pattern       | 内容文档 / 设计原理 | 条目的详细内容、代码模式、设计原理 |
| tags          | 标签       | 分类标签数组               |
| confidence    | 置信度     | 0.0-1.0 的评分            |
| aiInsight     | AI 洞察    | AI 生成的架构洞察           |
| agentNotes    | Agent 笔记 | Agent 生成的笔记           |
| relations     | 关联关系   | 与其他条目的关系            |

## 当前条目信息

标题: ${before.title}

【摘要 / description】
${before.description || '（空）'}

【内容文档 / pattern】
${(before.pattern || '（空）').substring(0, 3000)}

【标签 / tags】
${JSON.stringify(before.tags)}

【置信度 / confidence】
${before.confidence}

【关联关系 / relations】
${JSON.stringify(before.relations)}

【AI 洞察 / aiInsight】
${before.aiInsight || '（空）'}

【Agent 笔记 / agentNotes】
${JSON.stringify(before.agentNotes || [])}

## 用户指令

${userPrompt}

## 严格约束

1. **只修改用户指令明确提到的字段**。用户说"设计原理"或"内容"指 pattern 字段，说"摘要"或"描述"指 description 字段。
2. **未提及的字段必须原样返回**，不得做任何改写、改善、优化或翻译。
3. 如果你不确定用户指的是哪个字段，优先修改 pattern（内容文档）。

请返回 JSON（所有字段都必须包含）：
{
  "description": "原样或修改后的摘要",
  "pattern": "原样或修改后的内容文档",
  "tags": ["原样或修改后的标签数组"],
  "confidence": 原样或修改后的数字,
  "aiInsight": "原样或修改后的AI洞察 或 null",
  "agentNotes": ["原样或修改后的笔记数组"] 或 null,
  "relations": {原样或修改后的关联关系}
}

仅返回 JSON，不要添加其他文字。`;
}

/**
 * 将 AI 返回的润色结果合并到 before 上生成 after，并构造 knowledgeService.update() 所需的 updateData
 */
function buildUpdateFromRefineResult(before, parsed) {
  const after = { ...before };
  const updateData = {};
  let changed = false;

  if (parsed.description != null && parsed.description !== before.description) {
    after.description = parsed.description;
    updateData.description = parsed.description;
    changed = true;
  }
  if (parsed.pattern != null && parsed.pattern !== before.pattern) {
    after.pattern = parsed.pattern;
    // pattern 需要写入 content.pattern
    updateData._patternChanged = parsed.pattern;
    changed = true;
  }
  if (parsed.tags != null && Array.isArray(parsed.tags)) {
    const newTags = JSON.stringify(parsed.tags);
    if (newTags !== JSON.stringify(before.tags)) {
      after.tags = parsed.tags;
      updateData.tags = parsed.tags;
      changed = true;
    }
  }
  if (typeof parsed.confidence === 'number' && parsed.confidence !== before.confidence) {
    after.confidence = parsed.confidence;
    updateData._confidenceChanged = parsed.confidence;
    changed = true;
  }
  if (parsed.aiInsight !== undefined && parsed.aiInsight !== before.aiInsight) {
    after.aiInsight = parsed.aiInsight;
    updateData.aiInsight = parsed.aiInsight;
    changed = true;
  }
  if (parsed.agentNotes !== undefined) {
    const newNotes = JSON.stringify(parsed.agentNotes);
    if (newNotes !== JSON.stringify(before.agentNotes)) {
      after.agentNotes = parsed.agentNotes;
      updateData.agentNotes = parsed.agentNotes;
      changed = true;
    }
  }
  if (parsed.relations !== undefined) {
    const newRels = JSON.stringify(parsed.relations);
    if (newRels !== JSON.stringify(before.relations)) {
      after.relations = parsed.relations;
      updateData.relations = parsed.relations;
      changed = true;
    }
  }

  return { after, updateData, changed };
}

/* ═══ 对话式润色 — 预览 ══════════════════════════════════ */

/**
 * POST /api/v1/candidates/refine-preview
 * 直接用用户提示词调用 AI 润色，返回 before/after 对比
 * Body: { candidateId: string, userPrompt: string }
 */
router.post('/refine-preview', asyncHandler(async (req, res) => {
  const { candidateId, userPrompt } = req.body;
  if (!candidateId) throw new ValidationError('candidateId is required');
  if (!userPrompt || !userPrompt.trim()) throw new ValidationError('userPrompt is required');

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const aiProvider = container.get('aiProvider');
  if (!aiProvider) throw new ValidationError('AI provider not configured');

  const entry = await knowledgeService.get(candidateId);
  if (!entry) throw new ValidationError('Candidate not found');
  const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
  const before = extractBeforeFields(json);

  const prompt = buildRefinePrompt(before, userPrompt.trim());
  const parsed = await aiProvider.chatWithStructuredOutput(prompt, { temperature: 0.3 });

  if (!parsed) {
    return res.json({
      success: true,
      data: { candidateId, before, after: before, preview: {} },
    });
  }

  const { after } = buildUpdateFromRefineResult(before, parsed);

  res.json({
    success: true,
    data: { candidateId, before, after, preview: parsed },
  });
}));

/* ═══ 对话式润色 — 应用 ══════════════════════════════════ */

/**
 * POST /api/v1/candidates/refine-apply
 * 应用润色预览的结果。优先使用前端传回的 preview 数据（避免重复调 AI），
 * 若未提供 preview 则 fallback 重新调用 AI。
 * Body: { candidateId: string, userPrompt?: string, preview?: object }
 */
router.post('/refine-apply', asyncHandler(async (req, res) => {
  const { candidateId, userPrompt, preview } = req.body;
  if (!candidateId) throw new ValidationError('candidateId is required');

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');

  const entry = await knowledgeService.get(candidateId);
  if (!entry) throw new ValidationError('Candidate not found');
  const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
  const before = extractBeforeFields(json);

  // 优先使用前端传回的 preview（与预览阶段完全一致），否则重新调 AI
  let parsed = preview || null;
  if (!parsed) {
    if (!userPrompt || !userPrompt.trim()) {
      throw new ValidationError('Either preview or userPrompt is required');
    }
    const aiProvider = container.get('aiProvider');
    if (!aiProvider) throw new ValidationError('AI provider not configured');
    const prompt = buildRefinePrompt(before, userPrompt.trim());
    parsed = await aiProvider.chatWithStructuredOutput(prompt, { temperature: 0.3 });
  }

  if (!parsed) {
    return res.json({
      success: true,
      data: { refined: 0, total: 1, candidate: json },
    });
  }

  const { after, updateData, changed } = buildUpdateFromRefineResult(before, parsed);

  if (changed) {
    // 处理需要嵌套写入的字段
    const finalUpdate = { ...updateData };
    delete finalUpdate._patternChanged;
    delete finalUpdate._confidenceChanged;

    if (updateData._patternChanged != null) {
      finalUpdate.content = { ...(json.content || {}), pattern: updateData._patternChanged };
    }
    if (updateData._confidenceChanged != null) {
      finalUpdate.reasoning = { ...(json.reasoning || {}), confidence: updateData._confidenceChanged };
    }

    await knowledgeService.update(candidateId, finalUpdate, { userId: 'dashboard-refine' });
  }

  // 返回更新后的条目
  const updated = changed ? await knowledgeService.get(candidateId) : entry;
  const updatedJson = typeof updated?.toJSON === 'function' ? updated.toJSON() : updated;

  res.json({
    success: true,
    data: { refined: changed ? 1 : 0, total: 1, candidate: updatedJson },
  });
}));

export default router;
