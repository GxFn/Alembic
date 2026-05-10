#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readPackageInfo } from "../lib/codex/package-info.js";
import { CODEX_TOOLS, handleCodexTool } from "../lib/codex/tools.js";

// Codex 插件入口只设置 runtime 标记；真正长任务交给后续 daemon 批次承载。
process.env.ALEMBIC_MCP_MODE = "1";
process.env.ALEMBIC_CODEX_MCP_MODE = "1";
process.env.ALEMBIC_MCP_TIER = process.env.ALEMBIC_MCP_TIER || "agent";

const packageInfo = readPackageInfo();
const server = new McpServer(
  { name: "alembic-codex", version: packageInfo.version },
  { capabilities: { tools: {} } },
);

server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: CODEX_TOOLS,
}));

// stdio 层只做协议适配，业务结果统一交给 codex/tools.ts 生成，便于 CLI 复用。
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await handleCodexTool(
    request.params.name,
    (request.params.arguments || {}) as Record<string, unknown>,
  );
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: result.success ? undefined : true,
  };
});

await server.connect(new StdioServerTransport());
process.stderr.write(`Alembic Codex MCP ready - ${CODEX_TOOLS.length} tools\n`);
