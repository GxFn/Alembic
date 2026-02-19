/**
 * Candidates API 路由
 * 候选条目的 AI 补齐、润色预览/应用
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { ValidationError } from '../../shared/errors/index.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { createStreamSession, getStreamSession } from '../utils/sse-sessions.js';

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
    let enriched = [];
    try {
      enriched = await aiProvider.enrichCandidates(candidates);
    } catch (err) {
      logger.warn('AI enrichCandidates failed', { error: err.message });
    }

    for (const item of enriched) {
      // 安全的 index 映射：AI 未返回 index 时根据数组位置推断
      const idx = typeof item.index === 'number' ? item.index : enriched.indexOf(item);
      const cand = candidates[idx];
      if (!cand) continue;

      try {
        const updateData = {};
        let changed = false;

        // content 嵌套字段（rationale / steps）共用一次 DB 读取
        const needsContentMerge = (item.rationale && !cand.rationale) ||
                                  (item.steps && (!cand.steps || cand.steps.length === 0));
        let contentBase = null;
        if (needsContentMerge) {
          const entry = await knowledgeService.get(cand.id);
          const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
          contentBase = { ...(json.content || {}) };
        }

        if (item.rationale && !cand.rationale) {
          contentBase.rationale = item.rationale;
          changed = true;
        }
        if (item.steps && (!cand.steps || cand.steps.length === 0)) {
          contentBase.steps = item.steps;
          changed = true;
        }
        if (contentBase && changed) {
          updateData.content = contentBase;
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
        if (item.constraints && !cand.constraints?.preconditions?.length) {
          updateData.constraints = item.constraints;
          changed = true;
        }

        if (changed) {
          await knowledgeService.update(cand.id, updateData, { userId: 'dashboard-enrich' });
          enrichedCount++;
        }
        results.push({ id: cand.id, enriched: changed, filledFields: Object.keys(item).filter(k => k !== 'index') });
      } catch (err) {
        logger.warn(`enrich: failed to update candidate ${cand.id}`, { error: err.message });
        results.push({ id: cand.id, enriched: false, filledFields: [], error: err.message });
      }
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

  // envelope 返回 { success, data, meta, ... }，直接取 data
  const data = result?.data ?? { refined: 0, total: 0, errors: [], results: [] };

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
    markdown: json.content?.markdown || '',
    rationale: json.content?.rationale || '',
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

禁止使用其他 key。不允许用 content/summary/insight/notes/title 等替代名。

## 字段与 UI 子标题的对应关系

用户输入的指令可能使用 UI 上显示的子标题名称，对应规则如下：
- “摘要”“描述” → description
- “代码”“标准用法”“代码/标准用法” → pattern
- “Markdown 文档”“markdown” → markdown
- “设计原理”“原理” → rationale
- “标签” → tags
- “AI 洞察” → aiInsight
- “Agent 笔记” → agentNotes
- “关联关系” → relations

## 当前条目信息

标题: ${before.title}

【description】摘要
${before.description || '（空）'}

【pattern】代码/标准用法
${(before.pattern || '（空）').substring(0, 3000)}

【markdown】Markdown 文档
${(before.markdown || '（空）').substring(0, 3000)}

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

## 用户指令

${userPrompt}

## 严格约束

1. **只修改用户指令涉及的字段**。参考上方“字段与 UI 子标题的对应关系”识别用户指的是哪个字段。
2. **未涉及的字段必须原样返回**，不得做任何改写、改善、优化或翻译。
3. 如果不确定用户指的是哪个字段，优先修改 description（摘要）、pattern（代码）、markdown（文档）、rationale（设计原理）。
4. **翻译/语言转换类指令**（如“翻译为中文”): 翻译 description、pattern、markdown、rationale、aiInsight、agentNotes 等文本字段，但 tags/relations/confidence 保持原样。
5. **tags 和 relations** 只在用户明确提及“标签”或“关联”时才修改，其他情况一律原样返回。

## 输出格式

返回严格符合以下结构的 JSON，不要添加任何其他文字或代码块标记：
{"description": "...", "pattern": "...", "markdown": "...", "rationale": "...", "tags": [...], "confidence": 0.6, "aiInsight": "...or null", "agentNotes": ["..."] or null, "relations": {...}}

每个 key 都必须存在，key 名称必须与上述完全一致。`;
}

/**
 * 将 AI 返回的润色结果合并到 before 上生成 after，并构造 knowledgeService.update() 所需的 updateData
 */
