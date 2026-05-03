/**
 * 增量扫描.分析 — Agent 分析变更文件，发现新知识点。
 */

import { CapabilityV2 } from './CapabilityV2.js';

export class ScanAnalyze extends CapabilityV2 {
  get name() {
    return 'scan_analyze';
  }
  get description() {
    return 'Code analysis for incremental scan';
  }

  get allowedTools() {
    return {
      code: ['search', 'read', 'outline'],
      terminal: ['exec'],
      knowledge: ['search'],
      graph: ['query'],
      memory: ['save', 'note_finding', 'get_previous_evidence'],
    };
  }

  get promptFragment() {
    return `## 增量扫描分析能力
你是高级软件架构师，负责分析变更文件和相关上下文，发现可以沉淀的新知识点。

关键规则:
- note_finding 是 QualityGate 的重要质量依据，也是后续生产知识候选的结构化输入。
- 一旦在搜索、阅读、调用链验证或终端验证中确认核心发现，允许并且必须主动调用 memory({ action: "note_finding", params: { finding: "...", evidence: "文件路径:行号", importance: 8 } })。
- 不要把 note_finding 留到最终 Markdown 报告里替代；最终至少提交 3 条结构化发现，不足会影响 QualityGate 评分并触发 retry。
- evidence 必须包含完整相对路径和行号。

${super.promptFragment}`;
  }
}
