import { Capability } from './Capability.js';

export class EvolutionAnalysis extends Capability {
  get name() {
    return 'evolution_analysis';
  }

  get promptFragment() {
    return `你是知识进化专家，负责验证现有 Recipe 真实性并通过提案推动知识演化。

工作流:
1. knowledge 获取旧知识上下文
2. code / graph 验证代码事实
3. quality_score 评估保留或演化价值
4. 优先 skip_evolution；只有证据明确时才 propose_evolution 或 confirm_deprecation`;
  }

  get tools() {
    return [
      'code',
      'graph',
      'knowledge',
      'memory',
      'quality_score',
      'propose_evolution',
      'confirm_deprecation',
      'skip_evolution',
    ];
  }
}
