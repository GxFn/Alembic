import type {
  KnowledgeEvidencePack,
  ScanBudget,
  ScanDepth,
  ScanMode,
} from '#workflows/scan/ScanTypes.js';

interface ResolvedEvidenceBudget {
  maxFiles: number;
  maxFileChars: number;
  maxKnowledgeItems: number;
  maxGraphEdges: number;
  maxTotalChars: number;
}

const MODE_DEFAULTS: Record<ScanMode, ResolvedEvidenceBudget> = {
  'cold-start': {
    maxFiles: 160,
    maxFileChars: 2_000,
    maxKnowledgeItems: 80,
    maxGraphEdges: 160,
    maxTotalChars: 120_000,
  },
  'deep-mining': {
    maxFiles: 80,
    maxFileChars: 3_000,
    maxKnowledgeItems: 60,
    maxGraphEdges: 120,
    maxTotalChars: 100_000,
  },
  'incremental-correction': {
    maxFiles: 32,
    maxFileChars: 1_600,
    maxKnowledgeItems: 30,
    maxGraphEdges: 60,
    maxTotalChars: 48_000,
  },
  maintenance: {
    maxFiles: 12,
    maxFileChars: 800,
    maxKnowledgeItems: 20,
    maxGraphEdges: 30,
    maxTotalChars: 24_000,
  },
};

const DEPTH_MULTIPLIERS: Record<ScanDepth, number> = {
  light: 0.5,
  standard: 1,
  deep: 1.4,
  exhaustive: 2,
};

export class EvidenceBudgeter {
  resolve(
    mode: ScanMode,
    depth: ScanDepth = 'standard',
    budget: ScanBudget = {}
  ): ResolvedEvidenceBudget {
    const defaults = MODE_DEFAULTS[mode];
    const multiplier = DEPTH_MULTIPLIERS[depth];
    return {
      maxFiles: budget.maxFiles ?? Math.ceil(defaults.maxFiles * multiplier),
      maxFileChars: budget.maxFileChars ?? defaults.maxFileChars,
      maxKnowledgeItems:
        budget.maxKnowledgeItems ?? Math.ceil(defaults.maxKnowledgeItems * multiplier),
      maxGraphEdges: budget.maxGraphEdges ?? Math.ceil(defaults.maxGraphEdges * multiplier),
      maxTotalChars: budget.maxTotalChars ?? Math.ceil(defaults.maxTotalChars * multiplier),
    };
  }

  apply(
    pack: KnowledgeEvidencePack,
    mode: ScanMode,
    depth: ScanDepth = 'standard',
    budget: ScanBudget = {}
  ): KnowledgeEvidencePack {
    const resolved = this.resolve(mode, depth, budget);
    const warnings = [...pack.diagnostics.warnings];
    let truncated = pack.diagnostics.truncated;

    const files = pack.files.slice(0, resolved.maxFiles).map((file) => {
      const content = truncateText(file.content, resolved.maxFileChars);
      const excerpt = truncateText(file.excerpt, resolved.maxFileChars);
      if (content.wasTruncated || excerpt.wasTruncated) {
        truncated = true;
      }
      return {
        ...file,
        content: content.value,
        excerpt: excerpt.value,
      };
    });
    if (pack.files.length > files.length) {
      truncated = true;
      warnings.push(`files truncated: ${pack.files.length} -> ${files.length}`);
    }

    const knowledge = pack.knowledge.slice(0, resolved.maxKnowledgeItems);
    if (pack.knowledge.length > knowledge.length) {
      truncated = true;
      warnings.push(`knowledge truncated: ${pack.knowledge.length} -> ${knowledge.length}`);
    }

    const graphEdges = pack.graph.edges.slice(0, resolved.maxGraphEdges);
    if (pack.graph.edges.length > graphEdges.length) {
      truncated = true;
      warnings.push(`graph edges truncated: ${pack.graph.edges.length} -> ${graphEdges.length}`);
    }

    const graph = {
      entities: pack.graph.entities,
      edges: graphEdges,
    };

    const sized = {
      ...pack,
      files,
      knowledge,
      graph,
      diagnostics: {
        ...pack.diagnostics,
        truncated,
        warnings,
      },
    };

    const totalChars = estimatePackChars(sized);
    if (totalChars <= resolved.maxTotalChars) {
      return sized;
    }

    const keepRatio = Math.max(resolved.maxTotalChars / totalChars, 0.1);
    const maxFiles = Math.max(1, Math.floor(sized.files.length * keepRatio));
    const maxKnowledgeItems = Math.max(1, Math.floor(sized.knowledge.length * keepRatio));
    return {
      ...sized,
      files: sized.files.slice(0, maxFiles),
      knowledge: sized.knowledge.slice(0, maxKnowledgeItems),
      diagnostics: {
        ...sized.diagnostics,
        truncated: true,
        warnings: [
          ...sized.diagnostics.warnings,
          `total chars truncated: ${totalChars} -> budget ${resolved.maxTotalChars}`,
        ],
      },
    };
  }
}

function truncateText(
  value: string | undefined,
  maxChars: number
): { value?: string; wasTruncated: boolean } {
  if (!value || value.length <= maxChars) {
    return { value, wasTruncated: false };
  }
  return { value: value.slice(0, maxChars), wasTruncated: true };
}

function estimatePackChars(pack: KnowledgeEvidencePack): number {
  return (
    pack.files.reduce(
      (total, file) => total + (file.content?.length ?? 0) + (file.excerpt?.length ?? 0),
      0
    ) +
    pack.knowledge.reduce(
      (total, item) =>
        total +
        item.title.length +
        (item.description?.length ?? 0) +
        (item.content?.markdown?.length ?? 0) +
        (item.content?.rationale?.length ?? 0) +
        (item.content?.coreCode?.length ?? 0),
      0
    )
  );
}
