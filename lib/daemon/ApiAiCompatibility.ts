import type {
  AlembicResidentCapabilityOverrides,
  AlembicResidentServiceStatus,
  AlembicRuntimeCapabilities,
  AlembicInternalAiCapability as CoreApiAiCapability,
  ProjectRuntimeInternalAiSummary as CoreProjectRuntimeApiAiSummary,
} from '@alembic/core/daemon';

export type ApiAiCapability = CoreApiAiCapability;
export type ProjectRuntimeApiAiSummary = CoreProjectRuntimeApiAiSummary;

type ResidentJobCapability = {
  available: boolean;
  message: string;
};

const API_AI_FIELD = 'apiAi';
const LEGACY_CORE_API_AI_FIELD = 'internalAi';
const API_AI_RESIDENT_JOB_KEYS = {
  bootstrap: 'jobs.api-ai.bootstrap',
  rescan: 'jobs.api-ai.rescan',
} as const;
const LEGACY_CORE_API_AI_RESIDENT_JOB_KEYS = {
  bootstrap: 'jobs.internal-ai.bootstrap',
  rescan: 'jobs.internal-ai.rescan',
} as const;

export function readApiAiCompatibilityValue<T>(
  capabilities: ({ apiAi?: T } & { [LEGACY_CORE_API_AI_FIELD]?: T }) | null | undefined
): T | undefined {
  return (
    capabilities?.[API_AI_FIELD] ?? (capabilities?.[LEGACY_CORE_API_AI_FIELD] as T | undefined)
  );
}

export function readApiAiCapability(
  capabilities: AlembicRuntimeCapabilities & { apiAi?: ApiAiCapability }
): ApiAiCapability {
  const apiAi = readApiAiCompatibilityValue<ApiAiCapability>(capabilities);
  if (!apiAi) {
    throw new Error('Runtime capabilities are missing API AI capability');
  }
  return apiAi;
}

export function withCoreApiAiCapability<T extends { apiAi: ApiAiCapability }>(
  input: T
): Omit<T, 'apiAi'> & { [LEGACY_CORE_API_AI_FIELD]: ApiAiCapability } {
  const { apiAi, ...rest } = input;
  return {
    ...rest,
    [LEGACY_CORE_API_AI_FIELD]: apiAi,
  } as Omit<T, 'apiAi'> & { [LEGACY_CORE_API_AI_FIELD]: ApiAiCapability };
}

export function withCoreProjectRuntimeApiAiSummary<
  const T extends { apiAi: ProjectRuntimeApiAiSummary },
>(summary: T): T & { [LEGACY_CORE_API_AI_FIELD]: ProjectRuntimeApiAiSummary } {
  return {
    ...summary,
    [LEGACY_CORE_API_AI_FIELD]: summary.apiAi,
  } as T & { [LEGACY_CORE_API_AI_FIELD]: ProjectRuntimeApiAiSummary };
}

export function withCoreApiAiResidentJobOverrides(
  overrides: AlembicResidentCapabilityOverrides,
  jobs: {
    bootstrap: ResidentJobCapability;
    rescan: ResidentJobCapability;
  }
): AlembicResidentCapabilityOverrides {
  return {
    ...overrides,
    [LEGACY_CORE_API_AI_RESIDENT_JOB_KEYS.bootstrap]: jobs.bootstrap,
    [LEGACY_CORE_API_AI_RESIDENT_JOB_KEYS.rescan]: jobs.rescan,
  };
}

export function normalizeApiAiResidentJobCapabilities(
  status: AlembicResidentServiceStatus
): AlembicResidentServiceStatus {
  const capabilities = status.capabilities as Record<string, unknown>;
  const {
    [LEGACY_CORE_API_AI_RESIDENT_JOB_KEYS.bootstrap]: bootstrap,
    [LEGACY_CORE_API_AI_RESIDENT_JOB_KEYS.rescan]: rescan,
    ...rest
  } = capabilities;

  return {
    ...status,
    capabilities: {
      ...rest,
      ...(bootstrap ? { [API_AI_RESIDENT_JOB_KEYS.bootstrap]: bootstrap } : {}),
      ...(rescan ? { [API_AI_RESIDENT_JOB_KEYS.rescan]: rescan } : {}),
    } as AlembicResidentServiceStatus['capabilities'],
  };
}
