---
# 必填字段
title: Your Recipe Title Here (English, ≤50 chars, verb-based)
trigger: @my_trigger
category: Network  # MUST be one of: View, Service, Tool, Model, Network, Storage, UI, Utility
language: swift  # swift, objectivec, go, python, java, kotlin, javascript, typescript, dart, rust
summary_cn: 中文概述，≤100 字，描述该 Recipe 的用途
summary_en: English summary, ≤100 words
headers: ["import Foundation"]  # 完整 import 语句数组

# 可选字段（强烈推荐）
knowledgeType: code-pattern  # code-pattern, architecture, best-practice, boundary-constraint, code-relation, etc.
keywords: ["关键词1", "关键词2", "关键词3"]
tags: [tag1, tag2]
whenToUse: |
  - 适用场景 1
  - 适用场景 2
  - 适用场景 3
whenNotToUse: |
  - 不应使用的场景 1
  - 不应使用的场景 2
difficulty: beginner  # beginner, intermediate, advanced
authority: 1  # 1~5
relatedRecipes: ["@相关Recipe的trigger"]
version: "1.0.0"
updatedAt: 1706515200
author: team_name
deprecated: false
---

## Snippet / Code Reference

```
// 在此粘贴或编写代码片段（建议可运行、含必要错误处理与注释）
```

## AI Context / Usage Guide

### 什么时候用

- 适用场景说明
- 典型业务或技术情境
- 典型使用者角色

### 何时不用

- 排除场景、易误用情况
- 何时应用替代方案

### 使用步骤

1. 第一步：准备或前置条件
2. 第二步：主体逻辑
3. 第三步：结果处理或后续

### 关键点

- 易错点、容易忽略的细节
- 线程/内存/生命周期约束
- 性能特征或限制

### 依赖与前置条件

- 需导入的模块/框架
- 最低系统/API 版本
- 权限、配置或环境要求

### 错误处理

- 常见失败场景和处理方式
- 重试、超时、降级策略
- 异常分支处理

### 性能与资源

- 缓存、内存使用、线程安全
- 频率限制或节流建议
- 大数据量或高并发处理

### 安全与合规

- 敏感信息处理（token、密钥等）
- 鉴权、日志脱敏策略
- 合规要求（数据保护、用户隐私）

### 常见误用

- ❌ 错误做法 1：原因分析
- ❌ 错误做法 2：原因分析
- ✅ 正确做法：推荐方式

### 最佳实践

- 推荐做法 1：适用场景或原因
- 推荐做法 2：性能或可维护性考量
- 推荐工具或设计模式

### 替代方案

- **方案 A**：优缺点对比
- **方案 B**：何时优先使用
- **其他 Recipe**：关联或互补方案

### 相关 Recipe

- `@相关_trigger_1`：简要说明关系
- `@相关_trigger_2`：简要说明关系
