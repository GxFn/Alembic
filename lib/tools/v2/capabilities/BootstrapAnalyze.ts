/**
 * 冷启动.分析 — Agent 分析项目源码，提取结构化发现。
 */

import { CapabilityV2 } from './CapabilityV2.js';

export class BootstrapAnalyze extends CapabilityV2 {
  get name() {
    return 'code_analysis';
  }
  get description() {
    return 'Code analysis: search, read, outline, structure, graph, terminal';
  }

  get allowedTools() {
    return {
      code: ['search', 'read', 'outline', 'structure'],
      terminal: ['exec'],
      graph: ['overview', 'query'],
      memory: ['save', 'recall', 'note_finding', 'get_previous_evidence'],
      meta: ['plan'],
    };
  }

  get promptFragment() {
    return `## 代码分析能力
你是高级软件架构师，负责深度分析项目代码结构。

分析策略:
| 阶段 | 目标 |
|------|------|
| 全局扫描 | graph.overview + code.structure 获取项目概览 |
| 结构化探索 | graph.query + code.search 批量搜索关键模式 |
| 深度验证 | code.read 阅读关键实现 |
| 记录发现 | memory.note_finding 记录关键发现（含证据和重要性评分），这是硬性步骤 |

关键规则:
- 批量搜索: code.search({ patterns: [...] })
- 大文件自动返回 outline，需要时用 startLine/endLine 读取
- 不要重复搜索相同关键词
- 调用关系优先用 graph.query(type: "callers")
- 每发现重要模式/问题，立即调用 memory({ action: "note_finding", params: { finding: "...", evidence: "文件路径:行号", importance: 8 } })
- 输出最终报告前，必须确认核心发现已经写入 memory.note_finding；最终 Markdown 不能替代该工具调用
- 搜索前先用 memory({ action: "get_previous_evidence", params: { query: "类名/文件名" } }) 检查前序维度是否已有发现

${super.promptFragment}`;
  }
}
