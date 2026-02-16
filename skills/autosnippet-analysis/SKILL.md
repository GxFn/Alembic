---
name: autosnippet-analysis
description: Deep project analysis — full scan + semantic field enrichment + gap fill before Recipe creation. Both Cursor Agent and internal AI share the same capability set.
---

# AutoSnippet — Deep Project Analysis & Semantic Enrichment

> Self-check & Fallback: MCP 工具返回统一 JSON Envelope（{ success, errorCode?, message?, data?, meta }）。重操作前调用 autosnippet_health/autosnippet_capabilities；失败时不在同一轮重试，转用静态上下文或缩小范围后再试。

## Core Principle

**MCP 工具负责数据采集 + 静态检查；你（Agent）负责语义理解；`autosnippet_enrich_candidates` 负责 AI 补全缺失字段。**

---

## Capability 1: 全项目扫描 → 提交候选

> **首次接入项目？** 使用 **autosnippet-coldstart** Skill — 完整的 9 维度冷启动流程（含架构分析、项目特征、Agent 注意事项），比本 Skill 的扫描流程更全面。
> 本 Capability 适用于已有知识库后的**增量补充扫描**。

### When to Use
用户说："全项目扫描"、"分析我的项目"、"提取架构模式"、"生成知识库"。

### Workflow

#### Phase 1: Collect & Baseline
1. 调用 `autosnippet_scan_project` 获取文件列表 + Guard 审计基线
2. 审视 Guard 违规 — 静态规则问题 (命名/API 使用/废弃 API)
3. 确定高优先级文件 (核心模块/共享工具/Service 层)

#### Phase 2: Semantic Deep-Read
读取代码文件，逐维度分析：

| 分析维度 | 寻找什么 | knowledgeType | 对应字段 |
|---------|---------|---------------|---------|
| **架构模式** | 分层架构、MVVM/MVC、依赖注入 | `architecture` | rationale: 为什么选这种架构 |
| **代码模式** | 封装方式、公共 API 设计、工厂/单例 | `code-pattern` | steps: 如何采用该模式 |
| **代码规范** | 命名规范、文件组织、注释风格 | `code-standard` | constraints.preconditions: 前置条件 |
| **最佳实践** | 错误处理、并发、内存管理 | `best-practice` | rationale: 为什么这是最佳实践 |
| **调用链** | 关键业务的调用路径 | `call-chain` | steps: 调用顺序 |
| **数据流** | 状态管理、模块间数据传递 | `data-flow` | steps: 数据流向 |
| **模块依赖** | 依赖边界、约束 | `module-dependency` | constraints: 边界约束 |
| **Bug 修复** | 常见修复模式、defensive coding | `solution` | rationale: 为什么这样修 |

#### Phase 3: Submit with Full Semantic Fields
**每条候选必须填充以下语义字段**（不留空）：

```json
{
  "title": "网络层统一错误处理模式",
  "code": "<实际代码模式>",
  "language": "swift",
  "category": "Network",
  "knowledgeType": "code-pattern",
  "complexity": "intermediate",
  "scope": "project-specific",
  "rationale": "统一错误处理避免分散的 try-catch，便于日志收集和错误上报",
  "steps": [
    { "title": "创建 Error 枚举", "description": "在 Network/ 下创建 NetworkError.swift", "code": "enum NetworkError: Error { ... }" },
    { "title": "封装请求方法", "description": "所有请求统一通过 APIClient.request()", "code": "" }
  ],
  "constraints": {
    "preconditions": ["iOS 15+", "需引入 Combine framework"],
    "boundaries": ["不可用于 WebSocket 连接"],
    "sideEffects": []
  },
  "tags": ["networking", "error-handling"],
  "reasoning": {
    "whyStandard": "项目中 15 个网络模块均采用此模式",
    "sources": ["Sources/Network/APIClient.swift", "Sources/Network/ErrorHandler.swift"],
    "confidence": 0.9
  }
}
```

Use `autosnippet_submit_knowledge_batch` for batch submission.

