#!/usr/bin/env node

/**
 * AutoSnippet VSCode Copilot 安装脚本
 *
 * 功能：
 * 1. 自动配置 VSCode 全局和工作区 settings.json
 * 2. 创建推荐扩展配置 (.vscode/extensions.json)
 * 3. 生成或更新项目指令 (.github/copilot-instructions.md)
 * 4. 验证 MCP 服务器连接
 * 5. 提供快速启动指导
 *
 * 使用:
 *   node scripts/install-vscode-copilot.js [--path /path/to/project] [--global|--workspace]
 *   npm run install:vscode-copilot
 *
 * 选项:
 *   --path <path>      指定项目根目录（默认为 cwd）
 *   --global           仅配置全局 settings.json（~/.config/Code/User/settings.json）
 *   --workspace        仅配置工作区 settings.json（.vscode/settings.json）
 *   --skip-verify      跳过验证步骤
 *   --quiet            安静模式（无输出）
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const args = require('minimist')(process.argv.slice(2));
const projectPath = args.path || args.p || process.cwd();

// 检测是否在 AutoSnippet 仓库内执行
const isAutoSnippetRepo =
  fs.existsSync(path.join(projectPath, 'bin/mcp-server.js')) &&
  fs.existsSync(path.join(projectPath, 'bin/asd')) &&
  fs.existsSync(path.join(projectPath, 'package.json'));

// 默认只做工作区配置，不做全局配置
// 如果在 AutoSnippet 仓库内执行且未明确指定 --path，跳过所有配置
const configWorkspace = !args.global && !isAutoSnippetRepo && (args.path || !isAutoSnippetRepo);
const skipVerify = args['skip-verify'];
const isQuiet = args.quiet || process.env.ASD_QUIET === 'true';

// ============ 颜色定义 ============
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
};

function log(msg, color = 'reset') {
  if (!isQuiet) {
  }
}

function error(msg) {
  console.error(colors.red + msg + colors.reset);
}

// ============ 助手函数 ============

function readJsonFile(filePath, defaultValue: any = {}) {
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (e: any) {
    log(`⚠️  无法解析 ${filePath}: ${e.message}`, 'yellow');
    return defaultValue;
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return true;
  } catch (e: any) {
    error(`✗ 无法写入 ${filePath}: ${e.message}`);
    return false;
  }
}

// ============ 获取 MCP 服务器路径 ============

function getMcpServerPath() {
  const scriptPath = path.join(projectPath, 'bin/mcp-server.js');
  if (!fs.existsSync(scriptPath)) {
    error(`✗ MCP Server 不存在: ${scriptPath}`);
    error(`  请确保在 AutoSnippet 项目目录下运行此脚本`);
    process.exit(1);
  }
  return scriptPath;
}

// ============ 配置 VSCode settings.json ============

function configureVSCodeSettings() {
  log('\n📝 配置 VSCode MCP 设置...', 'blue');

  if (isAutoSnippetRepo && !args.path) {
    log('ℹ️  检测到在 AutoSnippet 仓库内执行，仅配置全局设置', 'yellow');
    log('   如需为其他项目配置，请使用: --path /path/to/project', 'yellow');
  }

  const mcpServerPath = getMcpServerPath();
  const mcpServerConfig = {
    type: 'stdio',
    command: 'node',
    args: [mcpServerPath],
    env: {
      ASD_UI_URL: 'http://localhost:3000',
    },
  };

  let configured = false;

  // 工作区配置 → .vscode/mcp.json（新标准格式）
  if (configWorkspace) {
    const vscodeDir = path.join(projectPath, '.vscode');
    const mcpConfigPath = path.join(vscodeDir, 'mcp.json');

    let config: any = {};
    if (fs.existsSync(mcpConfigPath)) {
      try {
        config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
      } catch {
        /* ignore */
      }
    }

    if (!config.servers) {
      config.servers = {};
    }
    config.servers.autosnippet = mcpServerConfig;

    if (writeJsonFile(mcpConfigPath, config)) {
      log(`✅ 工作区 MCP 配置完成: ${mcpConfigPath}`, 'green');
      configured = true;
    }
  }

  return configured;
}

// ============ 创建推荐扩展配置 ============

function createExtensionsJson() {
  log('\n📦 创建推荐扩展配置...', 'blue');

  const extensionsPath = path.join(projectPath, '.vscode/extensions.json');
  const extensions = {
    recommendations: ['GitHub.copilot', 'GitHub.copilot-chat'],
    unwantedRecommendations: [],
  };

  if (writeJsonFile(extensionsPath, extensions)) {
    log(`✅ 扩展推荐配置完成: ${extensionsPath}`, 'green');
    return true;
  }
  return false;
}

// ============ 生成项目指令 ============

