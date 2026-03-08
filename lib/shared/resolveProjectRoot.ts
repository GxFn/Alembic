/**
 * resolveProjectRoot — 统一的 projectRoot 解析辅助函数
 *
 * 三级 fallback:
 *   1. ServiceContainer.singletons._projectRoot（最可靠，Bootstrap 后一定有值）
 *   2. process.env.ASD_PROJECT_DIR（MCP/HTTP Server 启动时设置）
 *   3. process.cwd()（CLI 模式下通常正确；MCP 模式下可能是 $HOME）
 *
 * 用于 MCP handler / HTTP route / Service 内部获取项目根目录，
 * 替代散落在各处的裸 `process.cwd()` 调用。
 */

/** ServiceContainer 最小类型，避免循环依赖 */
interface ContainerLike {
  singletons?: { _projectRoot?: unknown; [key: string]: unknown };
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
  return process.env.ASD_PROJECT_DIR || process.cwd();
}
