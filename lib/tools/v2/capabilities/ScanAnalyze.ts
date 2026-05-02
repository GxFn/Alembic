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
      memory: ['save'],
    };
  }
}
