import type { DimensionDef } from '@alembic/core/types';

const DEFAULT_CREATE_BUDGET = 1;
const MAX_CREATE_BUDGET = 20;

export interface ControllerProduceSessionGap {
  createBudget: number;
  dimensionId: string;
  gapId: string;
  source: string;
  triggerPrefix?: string;
}

export interface ControllerProduceSessionRequest {
  defaultCreateBudget: number;
  enabled: boolean;
  gaps: ControllerProduceSessionGap[];
  reason: string | null;
  source: string;
}

export interface ProduceSessionRoutePlan {
  dimensions: DimensionDef[];
  gaps: ControllerProduceSessionGap[];
  invalidGaps: Array<{ dimensionId?: string; gapId?: string; reason: string }>;
  request: ControllerProduceSessionRequest;
}

export interface ProduceSessionProjection {
  blocker?: {
    nextAction: string;
    owner: string;
    reason: string;
    reasonCode: string;
  };
  bootstrapSessionRef?: string;
  constraints: {
    allowedSources: string[];
    occupiedTriggerCount: number;
    occupiedTriggers: string[];
    requireProductionSession: true;
    sessionRefFields: string[];
    source: string;
    triggerPrefixes: string[];
  };
  createBudgets: Record<string, number>;
  dimensions: Array<{ createBudget: number; gapId: string; id: string; label?: string }>;
  gaps: ControllerProduceSessionGap[];
  mode: 'controller-authorized-gap-fill' | 'rescan-gap-analysis';
  projectRoot: string;
  required: boolean;
  reusedExistingSession: boolean;
  sessionId?: string;
  status: 'active' | 'no-produce-session';
  usable: boolean;
}

export interface ProduceSessionLike {
  id?: string;
  projectRoot?: string;
  getProgress?(): { remainingDimIds?: unknown };
  toJSON?(): Record<string, unknown>;
}

interface RescanExecutionDecisionLike {
  createBudget?: number;
  dimension?: DimensionDef;
  dimensionId: string;
  mode: string;
}

interface RescanGapPlanLike {
  executionDecisions?: readonly RescanExecutionDecisionLike[];
  occupiedTriggers?: readonly string[];
  produceDimensions: readonly DimensionDef[];
}

export function readControllerProduceSessionRequest(
  args: Record<string, unknown>
): ControllerProduceSessionRequest {
  const route = readRecord(args.produceSession) ?? readRecord(args.controllerProduceSession);
  const rawGaps = readGapArray(route?.gaps) ?? readGapArray(args.controllerAuthorizedGaps) ?? [];
  const dimensionGaps = readStringArray(route?.dimensions ?? args.produceSessionDimensions).map(
    (dimensionId) => ({ dimensionId })
  );
  const source =
    readNonEmptyString(route?.source) ?? readNonEmptyString(args.source) ?? 'asq-controller';
  const defaultCreateBudget = readCreateBudget(route?.createBudget ?? args.createBudget);
  const gaps = [...rawGaps, ...dimensionGaps].map((gap) =>
    normalizeControllerGap(gap, source, defaultCreateBudget)
  );
  const enabled =
    route?.enabled === true ||
    route?.controllerAuthorized === true ||
    args.controllerAuthorized === true ||
    gaps.length > 0;

  return {
    defaultCreateBudget,
    enabled,
    gaps,
    reason: readNonEmptyString(route?.reason ?? args.reason) ?? null,
    source,
  };
}

export function buildProduceSessionRoutePlan(input: {
  allDimensions: readonly DimensionDef[];
  gapPlan: RescanGapPlanLike;
  request: ControllerProduceSessionRequest;
}): ProduceSessionRoutePlan {
  const dimensionsById = new Map(input.allDimensions.map((dimension) => [dimension.id, dimension]));
  if (input.request.enabled) {
    return buildControllerProduceSessionRoutePlan(input.request, dimensionsById);
  }

  const decisionByDimension = new Map(
    (input.gapPlan.executionDecisions ?? []).map((decision) => [decision.dimensionId, decision])
  );
  const gaps = input.gapPlan.produceDimensions.map((dimension) => {
    const decision = decisionByDimension.get(dimension.id);
    return {
      createBudget: readCreateBudget(decision?.createBudget),
      dimensionId: dimension.id,
      gapId: `rescan:${dimension.id}`,
      source: 'rescan-gap-analysis',
    };
  });

  return {
    dimensions: input.gapPlan.produceDimensions.map((dimension) => ({ ...dimension })),
    gaps,
    invalidGaps: [],
    request: {
      defaultCreateBudget: DEFAULT_CREATE_BUDGET,
      enabled: false,
      gaps,
      reason: null,
      source: 'rescan-gap-analysis',
    },
  };
}

