/**
 * Snippets API 路由
 * Snippet = Recipe 的附属产物，从 Recipe 实时生成，不存 DB
 */

import express, { type Request, type Response } from 'express';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { NotFoundError } from '../../shared/errors/index.js';

const router = express.Router();

/**
 * GET /api/v1/snippets
 * 从 Recipe 实时生成 Snippet 列表
 */
router.get('/', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const snippetFactory = container.get('snippetFactory');

  const { language, category, keyword } = req.query;
  const filters: Record<string, string> = {};
  if (language) {
    filters.language = String(language);
  }
  if (category) {
    filters.category = String(category);
  }
  if (keyword) {
    filters.keyword = String(keyword);
  }

  const snippets = await snippetFactory.listSnippets(filters);

  res.json({
    success: true,
    data: {
      snippets,
      total: snippets.length,
    },
  });
});

/**
 * GET /api/v1/snippets/:id
 * 从单个 Recipe 实时生成 Snippet
 */
router.get('/:id', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const snippetFactory = container.get('snippetFactory');

  const snippet = await snippetFactory.getSnippet(req.params.id);
  if (!snippet) {
    throw new NotFoundError('Snippet (recipe)', req.params.id as string);
  }

  res.json({ success: true, data: snippet });
});

export default router;
