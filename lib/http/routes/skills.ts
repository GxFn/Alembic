/**
 * Skills API 路由
 * 管理 Agent Skills 的查询、加载和创建（项目级）
 */

import express, { type Request, type Response } from 'express';
import { CreateSkillBody, UpdateSkillBody } from '#shared/schemas/http-requests.js';
import {
  createSkill,
  deleteSkill,
  listSkills,
  loadSkill,
  suggestSkills,
  updateSkill,
} from '../../external/mcp/handlers/skill.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

/**
 * GET /api/v1/skills
 * 列出所有可用 Skills（内置 + 项目级）
 */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const raw = listSkills();
  let parsed: { success: boolean; data?: unknown; error?: { code?: string; message?: string } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return void res.status(500).json({
      success: false,
      error: { code: 'PARSE_ERROR', message: 'Invalid response from listSkills' },
    });
  }

  if (!parsed.success) {
    return void res.status(500).json(parsed);
  }

  res.json({ success: true, data: parsed.data });
});

/**
 * GET /api/v1/skills/signal-status
 * 获取 SignalCollector 后台服务状态
 */
router.get('/signal-status', async (_req: Request, res: Response): Promise<void> => {
  const { _signalCollector } = global as unknown as Record<
    string,
    Record<string, (...args: unknown[]) => unknown>
  >;
  if (!_signalCollector) {
    return void res.json({
      success: true,
      data: { running: false, mode: 'off', snapshot: null },
    });
  }
  res.json({
    success: true,
    data: {
      running: true,
      mode: _signalCollector.getMode(),
      snapshot: _signalCollector.getSnapshot(),
      // 返回 AI 的待处理建议，前端可直接展示
      suggestions:
        (_signalCollector.getSnapshot() as Record<string, unknown>).pendingSuggestions || [],
    },
  });
});

/**
 * GET /api/v1/skills/suggest
 * 基于使用模式分析，推荐创建 Skill
 */
router.get('/suggest', async (req: Request, res: Response): Promise<void> => {
  const ctx = { container: req.app.locals?.container || null };
  const raw = await suggestSkills(ctx);
  let parsed: { success: boolean; data?: unknown; error?: { code?: string; message?: string } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return void res.status(500).json({
      success: false,
      error: { code: 'PARSE_ERROR', message: 'Invalid response from suggestSkills' },
    });
  }

  if (!parsed.success) {
    return void res.status(500).json(parsed);
  }

  res.json({ success: true, data: parsed.data });
});

/**
 * GET /api/v1/skills/:name
 * 加载指定 Skill 的完整文档
 * Query: ?section=xxx 可只返回指定章节
 */
router.get('/:name', async (req: Request, res: Response): Promise<void> => {
  const { name } = req.params;
  const { section } = req.query;

  const raw = loadSkill(null, {
    skillName: name as string,
    section: section as string | undefined,
  });
  let parsed: { success: boolean; data?: unknown; error?: { code?: string; message?: string } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return void res.status(500).json({
      success: false,
      error: { code: 'PARSE_ERROR', message: 'Invalid response from loadSkill' },
    });
  }

  if (!parsed.success) {
    const status = parsed.error?.code === 'SKILL_NOT_FOUND' ? 404 : 400;
    return void res.status(status).json(parsed);
  }

  res.json({ success: true, data: parsed.data });
});

/**
 * POST /api/v1/skills
 * 创建项目级 Skill
 * Body: { name, description, content, overwrite? }
 */
router.post('/', validate(CreateSkillBody), async (req: Request, res: Response): Promise<void> => {
  const { name, description, content, overwrite, createdBy } = req.body;

  const raw = createSkill(null, {
    name,
    description,
    content,
    overwrite,
    createdBy: createdBy || 'manual',
  });
  let parsed: { success: boolean; data?: unknown; error?: { code?: string; message?: string } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return void res.status(500).json({
      success: false,
      error: { code: 'PARSE_ERROR', message: 'Invalid response from createSkill' },
    });
  }

  if (!parsed.success) {
    const status =
      parsed.error?.code === 'BUILTIN_CONFLICT'
        ? 409
        : parsed.error?.code === 'ALREADY_EXISTS'
          ? 409
          : parsed.error?.code === 'INVALID_NAME'
            ? 400
            : 500;
    return void res.status(status).json(parsed);
  }

  res.status(201).json({ success: true, data: parsed.data });
});

