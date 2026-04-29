import Logger from '#infra/logging/Logger.js';
import type { DimensionCandidateData } from '#workflows/capabilities/execution/internal-agent/consumers/BootstrapDimensionConsumer.js';

const logger = Logger.getInstance();

export interface BootstrapCandidateRelation {
  title: unknown;
  relations: unknown;
}

interface CodeEntityGraphLike {
  populateFromCandidateRelations(
    candidates: BootstrapCandidateRelation[]
  ): Promise<{ edgesCreated: number; durationMs: number }>;
}

type CodeEntityGraphConstructor = new (
  entityRepo: unknown,
  edgeRepo: unknown,
  options: { projectRoot: string; logger: typeof logger }
) => CodeEntityGraphLike;

export interface ConsumeBootstrapCandidateRelationsOptions {
  ctx: { container: { get(name: string): unknown } };
  projectRoot: string;
  dimensionCandidates: Record<string, DimensionCandidateData>;
  getCodeEntityGraphClass?: () => Promise<CodeEntityGraphConstructor>;
}

export async function consumeBootstrapCandidateRelations({
  ctx,
  projectRoot,
  dimensionCandidates,
  getCodeEntityGraphClass = defaultGetCodeEntityGraphClass,
}: ConsumeBootstrapCandidateRelationsOptions) {
  try {
    const entityRepo = ctx.container.get('codeEntityRepository');
    const edgeRepo = ctx.container.get('knowledgeEdgeRepository');
    if (!entityRepo || !edgeRepo) {
      return null;
    }

    const allCandidates = extractBootstrapCandidateRelations(dimensionCandidates);
    if (allCandidates.length === 0) {
      return null;
    }

    const CodeEntityGraph = await getCodeEntityGraphClass();
    const graph = new CodeEntityGraph(entityRepo, edgeRepo, { projectRoot, logger });
    const relResult = await graph.populateFromCandidateRelations(allCandidates);
    logger.info(
      `[Insight-v3] Code Entity Graph relations: ${relResult.edgesCreated} edges from ${allCandidates.length} candidates (${relResult.durationMs}ms)`
    );
    return {
      ...relResult,
      candidates: allCandidates.length,
    };
  } catch (cegErr: unknown) {
    logger.warn(
      `[Insight-v3] Code Entity Graph relations failed (non-blocking): ${cegErr instanceof Error ? cegErr.message : String(cegErr)}`
    );
    return null;
  }
}

export function extractBootstrapCandidateRelations(
  dimensionCandidates: Record<string, DimensionCandidateData>
): BootstrapCandidateRelation[] {
  const allCandidates: BootstrapCandidateRelation[] = [];
  for (const dimData of Object.values(dimensionCandidates)) {
    const toolCalls = dimData?.producerResult?.toolCalls || [];
    for (const toolCall of toolCalls) {
      const toolName = toolCall.tool || toolCall.name;
      if (toolName !== 'submit_knowledge' && toolName !== 'submit_with_check') {
        continue;
      }
      const params = toolCall.params || toolCall.args || {};
      if (params.title) {
        allCandidates.push({
          title: params.title,
          relations: params.relations || null,
        });
      }
    }
  }
  return allCandidates;
}

async function defaultGetCodeEntityGraphClass() {
  const { CodeEntityGraph } = await import('#service/knowledge/CodeEntityGraph.js');
  return CodeEntityGraph as CodeEntityGraphConstructor;
}
