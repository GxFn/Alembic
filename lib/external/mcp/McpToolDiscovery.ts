/**
 * McpToolDiscovery — MCP 工具动态发现服务
 *
 * 启动时从项目目录扫描 MCP 配置文件（.vscode/mcp.json, .cursor/mcp.json），
 * 解析出内联 McpToolDeclaration[]，供 AgentModule 注入主 catalog。
 *
 * 注意：VSCode/Cursor 的标准 mcp.json 通常只声明 server，不包含工具 schema；
 * 这属于正常情况，不应在 info 日志中显示为 loaded 0。
 *
 * @module external/mcp/McpToolDiscovery
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Logger from '#infra/logging/Logger.js';
import type { McpToolDeclaration } from './McpCapabilityProjection.js';

interface McpServerConfig {
  command?: string;
  args?: string[];
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
}

interface McpConfigFile {
  servers?: Record<string, McpServerConfig>;
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

export class McpToolDiscovery {
  #logger = Logger.getInstance();
  #declarations: McpToolDeclaration[] = [];

  /**
   * Scan project directory for MCP configuration files and extract tool declarations.
   *
   * Looks for:
   *   - .vscode/mcp.json
   *   - .cursor/mcp.json
   *
   * Each server config may contain a non-standard `tools` array with inline tool declarations.
   */
  discover(projectRoot: string): McpToolDeclaration[] {
    this.#declarations = [];
    const configPaths = [
      path.join(projectRoot, '.vscode', 'mcp.json'),
      path.join(projectRoot, '.cursor', 'mcp.json'),
    ];

    for (const configPath of configPaths) {
      if (!existsSync(configPath)) {
        continue;
      }

      try {
        const raw = readFileSync(configPath, 'utf8');
        const config = JSON.parse(raw) as McpConfigFile;
        const servers = config.servers ?? config.mcpServers ?? {};
        let loadedFromFile = 0;
        const serverCount = Object.keys(servers).length;

        for (const [serverId, serverConfig] of Object.entries(servers)) {
          if (!serverConfig?.tools || !Array.isArray(serverConfig.tools)) {
            continue;
          }

          for (const tool of serverConfig.tools) {
            if (!tool.name) {
              continue;
            }
            this.#declarations.push({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              serverId,
              serverSource: 'workspace-config',
            });
            loadedFromFile++;
          }
        }

        if (loadedFromFile > 0) {
          this.#logger.info(
            `[McpToolDiscovery] loaded ${loadedFromFile} MCP tool declarations from ${configPath}`
          );
        } else if (serverCount > 0) {
          this.#logger.debug(
            `[McpToolDiscovery] found ${serverCount} MCP server declarations without inline tool schemas from ${configPath}`
          );
        }
      } catch (err) {
        this.#logger.warn(
          `[McpToolDiscovery] failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return this.#declarations;
  }

  get declarations(): McpToolDeclaration[] {
    return [...this.#declarations];
  }
}
