/**
 * Legacy compatibility alias.
 *
 * Alembic 的 task 实现已迁入本地 resident tool handler：
 * `lib/resident/tool-handlers/task.ts`。保留本入口只为旧测试和外部历史 import
 * 继续解析；当所有消费者都切到 resident 路径并由总控授权删除时，可移除此文件。
 */

export * from '../../../resident/tool-handlers/task.js';
