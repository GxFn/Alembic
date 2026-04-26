import type { Capability } from './Capability.js';
import { CodeAnalysis } from './CodeAnalysis.js';
import { Conversation } from './Conversation.js';
import { EvolutionAnalysis } from './EvolutionAnalysis.js';
import { KnowledgeProduction } from './KnowledgeProduction.js';
import { ScanProduction } from './ScanProduction.js';
import { SystemInteraction } from './SystemInteraction.js';

export const CapabilityRegistry = {
  _registry: new Map<string, typeof Capability>([
    ['conversation', Conversation],
    ['code_analysis', CodeAnalysis],
    ['knowledge_production', KnowledgeProduction],
    ['scan_production', ScanProduction],
    ['system_interaction', SystemInteraction],
    ['evolution_analysis', EvolutionAnalysis],
  ]),

  create(name: string, opts: Record<string, unknown> = {}) {
    const Cls = this._registry.get(name);
    if (!Cls) {
      throw new Error(`Unknown capability: ${name}`);
    }
    return new (Cls as new (opts: Record<string, unknown>) => Capability)(opts);
  },

  register(name: string, cls: typeof Capability) {
    this._registry.set(name, cls);
  },

  get names() {
    return [...this._registry.keys()];
  },
};
