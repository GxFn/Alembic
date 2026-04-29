import type { ExternalRescanEvidencePlan } from '#workflows/common-capabilities/knowledge-rescan/KnowledgeRescanPlanner.js';

export type BriefingProfile = 'cold-start-external' | 'rescan-external';

export interface ResponseBudget {
  limitBytes: number;
}

export interface RescanBriefingPrescreen {
  needsVerification: unknown[];
  autoResolved: unknown[];
  dimensionGaps: unknown;
}

export interface RescanBriefingInput {
  evidencePlan: ExternalRescanEvidencePlan;
  prescreen: RescanBriefingPrescreen;
}

export interface BriefingProfileInput {
  profile?: BriefingProfile;
  rescan?: RescanBriefingInput;
  responseBudget?: Partial<ResponseBudget>;
}

export interface BriefingPlan {
  profile: BriefingProfile;
  rescan?: RescanBriefingInput;
  responseBudget: ResponseBudget;
}

export const DEFAULT_BRIEFING_PROFILE: BriefingProfile = 'cold-start-external';
export const DEFAULT_RESPONSE_BUDGET: ResponseBudget = { limitBytes: 100 * 1024 };

export function createBriefingPlan(input: BriefingProfileInput = {}): BriefingPlan {
  const profile = input.profile ?? (input.rescan ? 'rescan-external' : DEFAULT_BRIEFING_PROFILE);

  if (profile === 'rescan-external' && !input.rescan) {
    throw new Error('[MissionBriefing] rescan-external profile requires rescan evidence input');
  }
  if (profile === 'cold-start-external' && input.rescan) {
    throw new Error('[MissionBriefing] cold-start-external profile cannot accept rescan evidence');
  }

  return {
    profile,
    rescan: input.rescan,
    responseBudget: {
      limitBytes: input.responseBudget?.limitBytes ?? DEFAULT_RESPONSE_BUDGET.limitBytes,
    },
  };
}
