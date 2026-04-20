/**
 * resolveProjectRoot — 统一的 projectRoot 解析辅助函数
 *
 * 三级 fallback:
 *   1. ServiceContainer.singletons._projectRoot（最可靠，Bootstrap 后一定有值）
 *   2. process.env.ALEMBIC_PROJECT_DIR（MCP/HTTP Server 启动时设置）
 *   3. process.cwd()（CLI 模式下通常正确；MCP 模式下可能是 $HOME）
 *
 * 用于 MCP handler / HTTP route / Service 内部获取项目根目录，
 * 替代散落在各处的裸 `process.cwd()` 调用。
 */

import { WorkspaceResolver } from './WorkspaceResolver.js';

/** ServiceContainer 最小类型，避免循环依赖 */
interface ContainerLike {
  singletons?: {
    _projectRoot?: unknown;
    _workspaceResolver?: unknown;
    [key: string]: unknown;
  };
}

/**
 * 解析项目根目录
 * @param container DI 容器实例（McpContext.container / getServiceContainer()）
 * @returns 项目根目录绝对路径
 */
export function resolveProjectRoot(container?: ContainerLike | null): string {
  const fromContainer = container?.singletons?._projectRoot;
  if (typeof fromContainer === 'string' && fromContainer) {
    return fromContainer;
  }
  return process.env.ALEMBIC_PROJECT_DIR || process.cwd();
}

/**
 * 解析数据根目录（Ghost 感知）
 *
 * Ghost 模式下返回 ~/.asd/workspaces/<id>/，标准模式下返回 projectRoot。
 * 所有运行时数据（.asd/）和知识库（Alembic/）的写入应基于 dataRoot。
 *
 * @param container DI 容器实例
 * @returns 数据根目录绝对路径
 */
export function resolveDataRoot(container?: ContainerLike | null): string {
  const resolver = container?.singletons?._workspaceResolver as WorkspaceResolver | undefined;
  if (resolver) {
    return resolver.dataRoot;
  }

  // fallback: 即使没有 container，也尝试根据 projectRoot 自动恢复 Ghost 模式 dataRoot
  try {
    return WorkspaceResolver.fromProject(resolveProjectRoot(container)).dataRoot;
  } catch {
    return resolveProjectRoot(container);
  }
}

/**
 * 获取 WorkspaceResolver 实例
 * @param container DI 容器实例
 * @returns WorkspaceResolver 或 null（未初始化时）
 */
export function resolveWorkspace(container?: ContainerLike | null): WorkspaceResolver | null {
  return (container?.singletons?._workspaceResolver as WorkspaceResolver) ?? null;
}
