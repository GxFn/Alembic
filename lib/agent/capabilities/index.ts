// V2 capabilities (from the extracted Agent tool-system package)
export {
  BootstrapAnalyze as CodeAnalysis,
  BootstrapProduce as KnowledgeProduction,
  ConversationV2 as Conversation,
  Evolution as EvolutionAnalysis,
  ScanProduce as ScanProduction,
  SystemV2 as SystemInteraction,
} from '@alembic/agent/tools';
export { Capability } from './Capability.js';
export { CapabilityRegistry } from './CapabilityRegistry.js';

import {
  BootstrapAnalyze,
  BootstrapProduce,
  ConversationV2,
  Evolution,
  SystemV2,
} from '@alembic/agent/tools';
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
