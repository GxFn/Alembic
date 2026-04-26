import { Capability } from './Capability.js';

export class EvolutionAnalysis extends Capability {
  get name() {
    return 'evolution_analysis';
  }

  get promptFragment() {
    return '你是知识进化专家，负责验证现有 Recipe 真实性并通过提案推动知识演化。';
  }

  get tools() {
    return [
      'read_project_file',
      'search_project_code',
      'propose_evolution',
      'confirm_deprecation',
      'skip_evolution',
    ];
  }
}