function buildUpdateFromRefineResult(before, parsed) {
  // ─── key 别名归一化：AI 可能返回不精确的 key，统一映射到标准 key ───
  const KEY_ALIASES = {
    // description 别名
    summary: 'description', desc: 'description', 摘要: 'description', 描述: 'description',
    // pattern 别名
    content: 'pattern', designPattern: 'pattern',
    内容: 'pattern', 代码: 'pattern', 标准用法: 'pattern',
    // markdown 别名
    markdownDoc: 'markdown', Markdown文档: 'markdown', 文档: 'markdown', doc: 'markdown',
    // rationale 别名
    design: 'rationale', 设计原理: 'rationale', 原理: 'rationale', design_rationale: 'rationale', designRationale: 'rationale',
    // tags 别名
    tag: 'tags', label: 'tags', labels: 'tags', 标签: 'tags',
    // confidence 别名
    score: 'confidence', 置信度: 'confidence', 评分: 'confidence',
    // aiInsight 别名
    ai_insight: 'aiInsight', insight: 'aiInsight', aiinsight: 'aiInsight', 洞察: 'aiInsight',
    // agentNotes 别名
    agent_notes: 'agentNotes', notes: 'agentNotes', agentnotes: 'agentNotes', 笔记: 'agentNotes',
    // relations 别名
    relation: 'relations', 关联: 'relations', 关联关系: 'relations',
  };

  const VALID_KEYS = new Set(['description', 'pattern', 'markdown', 'rationale', 'tags', 'confidence', 'aiInsight', 'agentNotes', 'relations']);
  const normalized = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (VALID_KEYS.has(key)) {
      normalized[key] = value;
    } else {
      const mapped = KEY_ALIASES[key] || KEY_ALIASES[key.toLowerCase()];
      if (mapped && !(mapped in normalized)) {
        normalized[mapped] = value;
      }
    }
  }

  // 确保未返回的字段保留 before 值
  for (const k of VALID_KEYS) {
    if (!(k in normalized)) normalized[k] = before[k];
  }

  const after = { ...before };
  const updateData = {};
  let changed = false;

  if (normalized.description != null && normalized.description !== before.description) {
    after.description = normalized.description;
    updateData.description = normalized.description;
    changed = true;
  }
  if (normalized.pattern != null && normalized.pattern !== before.pattern) {
    after.pattern = normalized.pattern;
    updateData._patternChanged = normalized.pattern;
    changed = true;
  }
  if (normalized.markdown != null && normalized.markdown !== before.markdown) {
    after.markdown = normalized.markdown;
    updateData._markdownChanged = normalized.markdown;
    changed = true;
  }
  if (normalized.rationale != null && normalized.rationale !== before.rationale) {
    after.rationale = normalized.rationale;
    updateData._rationaleChanged = normalized.rationale;
    changed = true;
  }
  if (normalized.tags != null && Array.isArray(normalized.tags)) {
    const newTags = JSON.stringify(normalized.tags);
    if (newTags !== JSON.stringify(before.tags)) {
      after.tags = normalized.tags;
      updateData.tags = normalized.tags;
      changed = true;
    }
  }
  if (typeof normalized.confidence === 'number' && normalized.confidence !== before.confidence) {
    after.confidence = normalized.confidence;
    updateData._confidenceChanged = normalized.confidence;
    changed = true;
  }
  if (normalized.aiInsight !== undefined && normalized.aiInsight !== before.aiInsight) {
    after.aiInsight = normalized.aiInsight;
    updateData.aiInsight = normalized.aiInsight;
    changed = true;
  }
  if (normalized.agentNotes !== undefined) {
    const newNotes = JSON.stringify(normalized.agentNotes);
    if (newNotes !== JSON.stringify(before.agentNotes)) {
      after.agentNotes = normalized.agentNotes;
      updateData.agentNotes = normalized.agentNotes;
      changed = true;
    }
  }
  if (normalized.relations !== undefined) {
    const newRels = JSON.stringify(normalized.relations);
    if (newRels !== JSON.stringify(before.relations)) {
      after.relations = normalized.relations;
      updateData.relations = normalized.relations;
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

/* ═══ 对话式润色 — 流式预览 (SSE) ═══════════════════════ */

/**
 * POST /api/v1/candidates/refine-preview-stream
 * 润色预览 — 统一 SSE 协议，使用 chatWithStructuredOutput 获取可靠结构化结果
 *
 * 不再流式推送 JSON 碎片。改为：
 *   stream:start        — 会话开始
 *   data:progress       — AI 润色进度（前端展示进度条/加载动画）
 *   stream:done         — 完成，携带 before/after/preview
 *   stream:error        — 错误
 *
 * Body: { candidateId: string, userPrompt: string }
 */
router.post('/refine-preview-stream', asyncHandler(async (req, res) => {
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

  // ─── Session + EventSource 架构 ───
  const session = createStreamSession('refine');
  const prompt = buildRefinePrompt(before, userPrompt.trim());

  // 立即返回 sessionId
  res.json({ sessionId: session.sessionId });

  // 异步执行 AI 润色，通过 session 推送进度事件
  setImmediate(async () => {
    try {
      // 进度事件: AI 调用开始
      session.send({ type: 'data:progress', stage: 'ai_calling', message: 'AI 润色中...' });

      // 定时进度心跳 — AI 调用是阻塞的，前端需要看到动态变化
      const progressMsgs = [
        { delay: 3000,  stage: 'analyzing',    message: '正在分析候选内容...' },
        { delay: 8000,  stage: 'generating',   message: '正在生成润色建议...' },
        { delay: 16000, stage: 'thinking',     message: 'AI 深度分析中...' },
        { delay: 28000, stage: 'almost_done',  message: '即将完成，请稍候...' },
      ];
      const progressTimers = [];
      let aiDone = false;
      for (const pm of progressMsgs) {
        const t = setTimeout(() => {
          if (!aiDone) session.send({ type: 'data:progress', stage: pm.stage, message: pm.message });
        }, pm.delay);
        progressTimers.push(t);
      }
      // 超过 35 秒后每 15 秒报一次耗时
      const longTimer = setInterval(() => {
        if (aiDone) return;
        const elapsed = Math.round((Date.now() - session.createdAt) / 1000);
        session.send({ type: 'data:progress', stage: 'waiting', message: `AI 仍在处理中 (${elapsed}s)...` });
      }, 15_000);
      const longTimerStart = setTimeout(() => {}, 35_000); // placeholder
      progressTimers.push(longTimerStart);

      function clearProgressTimers() {
        aiDone = true;
        for (const t of progressTimers) clearTimeout(t);
        clearInterval(longTimer);
      }

      // 使用 chatWithStructuredOutput 获取可靠的 JSON 结果（非流式），120 秒超时
      let parsed;
      try {
        parsed = await Promise.race([
          aiProvider.chatWithStructuredOutput(prompt, { temperature: 0.3 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('AI refine timeout (120s)')), 120_000)),
        ]);
      } finally {
        clearProgressTimers();
      }

      if (parsed) {
        // 进度事件: 构建 diff
        session.send({ type: 'data:progress', stage: 'building_diff', message: '生成修改对比...' });

        const { after } = buildUpdateFromRefineResult(before, parsed);
        session.end({ candidateId, before, after, preview: parsed });
      } else {
        // 结构化输出失败，回退到 chat() 重试
        session.send({ type: 'data:progress', stage: 'fallback', message: 'AI 正在重新生成...' });
        const fullText = await aiProvider.chat(prompt, { temperature: 0.3 });

        let fallbackParsed = null;
        try {
          const jsonStr = fullText.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
          fallbackParsed = JSON.parse(jsonStr);
        } catch {
          const match = fullText.match(/\{[\s\S]*\}/);
          if (match) {
            try { fallbackParsed = JSON.parse(match[0]); } catch { /* ignore */ }
          }
        }

        if (fallbackParsed) {
          const { after } = buildUpdateFromRefineResult(before, fallbackParsed);
          session.end({ candidateId, before, after, preview: fallbackParsed });
        } else {
          session.end({ candidateId, before, after: before, preview: null, rawText: fullText });
        }
      }
    } catch (err) {
      logger.warn('SSE refine-preview stream error', { error: err.message });
      session.error(err.message, 'REFINE_ERROR');
    }
  });
}));

/**
 * GET /api/v1/candidates/refine-preview/events/:sessionId
 * EventSource SSE 端点 — 消费润色预览进度事件
 *
 * 复用 scan/events 相同的 SSE 交付模式：回放缓冲 → 订阅实时 → 心跳保活
 */
router.get('/refine-preview/events/:sessionId', (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found or expired' });
  }

  // ─── SSE Headers ───
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0);
  }

  function writeEvent(event) {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  // 1) 回放缓冲区
  let isDone = false;
  for (const event of session.buffer) {
    writeEvent(event);
    if (event.type === 'stream:done' || event.type === 'stream:error') {
      isDone = true;
    }
  }

  if (isDone || session.completed) {
    res.end();
    return;
  }

  // 2) 订阅实时事件
  const unsubscribe = session.on((event) => {
    writeEvent(event);
    if (event.type === 'stream:done' || event.type === 'stream:error') {
      unsubscribe();
      clearInterval(heartbeat);
      res.end();
    }
  });

  // 心跳保活 (每 15 秒)
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);

  // 客户端断开连接时清理
  res.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
});

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
    delete finalUpdate._markdownChanged;
    delete finalUpdate._rationaleChanged;

    const contentPatch = { ...(json.content || {}) };
    let contentChanged = false;
    if (updateData._patternChanged != null) {
      contentPatch.pattern = updateData._patternChanged;
      contentChanged = true;
    }
    if (updateData._markdownChanged != null) {
      contentPatch.markdown = updateData._markdownChanged;
      contentChanged = true;
    }
    if (updateData._rationaleChanged != null) {
      contentPatch.rationale = updateData._rationaleChanged;
      contentChanged = true;
    }
    if (contentChanged) {
      finalUpdate.content = contentPatch;
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
