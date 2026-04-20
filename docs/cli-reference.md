# CLI 命令参考

Alembic 的命令行工具名为 `alembic`，基于 [commander](https://github.com/tj/commander.js) 构建。

```bash
npm install -g alembic-ai
alembic --help
```

---

## 命令一览

| 命令 | 描述 |
|------|------|
| [`alembic setup`](#alembic-setup) | 初始化项目工作空间 |
| [`alembic coldstart`](#alembic-coldstart) | 冷启动知识库 |
| [`alembic ais`](#alembic-ais-target) | AI 扫描目标模块 |
| [`alembic search`](#alembic-search-query) | 搜索知识库 |
| [`alembic guard`](#alembic-guard-file) | Guard 规则检查 |
| [`alembic guard:ci`](#alembic-guardci-path) | CI 模式 Guard 检查 |
| [`alembic guard:staged`](#alembic-guardstaged) | Pre-commit Guard 检查 |
| [`alembic watch`](#alembic-watch) | 文件监控 |
| [`alembic server`](#alembic-server) | 启动 API 服务器 |
| [`alembic ui`](#alembic-ui) | 启动 Dashboard |
| [`alembic status`](#alembic-status) | 环境状态检查 |
| [`alembic upgrade`](#alembic-upgrade) | 升级 IDE 集成 |
| [`alembic cursor-rules`](#alembic-cursor-rules) | 生成 Cursor 交付物料 |
| [`alembic task`](#alembic-task) | 任务管理（TaskGraph） |
| [`alembic sync`](#alembic-sync) | 同步 Markdown ↔ DB |

---

## alembic setup

初始化项目工作空间。创建目录结构、SQLite 数据库、IDE 集成配置（Cursor / VS Code / Trae / Qoder MCP 配置）、模板文件。

```bash
alembic setup [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-d, --dir <path>` | `.` | 项目根目录 |
| `--force` | `false` | 强制重新初始化（覆盖已有配置） |
| `--seed` | `false` | 注入种子 Recipes（快速入门示例） |

**创建的目录结构：**

```
your-project/
├── Alembic/
│   ├── recipes/         # 已批准的知识条目 (Markdown)
│   ├── candidates/      # 待审核的候选条目
│   └── skills/          # 项目级 Agent 指令
├── .asd/
│   ├── alembic.db   # SQLite 数据库
│   └── context/         # 向量索引
├── .cursor/mcp.json     # Cursor MCP 配置
├── .vscode/mcp.json     # VS Code MCP 配置
└── .env                 # AI Provider 配置 (如不存在则创建模板)
```

---

## alembic coldstart

冷启动知识库。对项目源码进行多维度分析，通过 AI 提取代码模式，生成 Candidate 草稿供审核。

```bash
alembic coldstart [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-d, --dir <path>` | `.` | 项目根目录 |
| `-m, --max-files <n>` | `500` | 最大扫描文件数 |
| `--skip-guard` | `false` | 跳过 Guard 规则生成 |
| `--no-skills` | `false` | 不生成 Project Skills |
| `--wait` | `false` | 等待所有异步任务完成后退出 |
| `--json` | `false` | JSON 格式输出 |

**分析维度（14 个，按项目语言自动激活）：**

通用维度（所有项目适用）：
1. 代码规范（code-standard）
2. 设计模式与代码惯例（code-pattern）
3. 架构模式（architecture）
4. 最佳实践（best-practice）
5. 事件与数据流（event-and-data-flow）
6. 项目特征（project-profile）
7. Agent 开发注意事项（agent-guidelines）

条件维度（按语言/框架激活）：
8. ObjC/Swift 深度扫描（objc-deep-scan）
9. ObjC/Swift 基础类分类方法（category-scan）
10. JS/TS 模块导出分析（module-export-scan）
11. JS/TS 框架约定（framework-convention-scan）
12. Python 包结构（python-package-scan）
13. Java/Kotlin 注解扫描（jvm-annotation-scan）
14. Go 模块结构（go-module-scan）

---

## alembic ais [target]

AI 扫描指定目标（模块/目录/文件），提取代码模式并生成 Recipes。

```bash
alembic ais [target] [options]
```

**参数：**

| 参数 | 说明 |
|------|------|
| `target` | 目标路径（模块目录或文件），省略则交互式选择 |

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-d, --dir <path>` | `.` | 项目根目录 |
| `-m, --max-files <n>` | `200` | 最大扫描文件数 |
| `--dry-run` | `false` | 仅分析不创建 Candidate |
| `--json` | `false` | JSON 格式输出 |

---

## alembic search \<query\>

搜索知识库中的 Recipes 和知识条目。

```bash
alembic search <query> [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-t, --type <type>` | `all` | 搜索类型：`all` / `recipe` / `solution` / `rule` |
| `-m, --mode <mode>` | `auto` | 搜索模式：`keyword` / `weighted` / `semantic` |
| `-l, --limit <n>` | `10` | 返回结果数量 |

**搜索模式说明：**

| 模式 | 原理 | 适用场景 |
|------|------|---------|
| `keyword` | 精确关键词匹配 | 已知确切术语 |
| `weighted` | 加权字段评分 | 常规文本搜索 |
| `semantic` | 向量语义相似度 | 模糊/概念性查询 |

---

## alembic guard \<file\>

对文件运行 Guard 规则检查。

```bash
alembic guard <file> [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-s, --scope <scope>` | `file` | 检查范围：`file` / `target` / `project` |
| `--json` | `false` | JSON 格式输出 |

---

## alembic guard:ci [path]

CI/CD 模式的全项目 Guard 检查，适合集成到持续集成管线。

```bash
alembic guard:ci [path] [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--fail-on-error` | `true` | 有 error 级别违规时退出码非零 |
| `--fail-on-warning` | `false` | 有 warning 级别违规时退出码非零 |
| `--max-warnings <n>` | `20` | 最大允许 warning 数量 |
| `--report <format>` | `text` | 报告格式：`json` / `text` / `markdown` |
| `--output <file>` | — | 报告输出文件路径 |
| `--min-score <n>` | `70` | 最低合规分数（0-100） |
| `--max-files <n>` | `500` | 最大检查文件数 |

**退出码：**

| 码 | 含义 |
|----|------|
| `0` | 通过 |
| `1` | 存在违规超过阈值 |

---

## alembic guard:staged

检查 git staged 文件，适合作为 pre-commit hook。

```bash
alembic guard:staged [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--fail-on-error` | `true` | 有 error 级别违规时阻止提交 |
| `--json` | `false` | JSON 格式输出 |

**配合 pre-commit：**

```bash
# .git/hooks/pre-commit
#!/bin/sh
alembic guard:staged --fail-on-error
```

或使用安装模板：`templates/pre-commit-guard.sh`

---

## alembic watch

启动文件监控模式。自动检测文件变更，执行 Guard 规则检查和指令处理。

```bash
alembic watch [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-d, --dir <path>` | `.` | 项目根目录 |
| `-e, --ext <exts>` | — | 监控的文件扩展名（逗号分隔） |
| `--guard` | `true` | 是否启用 Guard 实时检查 |

**检测的文件指令：**

| 指令 | 作用 |
|------|------|
| `// as:s <query>` | 搜索知识库并插入匹配的 Recipe |
| `// as:c` | 从周围代码创建 Candidate |
| `// as:a` | 对当前文件运行 Guard 审计 |

---

## alembic server

启动 HTTP API 服务器（不含 Dashboard 前端）。

```bash
alembic server [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-p, --port <port>` | `3000` | 监听端口 |
| `-H, --host <host>` | `127.0.0.1` | 监听地址 |

---

## alembic ui

启动 Dashboard UI，同时包含 API 服务器和前端页面。

```bash
alembic ui [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-p, --port <port>` | `3000` | 监听端口 |
| `-b, --browser` | — | 指定浏览器打开 |
| `--no-open` | `false` | 不自动打开浏览器 |
| `-d, --dir <directory>` | `.` | 项目根目录 |
| `--api-only` | `false` | 仅启动 API，不启动前端 |

---

## alembic status

检查当前环境状态，包括 AI 配置、数据库连接、依赖项等。

```bash
alembic status
```

输出包含：
- AI Provider 状态（已配置/可用模型）
- 数据库连接状态
- 知识库统计（Recipes / Candidates 数量）
- IDE 集成状态

---

## alembic upgrade

升级 IDE 集成配置。更新 MCP 配置、Skills、Cursor Rules、Copilot Instructions 到最新版本。

```bash
alembic upgrade [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-d, --dir <path>` | `.` | 项目根目录 |
| `--skills-only` | `false` | 仅更新 Skills |
| `--mcp-only` | `false` | 仅更新 MCP 配置 |

---

## alembic cursor-rules

生成 Cursor 4 通道交付物料（Rules 文件、Skills 定义、Token 预算规划、主题分类）。

```bash
alembic cursor-rules [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-d, --dir <path>` | `.` | 项目根目录 |
| `--verbose` | `false` | 详细输出 |

---

## alembic task

任务图（TaskGraph）管理。查看任务状态、统计信息、任务列表。

```bash
alembic task <subcommand> [options]
```

**子命令：**

| 子命令 | 说明 |
|--------|------|
| `stats` | 显示任务统计（总数、状态分布、优先级） |
| `list` | 列出任务（支持 `--status` 过滤） |
| `show <id>` | 查看任务详情 |

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-d, --dir <path>` | `.` | 项目根目录 |
| `--status <status>` | 全部 | 状态过滤：`open` / `in_progress` / `closed` / `deferred` |
| `--json` | `false` | JSON 格式输出 |

---

## alembic sync

增量同步 `Alembic/recipes/*.md` 和 `Alembic/candidates/*.md` 到 SQLite 数据库。

```bash
alembic sync [options]
```

**选项：**

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-d, --dir <path>` | `.` | 项目根目录 |
| `--dry-run` | `false` | 仅检查不执行同步 |
| `--force` | `false` | 强制全量同步（忽略增量检测） |

**使用场景：**

- 手动编辑了 Recipe Markdown 文件后同步到 DB
- 数据库损坏后重建
- 从 Git 拉取新的 Recipe 文件后同步

---

## 环境变量

CLI 命令从项目根目录的 `.env` 文件读取环境变量：

```env
# AI Provider (至少配置一个，多个同时存在时自动 fallback)
ALEMBIC_GOOGLE_API_KEY=...
ALEMBIC_OPENAI_API_KEY=...
ALEMBIC_CLAUDE_API_KEY=...
ALEMBIC_DEEPSEEK_API_KEY=...

# 本地模型
ALEMBIC_AI_PROVIDER=ollama
ALEMBIC_AI_MODEL=llama3

# 服务器
ALEMBIC_PORT=3000
ALEMBIC_HOST=127.0.0.1
```

---

## npm scripts

开发者可通过 npm scripts 调用 CLI：

```bash
npm run cli -- <command>        # 等同于 alembic <command>
npm run dashboard               # 等同于 alembic ui
npm run mcp                     # 启动 MCP 服务器
npm run dev:link                # 全局链接开发版本
npm run dev:verify              # 验证全局安装
npm run test                    # 运行测试
npm run test:unit               # 仅单元测试
npm run test:integration        # 仅集成测试
npm run test:coverage           # 带覆盖率的测试
```
