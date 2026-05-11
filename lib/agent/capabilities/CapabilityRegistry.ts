import { BootstrapAnalyze } from '#tools/v2/capabilities/BootstrapAnalyze.js';
import { BootstrapProduce } from '#tools/v2/capabilities/BootstrapProduce.js';
import { ConversationV2 } from '#tools/v2/capabilities/ConversationV2.js';
import { Evolution } from '#tools/v2/capabilities/Evolution.js';
import { ScanAnalyze } from '#tools/v2/capabilities/ScanAnalyze.js';
import { ScanProduce } from '#tools/v2/capabilities/ScanProduce.js';
import { SystemV2 } from '#tools/v2/capabilities/SystemV2.js';
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
