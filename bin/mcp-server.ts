#!/usr/bin/env node

/**
 * Alembic V2 MCP Server 入口
 * 供 Cursor / VSCode Copilot MCP 配置使用
 *
 * VSCode 配置示例 (.vscode/mcp.json):
 * {
 *   "servers": {
 *     "alembic": {
 *       "type": "stdio",
 *       "command": "node",
 *       "args": ["/path/to/v2/bin/mcp-server.js"]
 *     }
 *   }
 * }
 *
 * Cursor 配置示例 (.cursor/mcp.json):
 * {
 *   "mcpServers": {
 *     "alembic": {
 *       "command": "node",
 *       "args": ["/path/to/v2/bin/mcp-server.js"]
 *     }
 *   }
 * }
 */

// 标记 MCP 模式 — 必须在任何模块加载前设置
// 使用动态 import() 避免 ESM static import hoisting 导致 env 未就绪
process.env.ALEMBIC_MCP_MODE = '1';

// ─── 进程级错误兜底 ────────────────────────────────────
process.on('uncaughtException', (error) => {
  process.stderr.write(`[MCP] Uncaught Exception: ${error.message}\n`);
  if (error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[MCP] Unhandled Rejection: ${msg}\n`);
  process.exit(1);
});

// ─── Graceful Shutdown ─────────────────────────────────
// 使用统一的 shutdown 协调器替代直接 process.exit(0)
// 确保 DB WAL 刷盘、进行中请求排空、Socket.io 关闭
const { shutdown } = await import('../lib/shared/shutdown.js');
const { timerRegistry } = await import('../lib/shared/TimerRegistry.js');
shutdown.install();

// 定时器注册中心 — 最早注册，LIFO 保证最后执行（在其他组件之后清理）
shutdown.register(async () => {
  await timerRegistry.dispose();
}, 'timer-registry');

const { startMcpServer } = await import('../lib/external/mcp/McpServer.js');

startMcpServer()
  .then((server) => {
    // 注册 McpServer 清理 hook（内含 MCP transport close + bootstrap.shutdown + db.close）
    shutdown.register(() => server.shutdown(), 'mcp-server');
  })
  .catch((err) => {
    process.stderr.write(`MCP Server failed to start: ${err.message}\n`);
    process.exit(1);
  });
