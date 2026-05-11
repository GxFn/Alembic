import type { AgentProfileDefinition } from '../service/AgentRunContracts.js';
import { BUILTIN_PROFILES } from './definitions/index.js';

export class AgentProfileRegistry {
  #profiles = new Map<string, AgentProfileDefinition>();

  constructor(profiles: AgentProfileDefinition[] = BUILTIN_PROFILES) {
    for (const profile of profiles) {
      this.register(profile);
    }
  }

  register(profile: AgentProfileDefinition) {
    if (!profile.id) {
      throw new Error('Agent profile id is required');
    }
    assertSerializableProfile(profile);
    this.#profiles.set(profile.id, profile);
    return this;
  }

  get(id: string) {
    return this.#profiles.get(id) || null;
  }

  require(id: string) {
    const profile = this.get(id);
    if (!profile) {
      throw new Error(`Unknown agent profile: "${id}"`);
    }
    return profile;
  }

  list() {
    return [...this.#profiles.values()];
  }
}

function assertSerializableProfile(profile: AgentProfileDefinition) {
  JSON.stringify(profile, (_key, value) => {
    if (typeof value === 'function') {
      throw new Error(`Agent profile "${profile.id}" must not contain functions`);
    }
    if (value instanceof Set || value instanceof Map) {
      throw new Error(`Agent profile "${profile.id}" must not contain Set or Map`);
    }
    return value;
  });
}

export default AgentProfileRegistry;
