import { sopToCompactText } from '#domain/dimension/DimensionSop.js';
import type { ResponseBudget } from '#workflows/common-capabilities/agent-execution/mission-briefing/MissionBriefingProfiles.js';

interface CompressibleAstClass {
  file?: string | null;
  protocols?: string[];
}

interface CompressibleAstProtocol {
  name?: string;
  methodCount?: number;
  file?: string | null;
  conformers?: string[];
}

interface CompressibleDimensionTask {
  evidenceStarters?: unknown;
  analysisGuide?: unknown;
  submissionSpec?: {
    preSubmitChecklist?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface CompressibleBriefing {
  ast: {
    compressionLevel?: string;
    classes: CompressibleAstClass[];
    protocols: CompressibleAstProtocol[];
    categories?: unknown[];
    metrics?: {
      complexMethods?: unknown;
      longMethods?: unknown;
      [key: string]: unknown;
    } | null;
  };
  dependencyGraph?: { edges: unknown[] } | null;
  dimensions: CompressibleDimensionTask[];
  technologyStack?: unknown;
  meta?: {
    responseSizeKB?: number;
    compressionLevel?: string;
    warnings?: string[];
    [key: string]: unknown;
  };
}

export function applyBriefingCompressionPolicy<T extends CompressibleBriefing>(
  briefing: T,
  responseBudget: ResponseBudget
): T {
  const originalJson = JSON.stringify(briefing);
  const originalSizeKB = Math.round(originalJson.length / 1024);
  briefing.meta = {
    ...briefing.meta,
    responseSizeKB: originalSizeKB,
    compressionLevel: briefing.ast.compressionLevel || 'none',
  };

  if (originalJson.length <= responseBudget.limitBytes) {
    return briefing;
  }

  const dependencyGraph = briefing.dependencyGraph;
  if (dependencyGraph && dependencyGraph.edges.length > 30) {
    dependencyGraph.edges = dependencyGraph.edges.slice(0, 30);
  }
  if (briefing.ast.classes.length > 20) {
    briefing.ast.classes = briefing.ast.classes.slice(0, 20);
  }
  if (briefing.ast.protocols.length > 10) {
    briefing.ast.protocols = briefing.ast.protocols.slice(0, 10).map((protocol) => ({
      name: protocol.name,
      methodCount: protocol.methodCount,
    }));
  }

  for (const cls of briefing.ast.classes) {
    if ((cls.protocols?.length ?? 0) > 3) {
      cls.protocols = cls.protocols?.slice(0, 3);
    }
    delete cls.file;
  }
  for (const protocol of briefing.ast.protocols) {
    if ((protocol.conformers?.length ?? 0) > 3) {
      protocol.conformers = protocol.conformers?.slice(0, 3);
    }
    delete protocol.file;
  }
  if ((briefing.ast.categories?.length ?? 0) > 5) {
    briefing.ast.categories = briefing.ast.categories?.slice(0, 5);
  }
  if (briefing.ast.metrics?.complexMethods) {
    delete briefing.ast.metrics.complexMethods;
  }
  if (briefing.ast.metrics?.longMethods) {
    delete briefing.ast.metrics.longMethods;
  }

  const midSize = JSON.stringify(briefing).length;
  if (midSize <= responseBudget.limitBytes) {
    briefing.meta.responseSizeKB = Math.round(midSize / 1024);
    briefing.meta.compressionLevel = 'moderate';
  } else {
    for (const dimension of briefing.dimensions) {
      delete dimension.evidenceStarters;
    }
    briefing.technologyStack = null;
    for (const dimension of briefing.dimensions) {
      if (isRecord(dimension.analysisGuide)) {
        dimension.analysisGuide = sopToCompactText(dimension.analysisGuide);
      }
      if (dimension.submissionSpec?.preSubmitChecklist?.FAIL_EXAMPLES) {
        delete dimension.submissionSpec.preSubmitChecklist.FAIL_EXAMPLES;
      }
    }
    const newSize = JSON.stringify(briefing).length;
    briefing.meta.responseSizeKB = Math.round(newSize / 1024);
    briefing.meta.compressionLevel = 'aggressive';
  }

  briefing.meta.warnings = briefing.meta.warnings || [];
  briefing.meta.warnings.push(
    `Response compressed from ${originalSizeKB}KB to ${briefing.meta.responseSizeKB}KB`
  );

  return briefing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