#### Phase 4: Guard Deep Audit (Optional)
对特定文件调用 `autosnippet_guard_audit_files` 做深度规范审计。

---

## Capability 2: 语义字段补全（需要 AI 理解的字段）

### When to Use
- 候选已有 title/code/language 但缺少深度语义字段
- 候选要晋升为 Recipe 前，需要补全
- 用户说："补全候选字段"、"enrich"、"查漏补缺"

### 需要语义理解的 6 个字段

| 字段 | 为什么需要 AI | 示例 |
|------|-------------|------|
| **rationale** | 需理解设计意图，回答"为什么这样做" | "该模式使用 Builder 而非直接构造，因为参数超过 5 个且多数可选" |
| **knowledgeType** | 需理解知识本质（规范/模式/事实） | `architecture` vs `code-pattern` vs `best-practice` |
| **complexity** | 需评估使用难度 | `beginner`（一行调用）vs `advanced`（需理解泛型+协议组合） |
| **scope** | 需判断适用范围 | `universal`（通用 Singleton）vs `project-specific`（依赖项目 Config） |
| **steps** | 需拆解实施步骤 | `[{title: "创建协议", description: "...", code: "..."}]` |
| **constraints.preconditions** | 需理解前置条件 | `["iOS 15+", "需先配置 Firebase", "依赖 NetworkModule"]` |

### Workflow for Enrichment

**方式 A: 你（Agent）直接补全**
在分析代码时，直接填写所有 6 个语义字段到 `autosnippet_submit_knowledge` 调用中。

**方式 B: 对已有候选调用 AI 补全**
```
autosnippet_enrich_candidates({ candidateIds: ["id1", "id2", ...] })
```
AI 会分析每条候选的代码，自动填充缺失字段（已有字段不会被覆盖）。

**方式 C: Bootstrap 候选 AI 润色**
```
autosnippet_bootstrap_refine({ candidateIds: ["id1", "id2", ...] })
```
使用 AI 对 Bootstrap 候选做内容润色（改善 summary、补充 insight、推断 relations、调整 confidence）。
必须在 `autosnippet_enrich_candidates` 之后调用（确保字段完整后再润色）。

---

## Capability 3: 候选 → Recipe 查漏补缺

### When to Use
- 用户准备将候选发布为 Recipe
- 用户说："准备发布"、"候选检查"、"Recipe 就绪检查"

### Workflow

1. 调用 `autosnippet_enrich_candidates` 对目标候选做结构补齐（诊断缺失字段）
2. 调用 `autosnippet_bootstrap_refine` 对候选做 AI 润色（summary/insight/relations）
3. 调用 `autosnippet_validate_candidate` 检查结构完整性
4. 调用 `autosnippet_check_duplicate` 检查重复
5. 报告补全情况 + 缺失字段 + 重复风险
6. 如缺失字段 AI 无法填充，提示用户手动补充

### Recipe 必备字段检查清单

| 字段 | 重要性 | AI 可填? |
|------|-------|---------|
| title | ★★★ 必填 | ✅ |
| code | ★★★ 必填 | ✅ |
| language | ★★★ 必填 | ✅ |
| rationale | ★★★ 强烈推荐 | ✅ |
| knowledgeType | ★★★ 强烈推荐 | ✅ |
| complexity | ★★☆ 推荐 | ✅ |
| scope | ★★☆ 推荐 | ✅ |
| steps | ★★☆ 推荐 | ✅ |
| constraints.preconditions | ★★☆ 推荐 | ✅ |
| summary / description | ★★★ 强烈推荐 | ✅ |
| usageGuide | ★★☆ 推荐 | ⚠️ 需人工审核 |
| reasoning | ★★★ 必填 | Agent 必须自己填 |

---

## Related Skills

- **autosnippet-candidates**: 完整候选字段模型 + 提交指南
- **autosnippet-structure**: 项目结构发现 (targets / files / dependencies)
- **autosnippet-guard**: Guard 触发机制 (`// as:audit`)
- **autosnippet-recipes**: Recipe 内容与查询
