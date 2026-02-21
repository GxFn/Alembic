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
import os from 'node:os';
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

let settingsPath; // 全局声明，供后面使用

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
  // 找到 settings.json 路径
  if (os.platform() === 'darwin') {
    settingsPath = path.join(os.homedir(), 'Library/Application Support/Code/User/settings.json');
  } else if (os.platform() === 'win32') {
    settingsPath = path.join(os.getenv('APPDATA'), 'Code/User/settings.json');
  } else {
    settingsPath = path.join(os.homedir(), '.config/Code/User/settings.json');
  }

  // 读取现有设置
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf8');
      settings = JSON.parse(content);
    } catch (_e) {
      // 忽略解析错误
    }
  }

  // 添加 MCP 配置
  if (!settings['github.copilot.mcp']) {
    settings['github.copilot.mcp'] = {};
  }
  if (!settings['github.copilot.mcp'].servers) {
    settings['github.copilot.mcp'].servers = [];
  }

  // 检查 autosnippet 是否已存在
  const existingIndex = settings['github.copilot.mcp'].servers.findIndex(
    (s) => s.name === 'autosnippet'
  );

  const mcpConfig = {
    name: 'autosnippet',
    command: 'node',
    args: [mcpServerPath],
    env: {
      ASD_UI_URL: 'http://localhost:3000',
    },
  };

  if (existingIndex >= 0) {
    settings['github.copilot.mcp'].servers[existingIndex] = mcpConfig;
  } else {
    settings['github.copilot.mcp'].servers.push(mcpConfig);
  }

  // 写入设置
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    if (!isQuiet) {
    }
  } catch (e) {
    if (!isQuiet) {
      console.error(`✗ 保存设置失败: ${e.message}`);
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