/**
 * PUT /api/v1/skills/:name
 * 更新项目级 Skill（description / content）
 */
router.put(
  '/:name',
  validate(UpdateSkillBody),
  async (req: Request, res: Response): Promise<void> => {
    const { name } = req.params;
    const { description, content } = req.body;

    const raw = updateSkill(null, { name: name as string, description, content });
    let parsed: { success: boolean; data?: unknown; error?: { code?: string; message?: string } };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return void res.status(500).json({
        success: false,
        error: { code: 'PARSE_ERROR', message: 'Invalid response from updateSkill' },
      });
    }

    if (!parsed.success) {
      const status =
        parsed.error?.code === 'SKILL_NOT_FOUND'
          ? 404
          : parsed.error?.code === 'BUILTIN_PROTECTED'
            ? 403
            : 500;
      return void res.status(status).json(parsed);
    }

    res.json({ success: true, data: parsed.data });
  }
);

/**
 * DELETE /api/v1/skills/:name
 * 删除项目级 Skill
 */
router.delete('/:name', async (req: Request, res: Response): Promise<void> => {
  const { name } = req.params;

  const raw = deleteSkill(null, { name: name as string });
  let parsed: { success: boolean; data?: unknown; error?: { code?: string; message?: string } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return void res.status(500).json({
      success: false,
      error: { code: 'PARSE_ERROR', message: 'Invalid response from deleteSkill' },
    });
  }

  if (!parsed.success) {
    const status =
      parsed.error?.code === 'SKILL_NOT_FOUND'
        ? 404
        : parsed.error?.code === 'BUILTIN_PROTECTED'
          ? 403
          : 500;
    return void res.status(status).json(parsed);
  }

  res.json({ success: true, data: parsed.data });
});

// ── POST /api/v1/skills/feedback — 记录推荐反馈 ──

router.post('/feedback', async (req, res) => {
  const { recommendationId, action, reason, source, category } = req.body || {};

  if (!recommendationId || !action) {
    return void res.status(400).json({
      success: false,
      error: { code: 'MISSING_PARAMS', message: 'recommendationId and action are required' },
    });
  }

  const validActions = ['adopted', 'dismissed', 'expired', 'viewed', 'modified'];
  if (!validActions.includes(action)) {
    return void res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_ACTION',
        message: `action must be one of: ${validActions.join(', ')}`,
      },
    });
  }

  try {
    const container = getServiceContainer();
    const feedbackStore = container?.get?.('feedbackStore') as {
      record: (f: Record<string, unknown>) => Promise<void>;
    } | null;
    if (!feedbackStore || typeof feedbackStore.record !== 'function') {
      return void res.status(503).json({
        success: false,
        error: { code: 'STORE_UNAVAILABLE', message: 'FeedbackStore not initialized' },
      });
    }

    await feedbackStore.record({
      recommendationId,
      action,
      timestamp: new Date().toISOString(),
      source,
      category,
      reason,
    });

    res.json({ success: true, data: { recorded: true, recommendationId, action } });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'FEEDBACK_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
});

// ── GET /api/v1/skills/metrics — 推荐效果指标 ──

router.get('/metrics', (req, res) => {
  try {
    const container = getServiceContainer();
    const metrics = container?.get?.('recommendationMetrics') as {
      getGlobalSnapshot: (since?: Date) => Record<string, unknown>;
      getSessionMetrics: () => Record<string, unknown>;
    } | null;
    if (!metrics || typeof metrics.getGlobalSnapshot !== 'function') {
      return void res.status(503).json({
        success: false,
        error: { code: 'METRICS_UNAVAILABLE', message: 'RecommendationMetrics not initialized' },
      });
    }

    const sinceParam = req.query.since as string | undefined;
    const since = sinceParam ? new Date(sinceParam) : undefined;
    const snapshot = metrics.getGlobalSnapshot(since);
    const session = metrics.getSessionMetrics();

    res.json({
      success: true,
      data: { global: snapshot, session },
    });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'METRICS_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
});

export default router;