function createCopilotInstructions() {
  log('\n📖 生成项目指令 (.github/copilot-instructions.md)...', 'blue');

  const instructionsPath = path.join(projectPath, '.github/copilot-instructions.md');

  // 检查是否已存在
  if (fs.existsSync(instructionsPath)) {
    log(`✓ 项目指令已存在，跳过创建`, 'yellow');
    return true;
  }

  // 从模板文件读取内容
  const templatePath = path.join(__dirname, '..', 'templates', 'copilot-instructions.md');
  if (!fs.existsSync(templatePath)) {
    error(`✗ 模板文件不存在: ${templatePath}`);
    return false;
  }

  const instructions = fs.readFileSync(templatePath, 'utf8');

  try {
    fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
    fs.writeFileSync(instructionsPath, instructions, 'utf8');
    log(`✅ 项目指令生成完成: ${instructionsPath}`, 'green');
    return true;
  } catch (e: any) {
    error(`✗ 生成项目指令失败: ${e.message}`);
    return false;
  }
}

// ============ 验证配置 ============

function verifyConfiguration() {
  if (skipVerify) {
    return;
  }

  log('\n🔍 验证配置...', 'blue');

  // 检查工作区 MCP 配置（.vscode/mcp.json）
  if (configWorkspace) {
    const mcpConfigPath = path.join(projectPath, '.vscode/mcp.json');
    if (fs.existsSync(mcpConfigPath)) {
      const config = readJsonFile(mcpConfigPath, {});
      if (config.servers?.autosnippet) {
        log(`✅ VSCode 工作区 MCP 配置验证成功 (.vscode/mcp.json)`, 'green');
      } else {
        log(`⚠️  .vscode/mcp.json 中未找到 autosnippet 服务器`, 'yellow');
      }
    } else {
      log(`⚠️  未找到 .vscode/mcp.json`, 'yellow');
    }
  }

  // 检查推荐扩展
  const extensionsPath = path.join(projectPath, '.vscode/extensions.json');
  if (fs.existsSync(extensionsPath)) {
    log(`✅ 推荐扩展配置存在`, 'green');
  }

  // 检查项目指令
  const instructionsPath = path.join(projectPath, '.github/copilot-instructions.md');
  if (fs.existsSync(instructionsPath)) {
    log(`✅ 项目指令存在`, 'green');
  }
}

// ============ 提供快速启动指导 ============

function printQuickStart() {
  log(`\n${'='.repeat(60)}`, 'blue');
  log('🎉 VSCode Copilot 配置完成！', 'green');
  log('='.repeat(60), 'blue');

  log('\n⚡ 3 步快速启动：\n', 'blue');

  log('1️⃣  启动 Dashboard');
  log('   $ asd ui', 'yellow');
  log('   确认输出: ✓ Server running on http://localhost:3000\n');

  log('2️⃣  重启 VSCode');
  log('   $ code -r\n');

  log('3️⃣  在 VSCode Copilot Chat 中测试');
  log('   ⌘+⇧+I 打开 Copilot Chat');
  log('   输入: @autosnippet search async', 'yellow');
  log('   预期: 返回 async/await 代码片段\n');

  log('📚 可用命令：\n', 'blue');
  log('   @autosnippet search <关键词>      # 代码搜索');
  log('   @autosnippet recipes list          # 查看 Recipe');
  log('   @autosnippet create                # 创建 Recipe');
  log('   @autosnippet guard                 # 代码审查');
  log('   @autosnippet when <场景>           # 决策辅助\n');

  log('📖 项目指令位置：');
  log(`   ${path.join(projectPath, '.github/copilot-instructions.md')}`, 'yellow');

  log('\n📝 配置位置：');
  if (configWorkspace) {
    log(`   MCP: ${path.join(projectPath, '.vscode/mcp.json')}`, 'yellow');
  }

  log('\n💡 提示：');
  log('   - 首次配置需要重启 VSCode');
  log('   - MCP 服务器需要 Node.js 18.0+');
  log('   - Dashboard 运行在 http://localhost:3000');
  log('   - MCP 配置位于 .vscode/mcp.json（可加入版本控制共享给团队）\n');

  log(`${'='.repeat(60)}\n`, 'blue');
}

// ============ 主程序 ============

async function main() {
  log('\n🚀 AutoSnippet VSCode Copilot 安装程序', 'blue');
  log(`📍 项目路径: ${projectPath}\n`, 'blue');

  const results = {
    settings: false,
    extensions: false,
    instructions: false,
  };

  // 配置 settings.json
  results.settings = configureVSCodeSettings();

  // 创建推荐扩展配置
  results.extensions = createExtensionsJson();

  // 生成项目指令
  results.instructions = createCopilotInstructions();

  // 验证配置
  verifyConfiguration();

  // 提供快速启动指导
  printQuickStart();

  // 返回状态
  const allSuccess = Object.values(results).every((v) => v);
  if (allSuccess) {
    log('✅ 所有配置完成！', 'green');
    process.exit(0);
  } else {
    log('⚠️  部分配置可能未完成，请检查上述消息', 'yellow');
    process.exit(1);
  }
}

// 运行
main().catch((err) => {
  error(`✗ 配置失败: ${err.message}`);
  process.exit(1);
});