export function buildProduceSessionProjection(input: {
  occupiedTriggers?: readonly string[];
  plan: ProduceSessionRoutePlan;
  projectRoot: string;
  reusedExistingSession?: boolean;
  session: ProduceSessionLike | null;
}): ProduceSessionProjection {
  const required = input.plan.request.enabled;
  const mode = required ? 'controller-authorized-gap-fill' : 'rescan-gap-analysis';
  const occupiedTriggers = [...(input.occupiedTriggers ?? [])].filter(
    (trigger): trigger is string => typeof trigger === 'string' && trigger.length > 0
  );
  const triggerPrefixes = uniqueStrings(
    input.plan.gaps
      .map((gap) => gap.triggerPrefix)
      .filter((triggerPrefix): triggerPrefix is string => Boolean(triggerPrefix))
  );
  const constraints = {
    allowedSources: uniqueStrings([
      input.plan.request.source,
      ...input.plan.gaps.map((gap) => gap.source),
    ]),
    occupiedTriggerCount: occupiedTriggers.length,
    occupiedTriggers,
    requireProductionSession: true as const,
    sessionRefFields: ['sessionId', 'bootstrapSessionRef'],
    source: input.plan.request.source,
    triggerPrefixes,
  };

  const noProduce = buildNoProduceProjection({
    blockerReason:
      input.plan.invalidGaps.length > 0
        ? `No safe produce gaps were opened. Invalid gaps: ${input.plan.invalidGaps
            .map((gap) => gap.reason)
            .join('; ')}`
        : 'No produce dimensions or controller-authorized gaps are available for this rescan.',
    constraints,
    input,
    mode,
    reasonCode: 'no-produce-session',
  });
  if (input.plan.dimensions.length === 0 || input.plan.gaps.length === 0) {
    return noProduce;
  }

  if (!input.session) {
    return buildNoProduceProjection({
      blockerReason: 'No GenerateSessionManager session is available for the produce route.',
      constraints,
      input,
      mode,
      reasonCode: 'session-unavailable',
    });
  }

  const sessionId = readSessionId(input.session);
  const remainingDimIds = readRemainingDimIds(input.session);
  const missingSessionDimensions = input.plan.dimensions
    .map((dimension) => dimension.id)
    .filter((dimensionId) => !remainingDimIds.has(dimensionId));
  if (!sessionId || missingSessionDimensions.length > 0) {
    return buildNoProduceProjection({
      blockerReason: `Active session does not cover requested produce dimensions: ${missingSessionDimensions.join(', ') || 'unknown session id'}.`,
      constraints,
      input,
      mode,
      reasonCode: 'session-does-not-cover-produce-gaps',
    });
  }

  return {
    bootstrapSessionRef: `bootstrap-session:${sessionId}`,
    constraints,
    createBudgets: Object.fromEntries(
      input.plan.gaps.map((gap) => [gap.dimensionId, gap.createBudget])
    ),
    dimensions: input.plan.dimensions.map((dimension) => {
      const gap = input.plan.gaps.find((candidate) => candidate.dimensionId === dimension.id);
      return {
        createBudget: gap?.createBudget ?? DEFAULT_CREATE_BUDGET,
        gapId: gap?.gapId ?? `${mode}:${dimension.id}`,
        id: dimension.id,
        ...(dimension.label ? { label: dimension.label } : {}),
      };
    }),
    gaps: input.plan.gaps,
    mode,
    projectRoot: input.projectRoot,
    required,
    reusedExistingSession: input.reusedExistingSession === true,
    sessionId,
    status: 'active',
    usable: true,
  };
}

