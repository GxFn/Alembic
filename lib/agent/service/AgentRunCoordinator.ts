import { createLimit } from '#shared/concurrency.js';
import type {
  AgentConcurrencyPlan,
  AgentProfileOverride,
  AgentProfileRef,
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  CompiledAgentProfile,
} from './AgentRunContracts.js';

type ChildRunner = (input: AgentRunInput) => Promise<AgentRunResult>;
type Partitioner = (input: AgentRunInput, profile: CompiledAgentProfile) => AgentRunInput[];
type Merger = (
  results: AgentRunResult[],
  input: AgentRunInput,
  profile: CompiledAgentProfile
) => AgentRunResult;
type ChildRunRecord = { childInput: AgentRunInput; result: AgentRunResult };

export class AgentRunCoordinator {
  #partitioners = new Map<string, Partitioner>();
  #mergers = new Map<string, Merger>();

  constructor() {
    this.registerPartitioner('bootstrapSessionDimensions', partitionBootstrapSessionDimensions);
    this.registerMerger('bootstrapSessionResults', mergeBootstrapSessionResults);
  }

  registerPartitioner(name: string, partitioner: Partitioner) {
    this.#partitioners.set(name, partitioner);
    return this;
  }

  registerMerger(name: string, merger: Merger) {
    this.#mergers.set(name, merger);
    return this;
  }

  canCoordinate(profile: CompiledAgentProfile) {
    return !!profile.concurrency && profile.concurrency.mode !== 'none';
  }

  async run(input: AgentRunInput, profile: CompiledAgentProfile, runChild: ChildRunner) {
    if (!profile.concurrency || profile.concurrency.mode === 'none') {
      return null;
    }
    const partitionerName = profile.concurrency.partitioner;
    if (!partitionerName) {
      throw new Error(`Agent profile "${profile.id}" concurrency plan requires partitioner`);
    }
    const partitioner = this.#partitioners.get(partitionerName);
    if (!partitioner) {
      throw new Error(`Unknown agent run partitioner: "${partitionerName}"`);
    }
    const childInputs = partitioner(input, profile);
    const childResults = await runChildren(
      childInputs,
      profile.concurrency,
      runChild,
      input,
      profile
    );
    const mergeName = profile.concurrency.merge;
    const merger = mergeName ? this.#mergers.get(mergeName) : null;
    if (mergeName && !merger) {
      throw new Error(`Unknown agent run merger: "${mergeName}"`);
    }
    return merger ? merger(childResults, input, profile) : defaultMerge(childResults, profile);
  }
}

async function runChildren(
  childInputs: AgentRunInput[],
  concurrencyPlan: AgentConcurrencyPlan,
  runChild: ChildRunner,
  parentInput: AgentRunInput,
  profile: CompiledAgentProfile
) {
  const concurrency = resolveConcurrency(concurrencyPlan.concurrency);
  const limit = createLimit(concurrency);
  const runOneChild = (child: AgentRunInput) =>
    runChildWithHooks(child, runChild, parentInput, profile);
  if (concurrencyPlan.mode !== 'tiered') {
    const childRuns = await Promise.all(
      childInputs.map((child) => limit(() => runOneChild(child)))
    );
    return childRuns.map((childRun) => childRun.result);
  }
  const results: AgentRunResult[] = [];
  const tiers = groupByTier(childInputs);
  for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
    if (await shouldAbort(parentInput)) {
      const abortedRuns = await abortChildInputs(
        tiers.slice(tierIndex).flat(),
        parentInput,
        profile
      );
      results.push(...abortedRuns.map((childRun) => childRun.result));
      break;
    }
    const tier = tiers[tierIndex];
    const tierRuns = await Promise.all(tier.map((child) => limit(() => runOneChild(child))));
    const tierResults = tierRuns.map((childRun) => childRun.result);
    results.push(...tierResults);
    await parentInput.context.coordination?.onTierComplete?.({
      tierIndex,
      childInputs: tierRuns.map((childRun) => childRun.childInput),
      results: tierResults,
      profile,
    });
  }
  return results;
}

