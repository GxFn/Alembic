/**
 * AlinkHandler — 处理 alink 指令
 *
 * 解析编辑器中的 alink 触发行，提取 completionKey，
 * 通过数据库查找匹配的 Recipe，打开 Dashboard 详情页。
 */

import { and, eq } from 'drizzle-orm';
import { getServiceContainer } from '#inject/ServiceContainer.js';
import { knowledgeEntries } from '../../../infrastructure/database/drizzle/schema.js';

/**
 * @param {string} alinkLine
 */
export async function handleAlink(alinkLine: string) {
  const { TRIGGER_SYMBOL } = await import('../../../infrastructure/config/TriggerSymbol.js');
  let completionKey: string | null = null;
  const alinkMark = 'alink';

  if (alinkLine.includes(TRIGGER_SYMBOL)) {
    const parts = alinkLine
      .split(TRIGGER_SYMBOL)
      .map((p: string) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2 && parts[parts.length - 1] === alinkMark) {
      completionKey = parts[parts.length - 2];
    }
  }

  if (completionKey != null) {
    try {
      // 从 DI 容器获取数据库实例，查找匹配 trigger 的 Recipe
      const container = getServiceContainer();
      const db = container.get('database');

      let recipeId: string | number | null = null;
      if (db) {
        const rawDb = typeof db.getDb === 'function' ? db.getDb() : db;
        try {
          // ★ Drizzle 类型安全 — 精确匹配 trigger
          const drizzle = typeof db.getDrizzle === 'function' ? db.getDrizzle() : null;
          if (!drizzle) {
            throw new Error('Drizzle not available');
          }
          const row = drizzle
            .select({ id: knowledgeEntries.id })
            .from(knowledgeEntries)
            .where(
              and(
                eq(knowledgeEntries.trigger, completionKey),
                eq(knowledgeEntries.lifecycle, 'active')
              )
            )
            .limit(1)
            .get();
          if (row) {
            recipeId = row.id;
          }
        } catch {
          // DB 查询失败时回退到搜索
        }

        // 若精确匹配失败，尝试模糊搜索（保留 raw SQL — LIKE + ESCAPE）
        if (!recipeId) {
          try {
            const rawDb2 = typeof db.getDb === 'function' ? db.getDb() : db;
            const escaped = completionKey.replace(/[%_\\]/g, (ch: string) => `\\${ch}`);
            const row = rawDb2
              .prepare(
                "SELECT id FROM knowledge_entries WHERE (trigger LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') AND lifecycle = 'active' LIMIT 1"
              )
              .get(`%${escaped}%`, `%${escaped}%`);
            if (row) {
              recipeId = (row as Record<string, unknown>).id as string;
            }
          } catch {
            /* silent */
          }
        }
      }

      // 构建 Dashboard URL 并打开
      const port = process.env.ASD_DASHBOARD_PORT || 3000;
      const host = process.env.ASD_DASHBOARD_HOST || 'localhost';
      const url = recipeId
        ? `http://${host}:${port}/#/recipes/${recipeId}`
        : `http://${host}:${port}/#/search?q=${encodeURIComponent(completionKey)}`;

      const open = (await import('open')).default;
      await open(url);
    } catch (err: unknown) {
      console.warn(`[alink] Failed to open link: ${(err as Error).message}`);
    }
  }
}
