import type { KnowledgeManagementPort, KnowledgeReadPort } from '@alembic/agent/tools/runtime';
import type { KnowledgeService } from '@alembic/core/knowledge';
import { NotFoundError } from '@alembic/core/shared';

export type KnowledgeServiceHostPort = Pick<KnowledgeService, 'get' | 'update' | 'reject'>;
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
      return (await service.update(id, data, context)).toJSON();
    },
    async reject(id, reason) {
      return (await service.reject(id, reason, context)).toJSON();
    },
  };
}