async function runChildWithHooks(
  childInput: AgentRunInput,
  runChild: ChildRunner,
  parentInput: AgentRunInput,
  profile: CompiledAgentProfile
): Promise<ChildRunRecord> {
  if (await shouldAbort(parentInput)) {
    return createAbortedChildRunWithHooks(childInput, parentInput, profile);
  }
  let resolvedChildInput = childInput;
  let result: AgentRunResult;
  try {
    resolvedChildInput = await resolveLazyChildInput(childInput, parentInput);
    if (await shouldAbort(parentInput)) {
      return createAbortedChildRunWithHooks(resolvedChildInput, parentInput, profile);
    }
    result = await runChild(resolvedChildInput);
  } catch (err: unknown) {
    result = createChildErrorResult(resolvedChildInput, err);
  }
  await parentInput.context.coordination?.onChildResult?.({
    childInput: resolvedChildInput,
    result,
    profile,
  });
  return { childInput: resolvedChildInput, result };
}

async function abortChildInputs(
  childInputs: AgentRunInput[],
  parentInput: AgentRunInput,
  profile: CompiledAgentProfile
) {
  return Promise.all(
    childInputs.map((childInput) =>
      createAbortedChildRunWithHooks(childInput, parentInput, profile)
    )
  );
}

async function shouldAbort(input: AgentRunInput) {
  if (input.execution?.abortSignal?.aborted) {
    return true;
  }
  return (await input.execution?.shouldAbort?.()) === true;
}

async function createAbortedChildRunWithHooks(
  childInput: AgentRunInput,
  parentInput: AgentRunInput,
  profile: CompiledAgentProfile
): Promise<ChildRunRecord> {
  const result = createChildAbortedResult(childInput);
  await parentInput.context.coordination?.onChildResult?.({
    childInput,
    result,
    profile,
  });
  return { childInput, result };
}

function createChildErrorResult(input: AgentRunInput, err: unknown): AgentRunResult {
  const message = err instanceof Error ? err.message : String(err);
  const dimId = resolveDimensionId(input);
  return {
    runId: `${dimId || 'child'}:error`,
    profileId: profileIdForResult(input),
    reply: message,
    status: 'error',
    phases: {
      error: message,
      ...(dimId ? { dimId } : {}),
    },
    toolCalls: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      iterations: 0,
      durationMs: 0,
    },
    diagnostics: null,
  };
}

function createChildAbortedResult(input: AgentRunInput): AgentRunResult {
  const dimId = resolveDimensionId(input);
  return {
    runId: `${dimId || 'child'}:aborted`,
    profileId: profileIdForResult(input),
    reply: 'child-run-aborted',
    status: 'aborted',
    phases: {
      aborted: true,
      ...(dimId ? { dimId } : {}),
    },
    toolCalls: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      iterations: 0,
      durationMs: 0,
    },
    diagnostics: null,
  };
}

function profileIdForResult(input: AgentRunInput) {
  if (input.profile.id) {
    return input.profile.id;
  }
  if ('preset' in input.profile && input.profile.preset) {
    return input.profile.preset;
  }
  if ('basePreset' in input.profile && input.profile.basePreset) {
    return input.profile.basePreset;
  }
  return 'unknown';
}

async function resolveLazyChildInput(plannedInput: AgentRunInput, parentInput: AgentRunInput) {
  const dimId = resolveDimensionId(plannedInput);
  const factory = dimId ? parentInput.context.childInputFactories?.[dimId] : undefined;
  if (!factory) {
    return plannedInput;
  }
  return factory({ plannedInput, parentInput });
}

