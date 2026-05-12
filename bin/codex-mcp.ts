#!/usr/bin/env node

/**
 * Alembic Codex MCP shim.
 * Lightweight stdio entry: lists tools immediately and starts/connects daemon only when a tool needs Core.
 */

const { ensureCodexRuntimeEnvironment } = await import('../lib/codex/index.js');
ensureCodexRuntimeEnvironment();

process.on('uncaughtException', (error) => {
  process.stderr.write(`[Codex MCP] Uncaught Exception: ${error.message}\n`);
  if (error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[Codex MCP] Unhandled Rejection: ${message}\n`);
  process.exit(1);
});

const { shutdown } = await import('../lib/shared/shutdown.js');
const { timerRegistry } = await import('../lib/shared/TimerRegistry.js');
shutdown.install();
shutdown.register(async () => {
  await timerRegistry.dispose();
}, 'timer-registry');

const { startCodexMcpServer } = await import('../lib/external/mcp/CodexMcpServer.js');

startCodexMcpServer()
  .then((server) => {
    shutdown.register(() => server.shutdown(), 'codex-mcp-server');
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Codex MCP Server failed to start: ${message}\n`);
    process.exit(1);
  });
