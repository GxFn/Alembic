#!/usr/bin/env node

/**
 * AutoSnippet V2 MCP Server 入口
 * 供 Cursor / VSCode Copilot MCP 配置使用
 *
 * VSCode 配置示例 (.vscode/mcp.json):
 * {
 *   "servers": {
 *     "autosnippet": {
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
 *     "autosnippet": {
 *       "command": "node",
 *       "args": ["/path/to/v2/bin/mcp-server.js"]
 *     }
 *   }
 * }
 */

// 标记 MCP 模式 — 必须在任何模块加载前设置
// 使用动态 import() 避免 ESM static import hoisting 导致 env 未就绪
process.env.ASD_MCP_MODE = '1';

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

process.on('SIGTERM', () => {
  process.stderr.write('[MCP] Received SIGTERM, shutting down…\n');
  process.exit(0);
});
process.on('SIGINT', () => {
  process.stderr.write('[MCP] Received SIGINT, shutting down…\n');
  process.exit(0);
});

const { startMcpServer } = await import('../lib/external/mcp/McpServer.js');

startMcpServer().catch((err) => {
  process.stderr.write(`MCP Server failed to start: ${err.message}\n`);
  process.exit(1);
});
