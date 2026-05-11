// V2 capabilities (直接从 V2 模块重导出)
export { BootstrapAnalyze as CodeAnalysis } from '#tools/v2/capabilities/BootstrapAnalyze.js';
export { BootstrapProduce as KnowledgeProduction } from '#tools/v2/capabilities/BootstrapProduce.js';
export { ConversationV2 as Conversation } from '#tools/v2/capabilities/ConversationV2.js';
export { Evolution as EvolutionAnalysis } from '#tools/v2/capabilities/Evolution.js';
export { ScanProduce as ScanProduction } from '#tools/v2/capabilities/ScanProduce.js';
export { SystemV2 as SystemInteraction } from '#tools/v2/capabilities/SystemV2.js';
export { Capability } from './Capability.js';
export { CapabilityRegistry } from './CapabilityRegistry.js';

import { BootstrapAnalyze } from '#tools/v2/capabilities/BootstrapAnalyze.js';
import { BootstrapProduce } from '#tools/v2/capabilities/BootstrapProduce.js';
import { ConversationV2 } from '#tools/v2/capabilities/ConversationV2.js';
import { Evolution } from '#tools/v2/capabilities/Evolution.js';
import { SystemV2 } from '#tools/v2/capabilities/SystemV2.js';
import { Capability } from './Capability.js';
import { CapabilityRegistry } from './CapabilityRegistry.js';

export default {
  Capability,
  Conversation: ConversationV2,
  CodeAnalysis: BootstrapAnalyze,
  KnowledgeProduction: BootstrapProduce,
  SystemInteraction: SystemV2,
  EvolutionAnalysis: Evolution,
  CapabilityRegistry,
};
