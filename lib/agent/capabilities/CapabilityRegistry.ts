import {
  BootstrapAnalyze,
  BootstrapProduce,
  ConversationV2,
  Evolution,
  ScanAnalyze,
  ScanProduce,
  SystemV2,
} from '@alembic/agent/tools';
import type { Capability } from './Capability.js';

type CapabilityConstructor = new (opts?: Record<string, unknown>) => Capability;

export const CapabilityRegistry = {
  _registry: new Map<string, CapabilityConstructor>([
    ['conversation', ConversationV2 as CapabilityConstructor],
    ['code_analysis', BootstrapAnalyze as CapabilityConstructor],
    ['knowledge_production', BootstrapProduce as CapabilityConstructor],
    ['scan_production', ScanProduce as CapabilityConstructor],
    ['scan_analyze', ScanAnalyze as CapabilityConstructor],
    ['system_interaction', SystemV2 as CapabilityConstructor],
    ['evolution_analysis', Evolution as CapabilityConstructor],
  ]),

  create(name: string, opts: Record<string, unknown> = {}): Capability {
    const Cls = this._registry.get(name);
    if (!Cls) {
      throw new Error(`Unknown capability: ${name}`);
    }
    return new Cls(opts);
  },

  register(name: string, cls: CapabilityConstructor) {
    this._registry.set(name, cls);
  },

  get names(): string[] {
    return [...this._registry.keys()];
  },
};
