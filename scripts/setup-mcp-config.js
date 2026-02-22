#!/usr/bin/env node

/**
 * VSCode/Cursor MCP 配置辅助脚本
 * 帮助用户快速配置 AutoSnippet MCP 集成
 *
 * 使用:
 *   node scripts/setup-mcp-config.js [--editor vscode|cursor] [--path /path/to/project]
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const args = require('minimist')(process.argv.slice(2));

// ============ 配置 ============

const editor = args.editor || args.e || 'vscode';
const projectPath = args.path || args.p || process.cwd();
const isVSCode = editor === 'vscode';
const isCursor = editor === 'cursor';
const isQuiet = process.env.ASD_QUIET === 'true';

// 检测是否在 AutoSnippet 仓库内执行
const isAutoSnippetRepo =
  fs.existsSync(path.join(projectPath, 'bin/mcp-server.js')) &&
  fs.existsSync(path.join(projectPath, 'bin/asd')) &&
  fs.existsSync(path.join(projectPath, 'package.json'));

if (isAutoSnippetRepo && !args.path) {
  if (!isQuiet) {
  }
  process.exit(0);
}

// ============ 检查环境 ============

// 检查 MCP Server
const mcpServerPath = path.join(projectPath, 'bin/mcp-server.js');
if (!fs.existsSync(mcpServerPath)) {
  if (!isQuiet) {
    console.error(`✗ MCP Server 未找到: ${mcpServerPath}`);
  }
  process.exit(1);
}

// ============ 编辑器配置 ============

if (isVSCode) {
  configureVSCode();
} else if (isCursor) {
  configureCursor();
} else {
  if (!isQuiet) {
    console.error('✗ 未知编辑器，使用 --editor vscode 或 --editor cursor');
  }
  process.exit(1);
}

function configureVSCode() {
  // 使用 .vscode/mcp.json（VSCode 新标准格式）
  const vscodeDir = path.join(projectPath, '.vscode');
  const mcpConfigPath = path.join(vscodeDir, 'mcp.json');

  // 读取现有配置
  let config = {};
  if (fs.existsSync(mcpConfigPath)) {
    try {
      const content = fs.readFileSync(mcpConfigPath, 'utf8');
      config = JSON.parse(content);
    } catch (_e) {
      // 忽略解析错误
    }
  }

  // 添加 MCP 服务器配置
  if (!config.servers) {
    config.servers = {};
  }

  config.servers.autosnippet = {
    type: 'stdio',
    command: 'node',
    args: [mcpServerPath],
    env: {
      ASD_UI_URL: 'http://localhost:3000',
    },
  };

  // 写入 .vscode/mcp.json
  try {
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2), 'utf8');
    if (!isQuiet) {
    }
  } catch (e) {
    if (!isQuiet) {
      console.error(`✗ 保存配置失败: ${e.message}`);
    }
    process.exit(1);
  }
}

function configureCursor() {
  const cursorConfigDir = path.join(projectPath, '.cursor');
  const cursorConfigPath = path.join(cursorConfigDir, 'mcp.json');

  // 创建配置
  const config = {
    mcpServers: {
      autosnippet: {
        command: 'node',
        args: [path.relative(projectPath, mcpServerPath) || './bin/mcp-server.js'],
        env: {
          ASD_UI_URL: 'http://localhost:3000',
        },
      },
    },
  };

  try {
    fs.mkdirSync(cursorConfigDir, { recursive: true });
    fs.writeFileSync(cursorConfigPath, JSON.stringify(config, null, 2), 'utf8');
    if (!isQuiet) {
    }
  } catch (e) {
    if (!isQuiet) {
      console.error(`✗ 保存配置失败: ${e.message}`);
    }
    process.exit(1);
  }
}
