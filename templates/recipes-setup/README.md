# AutoSnippet Recipe 格式说明

Recipe 是 AutoSnippet 知识库的核心载体：以「代码片段 + 使用说明 + 语义元数据」的形式存储，供 **检索（Search）**、**Guard（Lint）**、**代码生成（Generate）** 等能力使用。

---

## 存放位置

- 项目内：**AutoSnippet/recipes/**（或由 boxspec `knowledgeBase.dir` 指定的知识库目录下的 `recipes/`）。
- 建议按模块或功能划分子目录，便于管理与检索过滤。

---

## 知识三分类（kind）

V2 知识库中的 Recipe 按 `knowledgeType` 自动归入三类 kind，影响检索和展示：

| kind | knowledgeType 范围 | 说明 |
|------|-------------------|------|
| **rule** | `boundary-constraint` | Guard 规则，用于代码质量检查 |
| **pattern** | `code-pattern`, `architecture`, `best-practice`, `code-standard`, `code-style`, `solution` | 可复用代码模式 |
| **fact** | `code-relation`, `inheritance`, `call-chain`, `data-flow`, `module-dependency` | 结构性知识 |

---

## 文件格式（必读）

每个 `.md` 文件须包含 **三段**，系统方可直接解析入库（无需 AI 重写）：

1. **Frontmatter**：`---` 包裹的 YAML，**title**、**trigger** 必填；其余字段用于 AI 检索、多信号排序与知识关联。
2. **## Snippet / Code Reference**：下一行起用 Markdown 代码块写出可引用/可运行的代码片段。
3. **## AI Context / Usage Guide**：适用场景、何时不用、使用步骤、最佳实践等，供 AI 与人类阅读。

---

## Frontmatter 字段（与架构对齐）

### 必填字段（7 个）

| 字段 | 类型 | 说明 | 格式要求 |
|------|------|------|----------|
| `title` | string | 标题（英文名，单行） | ≤50 字，建议动词开头 |
| `trigger` | string | 触发词 | **MUST** 以 `@` 开头，小写+下划线，无空格 |
| `category` | string | **分类（MUST 为 8 个标准值之一）** | `View`, `Service`, `Tool`, `Model`, `Network`, `Storage`, `UI`, `Utility` |
| `language` | string | 编程语言 | `swift`、`objectivec`、`go`、`python`、`java`、`kotlin`、`javascript`、`typescript`、`dart`、`rust` |
| `summary_cn` | string | 中文概述 | ≤100 字 |
| `summary_en` | string | 英文概述 | ≤100 words |
| `headers` | array | **完整 import/include 语句** | Swift: `["import Foundation"]`；ObjC: `["#import <UIKit/UIKit.h>"]`；Go: `["import \"fmt\""]`；Python: `["import os"]`；Java: `["import java.util.List;"]`；JS/TS: `["import fs from 'node:fs'"]`；Dart: `["import 'package:flutter/material.dart'"]`；Rust: `["use std::collections::HashMap;"]` |

### 可选字段（强烈推荐）

| 字段 | 类型 | 说明 | AI 用途 |
|------|------|------|--------|
| `keywords` | array | 关键词列表 | BM25/关键词搜索 |
| `knowledgeType` | string | 知识维度 | `code-pattern`/`architecture`/`best-practice`/`boundary-constraint` 等 |
| `whenToUse` | string 或 array | 何时应使用此 Recipe | 场景匹配、意图理解 |
| `whenNotToUse` | string 或 array | 何时不应使用 | 负向过滤、避免误推荐 |
| `difficulty` | string | 难度：`beginner` / `intermediate` / `advanced` | 难度匹配 |
| `authority` | number | 权威分 1～5 | 多信号排序 |
| `relatedRecipes` | array | 关联 Recipe 的 trigger | 知识图谱、推荐 |
| `version` | string | 版本号 | 版本追踪 |
| `updatedAt` | number | 最后更新时间戳 | 新鲜度 |
| `author` | string | 作者或团队名 | 归属信息 |
| `deprecated` | boolean | 是否已过时 | 过滤过时内容 |

### 扩展字段（可选）

| 字段 | 类型 | 说明 |
|------|------|------|
| `tags` | array | 标签，如 `[production-ready, guard-rule]` |
| `deps` | object | 依赖：`targets`、`imports` 等 |
| `alternatives` | string 或 array | 替代方案说明或其它 Recipe 的 trigger |
| `quality` | object | 质量信号：如 `codeReviewStatus`、`hasUnitTest` |
| `performance` | object | 性能：如 `timeComplexity`、`spaceComplexity` |
| `security` | object | 安全：如 `riskLevel`、`bestPractices` |
| `deprecationReason` | string | 过时原因（配合 `deprecated: true` 使用） |
| `replacedBy` | string | 替代 Recipe 的 trigger |

---

## 正文：AI Context / Usage Guide 结构规范

为便于 AI 与人类一致理解，Usage Guide 应按照标准结构组织信息。

### 格式要求 (CRITICAL)

**⚠️ MUST DO:**
- **必须用 `###` 三级标题分段**，每个分段单独成行
- **必须用 `-` 或 `*` 建立列表**，每行一个要点
- **必须用换行分隔 section 和 item**，至少 2 行空行分开大分段
- **禁止将所有内容放在一行**（常见 AI 生成错误）

**❌ BAD Example:**
```
何时用：在需要…时；与…配合时；或直接拿…做…时。关键点：…内部会…；…支持…，…无需…；找不到…。
```

**✅ GOOD Example:**
```markdown
### 何时用

- App 启动或根窗口显示后需持续监测网络状态时
- 在应用生命周期管理类中统一启停

### 关键点

- 单例 sharedMonitor，线程安全
- startMonitoring 开始监测，stopMonitoring 停止

### 依赖

- BDNetworkMonitor（Foundation）
- SystemConfiguration
```

---

### 推荐的分段标题与内容

| 分段标题 | 内容 | 优先级 |
|---------|------|--------|
| **什么时候用** | 3～5 条适用场景与典型业务 | ⭐⭐⭐ 必填 |
| **何时不用** | 2～3 条排除场景（负向说明对检索很重要） | ⭐⭐ 推荐 |
| **使用步骤** | 简要步骤（1～3 步）或调用方式 | ⭐⭐ 推荐 |
| **关键点** | 易错点、线程/内存约束、版本限制 | ⭐⭐ 推荐 |
| **依赖与前置条件** | 模块/框架、权限、最低系统版本 | ⭐⭐ 推荐 |
| **错误处理** | 常见失败场景、重试/超时/降级策略 | ⭐⭐ 推荐 |
| **性能与资源** | 缓存、线程、内存、频率限制 | ⭐ 可选 |
| **安全与合规** | 鉴权、敏感信息、日志脱敏策略 | ⭐ 可选 |
| **常见误用** | 反例与规避方式（`❌ 不要…` / `✅ 应该…`） | ⭐ 可选 |
| **最佳实践** | 推荐做法、设计模式、配置建议 | ⭐ 可选 |
| **替代方案** | 与其它 Recipe 或方案的对比与选用建议 | ⭐ 可选 |
| **相关 Recipe** | 关联 trigger 或补充模式 | ⭐⭐ 推荐 |

### 格式与风格建议

- **标题**：使用 `###` 三级标题，每个分段独立清晰
- **列表**：用 `-` 或数字列表；避免过长段落
- **代码**：关键代码用反引号围绕或代码块
- **强调**：关键词用 `**粗体**`
- **对比**：使用 `❌ 错误做法` / `✅ 正确做法` 标记
- **链接**：相关 Recipe 用 `` `@trigger` `` 格式

---

## Recipe 生命周期

- **Draft**：编写、自测，可先不发布。
- **Review**：Guard/人工检查，更新权威分与质量信号。
- **Published**：进入知识库，参与检索与排序。
- **Maintenance**：根据使用反馈、依赖与最佳实践演进更新。
- **Deprecated**：标记过时并填写 `replacedBy`，保留供历史查询。

---

## MCP 工具（与 Recipe 相关）

| 工具 | 说明 |
|------|------|
| `autosnippet_search` | 统合搜索（mode=auto: BM25 + 语义融合，mode=context: 智能上下文检索） |
| `autosnippet_submit_knowledge` | 单条候选提交（严格前置校验，缺少必要字段直接拒绝不入库。必填: title, language, content(+rationale), kind, doClause, category, trigger, description, headers, usageGuide, knowledgeType） |
| `autosnippet_submit_knowledge_batch` | 批量候选提交 |
| `autosnippet_knowledge(operation=confirm_usage)` | 确认 Recipe 被采纳/应用 |
| `autosnippet_knowledge(operation=insights)` | 获取 Recipe 质量洞察（只读） |

---

## 参考文件

- **example.md**：包含扩展 frontmatter 与完整 Usage Guide 结构的标准示例。
- **_template.md**：空白模板，复制后改名、填空即可新建 Recipe。

---

## 延伸阅读

- `docs/使用文档.md` — 用户使用指南
- `docs/术语与Skills.md` — 术语定义与 Skills 说明
- `docs/MCP配置说明.md` — MCP 服务器配置