function buildControllerProduceSessionRoutePlan(
  request: ControllerProduceSessionRequest,
  dimensionsById: Map<string, DimensionDef>
): ProduceSessionRoutePlan {
  const validGaps: ControllerProduceSessionGap[] = [];
  const invalidGaps: ProduceSessionRoutePlan['invalidGaps'] = [];
  const seenDimensions = new Set<string>();

  for (const gap of request.gaps) {
    if (!gap.dimensionId) {
      invalidGaps.push({ gapId: gap.gapId, reason: 'missing-dimension-id' });
      continue;
    }
    const dimension = dimensionsById.get(gap.dimensionId);
    if (!dimension) {
      invalidGaps.push({
        dimensionId: gap.dimensionId,
        gapId: gap.gapId,
        reason: `unknown-dimension:${gap.dimensionId}`,
      });
      continue;
    }
    if (seenDimensions.has(gap.dimensionId)) {
      continue;
    }
    seenDimensions.add(gap.dimensionId);
    validGaps.push(gap);
  }

  return {
    dimensions: validGaps
      .map((gap) => dimensionsById.get(gap.dimensionId))
      .filter((dimension): dimension is DimensionDef => Boolean(dimension)),
    gaps: validGaps,
    invalidGaps,
    request,
  };
}

function buildNoProduceProjection(input: {
  blockerReason: string;
  constraints: ProduceSessionProjection['constraints'];
  input: {
    plan: ProduceSessionRoutePlan;
    projectRoot: string;
    reusedExistingSession?: boolean;
  };
  mode: ProduceSessionProjection['mode'];
  reasonCode: string;
}): ProduceSessionProjection {
  return {
    blocker: {
      nextAction:
        'Provide controller-authorized ASQ gap dimensions with positive create budgets, or complete/release the conflicting session before submitting production knowledge.',
      owner: 'controller-or-alembic-produce-session-route',
      reason: input.blockerReason,
      reasonCode: input.reasonCode,
    },
    constraints: input.constraints,
    createBudgets: {},
    dimensions: [],
    gaps: [],
    mode: input.mode,
    projectRoot: input.input.projectRoot,
    required: input.input.plan.request.enabled,
    reusedExistingSession: input.input.reusedExistingSession === true,
    status: 'no-produce-session',
    usable: false,
  };
}

function normalizeControllerGap(
  gap: Record<string, unknown>,
  source: string,
  defaultCreateBudget: number
): ControllerProduceSessionGap {
  const dimensionId = readNonEmptyString(gap.dimensionId ?? gap.dimension ?? gap.id) ?? '';
  const gapId = readNonEmptyString(gap.gapId ?? gap.id) ?? `controller-gap:${dimensionId}`;
  const triggerPrefix = readNonEmptyString(gap.triggerPrefix);
  return {
    createBudget: readCreateBudget(gap.createBudget ?? gap.budget ?? defaultCreateBudget),
    dimensionId,
    gapId,
    source: readNonEmptyString(gap.source) ?? source,
    ...(triggerPrefix ? { triggerPrefix } : {}),
  };
}

function readGapArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((entry) => (typeof entry === 'string' ? { dimensionId: entry } : readRecord(entry)))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCreateBudget(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : DEFAULT_CREATE_BUDGET;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_CREATE_BUDGET;
  }
  return Math.min(Math.floor(numeric), MAX_CREATE_BUDGET);
}

function readSessionId(session: ProduceSessionLike): string | null {
  if (typeof session.id === 'string' && session.id.length > 0) {
    return session.id;
  }
  const snapshot = session.toJSON?.();
  return typeof snapshot?.id === 'string' ? snapshot.id : null;
}

function readRemainingDimIds(session: ProduceSessionLike): Set<string> {
  const progress = session.getProgress?.();
  if (Array.isArray(progress?.remainingDimIds)) {
    return new Set(progress.remainingDimIds.filter((id): id is string => typeof id === 'string'));
  }
  const snapshot = session.toJSON?.();
  const snapshotProgress = readRecord(snapshot?.progress);
  const remaining = snapshotProgress?.remainingDimIds;
  return new Set(
    Array.isArray(remaining) ? remaining.filter((id): id is string => typeof id === 'string') : []
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
