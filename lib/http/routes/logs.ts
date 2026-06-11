/**
 * Logs API 路由
 *
 * 端点:
 *   GET /api/v1/logs — 读取日志文件最近 N 行
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { resolveDataRoot } from '@alembic/core/workspace';
import { type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validateQuery } from '../middleware/validate.js';

const router = Router();

const blankToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

const LogsQuery = z.object({
  file: z.preprocess(blankToUndefined, z.enum(['combined', 'error', 'audit']).default('combined')),
  level: z.preprocess(blankToUndefined, z.enum(['error', 'warn', 'info', 'debug']).optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(200)),
  search: z.preprocess(blankToUndefined, z.string().trim().min(1).optional()),
});

/**
 * 从文件末尾读取最后 N 行（逐行反向读取）
 */
async function tailLines(filePath: string, maxLines: number): Promise<string[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const lines: string[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lines.push(line);
    if (lines.length > maxLines * 2) {
      // 避免内存爆炸：保留后半段
      lines.splice(0, lines.length - maxLines);
    }
  }

  return lines.slice(-maxLines);
}

/**
 * GET /api/v1/logs
 *
 * Query params:
 *   file   — 日志文件名: combined | error | audit (默认 combined)
 *   limit  — 返回行数 (默认 200, 最大 1000)
 *   level  — 级别过滤: error | warn | info | debug
 *   search — 文本搜索
 */
router.get('/', validateQuery(LogsQuery), async (req: Request, res: Response): Promise<void> => {
  try {
    const dataRoot = resolveDataRoot(getServiceContainer());
    if (!dataRoot) {
      res.status(503).json({
        success: false,
        error: { code: 'NO_PROJECT', message: 'No project root configured' },
      });
      return;
    }

    const query = req.query as unknown as z.infer<typeof LogsQuery>;
    const fileName = query.file;
    const limit = Math.min(query.limit, 1000);
    const levelFilter = query.level;
    const searchFilter = query.search;

    const logsDir = path.resolve(dataRoot, '.asd/logs');
    const filePath = path.join(logsDir, `${fileName}.log`);

    // 路径遍历防护
    if (!filePath.startsWith(logsDir)) {
      res
        .status(400)
        .json({ success: false, error: { code: 'INVALID_PATH', message: 'Invalid file name' } });
      return;
    }

    const rawLines = await tailLines(filePath, limit * 3); // 多读一些以补偿过滤

    const entries: Array<{
      timestamp?: string;
      level?: string;
      message?: string;
      tag?: string;
      raw: string;
    }> = [];

    for (const line of rawLines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const obj = JSON.parse(line);
        const entry = {
          timestamp: obj.timestamp,
          level: obj.level,
          message: obj.message,
          tag: obj.tag,
          raw: line,
        };

        // 级别过滤
        if (levelFilter && entry.level !== levelFilter) {
          continue;
        }

        // 文本搜索
        if (searchFilter) {
          const lower = searchFilter.toLowerCase();
          if (
            !(entry.message || '').toLowerCase().includes(lower) &&
            !(entry.tag || '').toLowerCase().includes(lower)
          ) {
            continue;
          }
        }

        entries.push(entry);
      } catch {
        // 非 JSON 行，作为纯文本
        if (levelFilter) {
          continue;
        }
        if (searchFilter && !line.toLowerCase().includes(searchFilter.toLowerCase())) {
          continue;
        }
        entries.push({ raw: line });
      }
    }

    // 返回最后 limit 条，最新在前
    const result = entries.slice(-limit).reverse();

    res.json({
      success: true,
      data: {
        file: fileName,
        total: result.length,
        entries: result,
      },
    });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'LOG_READ_ERROR', message: (err as Error).message },
    });
  }
});

export default router;
