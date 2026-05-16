import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';
import { BOOTSTRAP_PROFILES } from './bootstrap.profile.js';
import { CHAT_PROFILES } from './chat.profile.js';
import { EVOLUTION_PROFILES } from './evolution.profile.js';
import { RELATION_PROFILES } from './relation.profile.js';
import { REMOTE_PROFILES } from './remote.profile.js';
import { SCAN_PROFILES } from './scan.profile.js';
import { SIGNAL_PROFILES } from './signal.profile.js';
import { TRANSLATION_PROFILES } from './translation.profile.js';

export const BUILTIN_PROFILES: AgentProfileDefinition[] = [
  ...CHAT_PROFILES,
  ...REMOTE_PROFILES,
  ...SCAN_PROFILES,
  ...RELATION_PROFILES,
  ...EVOLUTION_PROFILES,
  ...TRANSLATION_PROFILES,
  ...SIGNAL_PROFILES,
  ...BOOTSTRAP_PROFILES,
];
