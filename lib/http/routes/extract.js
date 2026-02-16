/**
 * Extract API 路由
 * 从路径或文本提取 Recipe 候选
 */

import express from 'express';
import { basename } from 'node:path';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { ValidationError } from '../../shared/errors/index.js';
import Logger from '../../infrastructure/logging/Logger.js';

const router = express.Router();
const logger = Logger.getInstance();

/**
 * POST /api/v1/extract/path
 * 从文件路径提取代码片段
 * 管线: RecipeParser(MD解析) → AI 提取(ChatAgent) → 原始兜底
 */
router.post('/path', asyncHandler(async (req, res) => {
  const { relativePath, projectRoot: bodyRoot } = req.body;

  if (!relativePath) {
    throw new ValidationError('relativePath is required');
  }

  const container = getServiceContainer();
  const recipeParser = container.get('recipeParser');

  // 优先用请求体的 projectRoot，其次用 ServiceContainer 中注册的全局值
  const projectRoot = bodyRoot || container.singletons?._projectRoot || process.cwd();
  logger.debug('extract/path: resolved projectRoot', { relativePath, projectRoot, source: bodyRoot ? 'body' : container.singletons?._projectRoot ? 'container' : 'cwd' });

  // 1. RecipeParser 解析（对 Recipe MD 文件有效）
  const result = await recipeParser.extractFromPath(relativePath, {
    projectRoot,
  });

  const items = result.items || result;

  // 2. 判断是否为"原始兜底"结果（无 frontmatter → summary/usageGuide 全空）
  const isRawFallback = Array.isArray(items) && items.length > 0
    && !items[0].summary && !items[0].usageGuide && !items[0].frontmatter?.title;

  if (isRawFallback) {
    // 3. 尝试 ChatAgent AI 提取
    try {
      const chatAgent = container.get('chatAgent');
      const file = items[0];
      const fileName = basename(relativePath);   // 保留扩展名: BDMineViewController.m
      const aiResult = await chatAgent.executeTool('extract_recipes', {
        targetName: fileName,
        files: [{ name: fileName, content: file.code || '' }],
        comprehensive: true,
      });

      if (aiResult && !aiResult.error && Array.isArray(aiResult.recipes) && aiResult.recipes.length > 0) {
        logger.info('extract/path: AI extraction succeeded', { count: aiResult.recipes.length });
        return res.json({
          success: true,
          data: {
            result: aiResult.recipes,
            isMarked: false,
          },
        });
      }
    } catch (err) {
      logger.debug('extract/path: AI extraction failed, using raw fallback', { error: err.message });
    }
  }

  // 4. 返回 RecipeParser 结果（MD 文件或 AI 不可用时的原始兜底）
  res.json({
    success: true,
    data: {
      result: items,
      isMarked: result.isMarked || false,
    },
  });
}));

/**
 * POST /api/v1/extract/text
 * 从文本内容提取代码片段（剪贴板等）
 * 管线: RecipeParser(MD解析) → AI 提取(ChatAgent) → 基础兜底
 */
router.post('/text', asyncHandler(async (req, res) => {
  const { text, language, relativePath, projectRoot: bodyRoot } = req.body;

  if (!text) {
    throw new ValidationError('text is required');
  }

  const container = getServiceContainer();
  const recipeParser = container.get('recipeParser');
  const projectRoot = bodyRoot || container.singletons?._projectRoot || process.cwd();

  // 1. 先尝试解析为 Recipe Markdown 格式
  let result;
  try {
    result = await recipeParser.parseFromText(text, {
      language,
      relativePath,
    });
    // 解析成功，直接返回
    return res.json({
      success: true,
      data: {
        result: Array.isArray(result) ? result : [result],
        source: 'text',
      },
    });
  } catch (error) {
    logger.debug('Recipe MD parse failed, trying AI extraction', {
      error: error.message,
    });
  }

  // 2. Recipe MD 解析失败 → 尝试 ChatAgent AI 提取
  try {
    const chatAgent = container.get('chatAgent');
    if (chatAgent) {
      const lang = language || (relativePath && /\.swift$/i.test(relativePath) ? 'swift' : 'objc');
      const fileName = relativePath ? basename(relativePath) : `clipboard.${lang === 'swift' ? 'swift' : 'm'}`;
      const aiResult = await chatAgent.executeTool('extract_recipes', {
        targetName: fileName,
        files: [{ name: fileName, content: text }],
        comprehensive: true,
      });

      if (aiResult && !aiResult.error && Array.isArray(aiResult.recipes) && aiResult.recipes.length > 0) {
        logger.info('extract/text: AI extraction succeeded', { count: aiResult.recipes.length });

        // 多条 Recipe 时在第一条上标记总数（供前端提示）
        if (aiResult.recipes.length > 1) {
          aiResult.recipes[0]._multipleCount = aiResult.recipes.length;
        }

        return res.json({
          success: true,
          data: {
            result: aiResult.recipes,
            source: 'text',
          },
        });
      }
    }
  } catch (err) {
    logger.debug('extract/text: AI extraction failed, using basic fallback', { error: err.message });
  }

  // 3. AI 也失败 → 基础代码块提取兜底
  result = await recipeParser.extractFromText(text, { language });

  res.json({
    success: true,
    data: {
      result: Array.isArray(result) ? result : [result],
      source: 'text',
    },
  });
}));

export default router;
