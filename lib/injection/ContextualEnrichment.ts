/** 向量资源持有稳定的 delegate；每次操作再解析当前生成型 enricher。 */
import Logger from '@alembic/core/logging';
import type { VectorChunkEnricher } from '@alembic/core/vector';
import type { ServiceContainer } from './ServiceContainer.js';

export function createLiveContextualEnricher(c: ServiceContainer): VectorChunkEnricher | null {
  const vector = (c.singletons._config as { vector?: { contextualEnrich?: boolean } } | undefined)
    ?.vector;
  if (!vector?.contextualEnrich) {
    return null;
  }
  return {
    async enrichChunks(document, chunks) {
      const current = c.services.contextualEnricher ? c.get('contextualEnricher') : null;
      if (!current) {
        Logger.getInstance().debug(
          '[embedding] context_enrichment_skipped; LLM unavailable, fixed vectors remain independent'
        );
        return chunks;
      }
      // 一批 chunks 固定同一个生成实例；下一批才观察新 LLM，避免混合在途状态。
      return current.enrichChunks(document, chunks);
    },
  };
}
