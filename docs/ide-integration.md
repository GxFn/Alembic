# IDE 集成

AutoSnippet 支持多种 IDE 的深度集成。核心协议是 MCP（Model Context Protocol），附加 VS Code 扩展和 Xcode 自动化。

---

## 支持的 IDE

| IDE | 集成方式 | 配置文件 |
|-----|---------|---------|
| **Cursor** | MCP Server + Cursor Rules + Agent Skills | `.cursor/mcp.json` + `.cursor/rules/` |
| **VS Code (Copilot)** | MCP Server + Copilot Instructions + Extension | `.vscode/mcp.json` + `.github/copilot-instructions.md` |
| **Trae** | MCP Server | MCP 配置 |
| **Qoder** | MCP Server | MCP 配置 |
| **Claude Code** | MCP Server | MCP 配置 |
| **Xcode** | File Watcher + Snippet Sync | `asd watch` |

---

## 一键安装

```bash
asd setup          # 自动检测已安装的 IDE，配置 MCP
asd upgrade        # 更新到最新版本的 IDE 配置
```

`SetupService` 自动探测 IDE 安装路径：
- **macOS**: `/Applications/`、`~/Applications/`
- **Linux**: `/usr/share/code/`、`/usr/bin/`、`~/.local/bin/`
- **Windows**: `%LOCALAPPDATA%\Programs\*`

---

## Cursor 集成

### MCP 配置

`asd setup` 自动生成 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "autosnippet": {
      "command": "node",
      "args": ["/usr/local/lib/node_modules/autosnippet/bin/mcp-server.js"],
      "env": {
        "ASD_PROJECT_ROOT": "/path/to/your-project"
      }
    }
  }
}
```

### Cursor Rules

`asd cursor-rules` 生成 4 通道交付物料：

1. **Rules 文件** — `.cursor/rules/` 下的规则文件，包含 Recipe 摘要
2. **Agent Skills** — 项目级 Skill 定义，指导 AI 行为
3. **Token 预算** — 按场景分配 token（systemPrompt / history / recipes / userInput / buffer）
4. **主题分类** — 自动将 Recipes 按主题聚类

### Skills 安装

```bash
npm run install:cursor-skill           # 安装 Skills
npm run install:cursor-skill:mcp       # 安装 Skills（MCP 模式）
```

Skills 目录结构：

```
skills/
├── autosnippet-create/       # 知识创建与提交
├── autosnippet-guard/        # Guard 规则审计
├── autosnippet-recipes/      # Recipe 上下文检索
├── autosnippet-structure/    # 结构探查与知识图谱
├── autosnippet-devdocs/      # 开发文档保存
└── [project-level skills]    # 项目级自定义 Skill
```

---

## VS Code (Copilot) 集成

### MCP 配置

`asd setup` 自动生成 `.vscode/mcp.json`：

```json
{
  "servers": {
    "autosnippet": {
      "command": "node",
      "args": ["/usr/local/lib/node_modules/autosnippet/bin/mcp-server.js"],
      "env": {
        "ASD_PROJECT_ROOT": "/path/to/your-project"
      }
    }
  }
}
```

### Copilot Instructions

`asd setup` 和 `asd upgrade` 自动生成 `.github/copilot-instructions.md`，内容包括：

- 项目概览
- 知识库结构说明
- 知识三分类（rule / pattern / fact）
- 6 条强制规则
- 12 个 MCP 工具速查表
- Recipe 结构要点
- 推荐工作流

安装命令：

```bash
npm run install:vscode-copilot     # 生成 Copilot Instructions
```

### VS Code 扩展

`resources/vscode-ext/` 包含 VS Code 扩展源码，提供：

| 功能 | 说明 |
|------|------|
| **状态栏** | 显示 AutoSnippet 连接状态和知识库统计 |
| **CodeLens** | 代码行上方显示匹配的 Recipe |
| **指令检测** | 保存时自动检测 `as:s` / `as:c` / `as:a` 指令 |
| **搜索面板** | 快速搜索知识库 |
| **Guard on Save** | 保存时自动运行 Guard 检查 |

**项目作用域**：扩展仅在工作区包含 AutoSnippet 项目时激活（检测 `AutoSnippet/` 或 `.autosnippet/` 目录）。

---

## Xcode 集成

### File Watcher

```bash
asd watch -d /path/to/ios-project --ext swift,m,h
```

监控 Swift / ObjC 文件变更，自动：
- 检测文件指令（`// as:s` / `// as:c` / `// as:a`）
- 运行 Guard 规则检查
- 同步代码片段到 Xcode Snippets Library

### Snippet 同步

从 Recipes 生成 Xcode 代码片段：

```
macOS: ~/Library/Developer/Xcode/UserData/CodeSnippets/
```

`SnippetFactory` 通过 `XcodeCodec` 生成 `.codesnippet` 格式文件，包含：
- 补全前缀
- 占位符（`<#placeholder#>` 格式）
- 作用域（类方法 / 函数体 / 顶层）
- 语言标记

### SPM 集成

`SpmService` 和 `ModuleService` 支持 Swift Package Manager 项目结构分析：
- Package.swift 解析
- Target / 依赖关系图
- 模块边界检测

---

## 文件指令

在任何源文件中写入指令，IDE 扩展或 `asd watch` 自动处理：

### as:s — 搜索并插入

```javascript
// as:s network timeout handling
```

搜索知识库的 "network timeout handling" 相关 Recipe，将最佳匹配的代码片段插入到指令下方。

### as:c — 创建候选

```javascript
// as:c
function retryWithBackoff(fn, maxRetries = 3) {
  // ... 有价值的代码模式
}
```

将指令下方的代码块提取为 Candidate 草稿，等待审核。

### as:a — Guard 审计

```javascript
// as:a
```

对当前文件运行 Guard 规则检查，结果显示在 IDE 中。

---

## MCP 诊断

如果 IDE 无法连接 MCP 服务器：

```bash
# 诊断 MCP 连接
npm run diagnose:mcp

# 手动测试 MCP 服务器
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node bin/mcp-server.js
```

常见问题：

| 问题 | 解决方案 |
|------|---------|
| MCP 服务器启动失败 | 检查 Node.js ≥ 22，运行 `asd status` |
| 找不到 mcp-server.js | 运行 `npm install -g autosnippet` 重新安装 |
| 权限错误 | 检查 `.env` 中的 API Key 配置 |
| IDE 未检测到工具 | 重启 IDE，检查 MCP 配置文件路径 |
| 知识库为空 | 运行 `asd coldstart` 生成初始知识 |

---

## 全量安装

一次性安装所有 IDE 集成：

```bash
npm run install:full
```

等同于：
1. `setup-mcp-config.js --editor vscode`
2. `setup-mcp-config.js --editor cursor`
3. `install-cursor-skill.js`
4. `install-vscode-copilot.js`

---

## 升级

```bash
# 更新 npm 包
npm update -g autosnippet

# 更新 IDE 配置
asd upgrade

# 仅更新 Skills
asd upgrade --skills-only

# 仅更新 MCP 配置
asd upgrade --mcp-only
```
