import type {
  KnowledgeManagementPort,
  KnowledgeReadPort,
  KnowledgeSearchPort,
} from '@alembic/agent/tools/runtime';
import type { KnowledgeService } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import type { SearchEngine } from '@alembic/core/search';
import { NotFoundError } from '@alembic/core/shared';
import { requireKnowledgeWriteReceipt } from '../shared/knowledge-write-receipt.js';

export type KnowledgeServiceHostPort = Pick<KnowledgeService, 'get' | 'update' | 'reject'>;
export type KnowledgeSearchServiceHostPort = Pick<SearchEngine, 'search'>;
export type KnowledgeServiceAdapter = KnowledgeReadPort &
  Required<Pick<KnowledgeManagementPort, 'update' | 'reject'>>;

/**
 * 将宿主知识服务绑定到工具端口；Core 实体仅以 wire 数据离开此边界。
 * 调用者身份来自宿主 request.actor，不能从模型生成的管理参数中读取。
 */
export function createKnowledgeServiceAdapter(
  service: KnowledgeServiceHostPort,
  userId: string
): KnowledgeServiceAdapter {
  const context: Parameters<KnowledgeService['update']>[2] = { userId };
  return {
    async getById(id) {
      try {
        return (await service.get(id)).toJSON();
      } catch (err: unknown) {
        // 仅把本条知识的真实缺失转为读取端口的 null；数据库/权限等错误原样传播。
        if (err instanceof NotFoundError && err.resource === 'knowledge' && err.resourceId === id) {
          return null;
        }
        throw err;
      }
    },
    async update(id, data) {
      // 系统标签合并、profile 校验及持久化顺序继续由 Core 服务负责。
      return requireKnowledgeWriteReceipt(
        await service.update(id, data, context),
        'update',
        id
      ).toJSON();
    },
    async reject(id, reason) {
      return requireKnowledgeWriteReceipt(
        await service.reject(id, reason, context),
        'reject',
        id
      ).toJSON();
    },
  };
}

/** Core SearchResponse 在此转为 Agent 的命中 DTO；不把生命周期分类误传为物理 kind。 */
export function createKnowledgeSearchAdapter(
  service: KnowledgeSearchServiceHostPort
): KnowledgeSearchPort {
  const supportedKinds = Object.freeze(['all']);
  return {
    supportedKinds,
    async search(query, options) {
      if (options.kind !== undefined && !supportedKinds.includes(options.kind)) {
        // Core 无 limit 前的 lifecycle 过滤口；不能先截断再筛选来冒充完整 recipe/candidate 搜索。
        throw Object.assign(
          new Error(
            `KNOWLEDGE_SEARCH_FILTER_UNSUPPORTED: lifecycle kind '${options.kind}' is not supported by the configured search port`
          ),
          {
            code: 'KNOWLEDGE_SEARCH_FILTER_UNSUPPORTED',
            details: { kind: options.kind, supportedKinds },
          }
        );
      }
      const result = await service.search(query, {
        type: 'all',
        limit: options.limit,
        ...(options.category !== undefined ? { category: options.category } : {}),
      });
      return result.items.map((item) => {
        const score =
          typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : 0;
        if (score !== item.score || item.title === undefined) {
          Logger.getInstance().debug('[KnowledgeSearchAdapter] normalized optional search fields', {
            scoreDefaulted: score !== item.score,
            titleDefaulted: item.title === undefined,
          });
        }
        return { ...item, title: item.title ?? '', score };
      });
    },
  };
}
