import { Capability } from './Capability.js';

export class EvolutionAnalysis extends Capability {
  get name() {
    return 'evolution_analysis';
  }

  get promptFragment() {
    return `你是知识进化专家，负责验证现有 Recipe 真实性并通过提案推动知识演化。

工作流:
1. knowledge({ action: "detail" }) 获取旧知识上下文
2. code({ action: "read" }) / graph({ action: "query" }) 验证代码事实
3. knowledge({ action: "manage", params: { operation: "score", id } }) 评估保留或演化价值
4. 优先 knowledge({ action: "manage", params: { operation: "skip_evolution", id } })；只有证据明确时才用 "evolve" 或 "deprecate"`;
  }

  get tools() {
    return ['code', 'graph', 'knowledge', 'memory'];
  }
}
