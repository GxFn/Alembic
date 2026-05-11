/**
 * 增量扫描.生产 — Agent 将扫描发现转化为知识候选。
 */

import { CapabilityV2 } from './CapabilityV2.js';

export class ScanProduce extends CapabilityV2 {
  get name() {
    return 'scan_production';
  }
  get description() {
    return 'Knowledge production for incremental scan';
  }

  get allowedTools() {
    return {
      code: ['read'],
      knowledge: ['submit'],
      memory: ['recall'],
    };
  }
}
