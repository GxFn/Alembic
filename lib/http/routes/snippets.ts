/**
 * Snippets API 路由
 * Snippet = Recipe 的附属产物，从 Recipe 实时生成，不存 DB
 */

import express from 'express';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

/**
 * GET /api/v1/snippets
 * 从 Recipe 实时生成 Snippet 列表
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const snippetFactory = container.get('snippetFactory');

    const { language, category, keyword } = req.query;
    const filters: any = {};
    if (language) {
      filters.language = language;
    }
    if (category) {
      filters.category = category;
    }
    if (keyword) {
      filters.keyword = keyword;
    }

    const snippets = await snippetFactory.listSnippets(filters);

    res.json({
      success: true,
      data: {
        snippets,
        total: snippets.length,
      },
    });
  })
);

/**
 * GET /api/v1/snippets/:id
 * 从单个 Recipe 实时生成 Snippet
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const snippetFactory = container.get('snippetFactory');

    const snippet = await snippetFactory.getSnippet(req.params.id);
    if (!snippet) {
      throw new NotFoundError('Snippet (recipe)', req.params.id);
    }

    res.json({ success: true, data: snippet });
  })
);

export default router;
