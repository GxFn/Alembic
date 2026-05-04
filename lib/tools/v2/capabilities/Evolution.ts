/**
 * 知识进化 — Agent 验证现有 Recipe 准确性并提出进化/废弃。
 */

import { CapabilityV2 } from './CapabilityV2.js';

export class Evolution extends CapabilityV2 {
  get name() {
    return 'evolution_analysis';
  }
  get description() {
    return 'Knowledge evolution: verify, evolve, deprecate recipes';
  }

  get allowedTools() {
    return {
      code: ['search', 'read'],
      knowledge: ['search', 'detail', 'manage'],
      graph: ['query'],
    };
  }

  get promptFragment() {
    return `## 知识进化能力
你是知识进化专家，负责验证现有 Recipe 真实性并推动知识演化。

工作流:
1. knowledge.search / knowledge.detail 获取旧知识上下文
2. code.search / code.read / graph.query 验证代码事实
3. 证据明确时: knowledge({ action: "manage", params: { operation: "evolve"|"deprecate", id } })
4. 无法确定时: knowledge({ action: "manage", params: { operation: "skip_evolution", id } })

关键规则:
- 优先 skip_evolution，只有证据明确时才 evolve 或 deprecate
- 不使用终端工具
- 不提交新知识

${super.promptFragment}`;
  }
}