function resolveConcurrency(concurrency: AgentConcurrencyPlan['concurrency']) {
  if (typeof concurrency === 'number') {
    return concurrency;
  }
  if (concurrency?.env) {
    const parsed = Number.parseInt(process.env[concurrency.env] || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : concurrency.default;
  }
  return 1;
}

function groupByTier(childInputs: AgentRunInput[]) {
  const groups = new Map<number, AgentRunInput[]>();
  for (const child of childInputs) {
    const tier = resolveTier(child);
    groups.set(tier, [...(groups.get(tier) || []), child]);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right).map(([, inputs]) => inputs);
}

function resolveTier(input: AgentRunInput) {
  const paramTier = input.params?.tier;
  if (typeof paramTier === 'number' && Number.isFinite(paramTier)) {
    return paramTier;
  }
  const metadataTier = input.message.metadata?.tier;
  if (typeof metadataTier === 'number' && Number.isFinite(metadataTier)) {
    return metadataTier;
  }
  return 0;
}

function resolveDimensionId(input: AgentRunInput) {
  const paramDimId = input.params?.dimId;
  if (typeof paramDimId === 'string' && paramDimId.trim()) {
    return paramDimId;
  }
  const metadataDimension = input.message.metadata?.dimension;
  if (typeof metadataDimension === 'string' && metadataDimension.trim()) {
    return metadataDimension;
  }
  return undefined;
}

function defaultMerge(results: AgentRunResult[], profile: CompiledAgentProfile): AgentRunResult {
  const hasError = results.some((result) => result.status === 'error');
  const hasAborted = results.some((result) => result.status === 'aborted');
  return {
    runId: `${profile.id}:parent`,
    profileId: profile.id,
    reply: results
      .map((result) => result.reply)
      .filter(Boolean)
      .join('\n\n'),
    status: hasError ? 'error' : hasAborted ? 'aborted' : 'success',
    phases: { childResults: results },
    toolCalls: results.flatMap((result) => result.toolCalls),
    usage: {
      inputTokens: results.reduce((sum, result) => sum + result.usage.inputTokens, 0),
      outputTokens: results.reduce((sum, result) => sum + result.usage.outputTokens, 0),
      iterations: results.reduce((sum, result) => sum + result.usage.iterations, 0),
      durationMs: results.reduce((sum, result) => sum + result.usage.durationMs, 0),
    },
    diagnostics: null,
  };
}

function partitionBootstrapSessionDimensions(
  input: AgentRunInput,
  profile: CompiledAgentProfile
): AgentRunInput[] {
  const dimensions = Array.isArray(input.params?.dimensions) ? input.params.dimensions : [];
  const baseParams = omitKeys(input.params || {}, ['dimensions', 'children']);
  const childProfileId = profile.concurrency?.childProfile || 'bootstrap-dimension';
  return dimensions.map((rawDimension, index) => {
    const dimension = toRecord(rawDimension);
    const dimId = stringValue(dimension.dimId) || stringValue(dimension.id) || `dimension-${index}`;
    const label = stringValue(dimension.label) || dimId;
    const childContext = input.context.childContexts?.[dimId] || {};
    const childMessage = toRecord(dimension.message);
    const childMetadata = toRecord(dimension.metadata);
    const childParams = toRecord(dimension.params);
    const tier = numberValue(dimension.tier);
    const profileRef = toProfileRef(dimension.profile) || { id: childProfileId };
    const promptContext = {
      ...(input.context.promptContext || {}),
      ...(childContext.promptContext || {}),
      ...toRecord(dimension.promptContext),
      dimId,
      dimensionId: dimId,
    };
    return {
      profile: profileRef,
      params: stripUndefined({
        ...baseParams,
        ...childParams,
        dimId,
        ...(tier !== undefined ? { tier } : {}),
      }),
      message: {
        role: (childMessage.role as AgentRunInput['message']['role']) || 'internal',
        content:
          stringValue(childMessage.content) ||
          stringValue(dimension.prompt) ||
          `Bootstrap dimension: ${label}`,
        history: Array.isArray(childMessage.history) ? childMessage.history : input.message.history,
        metadata: stripUndefined({
          ...(input.message.metadata || {}),
          ...childMetadata,
          ...(tier !== undefined ? { tier } : {}),
          dimension: dimId,
          phase: 'bootstrap-session-child',
        }),
        sessionId: stringValue(childMessage.sessionId) || input.message.sessionId,
      },
      context: stripUndefined({
        ...input.context,
        ...childContext,
        childContexts: undefined,
        childInputFactories: undefined,
        promptContext,
      }) as unknown as AgentRunContext,
      execution: input.execution,
      presentation: input.presentation,
    };
  });
}

function mergeBootstrapSessionResults(
  results: AgentRunResult[],
  input: AgentRunInput,
  profile: CompiledAgentProfile
): AgentRunResult {
  const dimensions = Array.isArray(input.params?.dimensions) ? input.params.dimensions : [];
  const dimensionIds = dimensions.map((dimension, index) => {
    const record = toRecord(dimension);
    return stringValue(record.dimId) || stringValue(record.id) || `dimension-${index}`;
  });
  return {
    ...defaultMerge(results, profile),
    phases: {
      childResults: results,
      dimensionResults: Object.fromEntries(
        results.map((result, index) => [dimensionIds[index] || `dimension-${index}`, result])
      ),
    },
  };
}

function toProfileRef(value: unknown): AgentProfileRef | AgentProfileOverride | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id === 'string' ||
    typeof value.preset === 'string' ||
    typeof value.basePreset === 'string'
  ) {
    return value as AgentProfileRef | AgentProfileOverride;
  }
  return null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function omitKeys(input: Record<string, unknown>, keys: string[]) {
  const skipped = new Set(keys);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !skipped.has(key)));
}

function stripUndefined<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export default AgentRunCoordinator;
