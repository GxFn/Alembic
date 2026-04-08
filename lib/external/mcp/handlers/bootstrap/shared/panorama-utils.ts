/**
 * Panorama summarization helper for internal agent responses.
 *
 * Extracted from bootstrap-internal.ts.
 * Note: MissionBriefingBuilder has its own typed version for the MissionBriefing interface.
 *
 * @module bootstrap/shared/panorama-utils
 */

interface PanoramaModule {
  name?: string;
  layer?: string;
  role?: string;
  fanIn?: number;
  fanOut?: number;
}

interface PanoramaLayerLevel {
  name: string;
  modules: string[];
}

interface PanoramaGap {
  module: string;
  suggestedFocus: string[];
}

interface PanoramaCycle {
  modules: string[];
}

/**
 * Summarize PanoramaResult into a compact internal-agent-friendly shape.
 *
 * Returns the top layers, coupling hotspots, cyclic dependencies, and knowledge gaps.
 */
export function summarizePanorama(panoramaResult: unknown): Record<string, unknown> | null {
  if (!panoramaResult || typeof panoramaResult !== 'object') {
    return null;
  }

  const pr = panoramaResult as Record<string, unknown>;
  const moduleMap = pr.modules as Map<string, PanoramaModule> | undefined;
  const layers = pr.layers as { levels?: PanoramaLayerLevel[] } | undefined;
  const gaps = (pr.gaps as PanoramaGap[] | undefined) ?? [];
  const cycles = (pr.cycles as PanoramaCycle[] | undefined) ?? [];

  // Coupling hotspots: fanIn >= 10 or fanOut >= 10
  const couplingHotspots: Array<{ name: string; fanIn: number; fanOut: number }> = [];
  if (moduleMap) {
    const entries: PanoramaModule[] =
      moduleMap instanceof Map
        ? ([...moduleMap.values()] as PanoramaModule[])
        : (Object.values(moduleMap) as PanoramaModule[]);
    for (const mod of entries) {
      if ((mod.fanIn || 0) >= 10 || (mod.fanOut || 0) >= 10) {
        couplingHotspots.push({
          name: mod.name || '',
          fanIn: mod.fanIn || 0,
          fanOut: mod.fanOut || 0,
        });
      }
    }
  }

  return {
    layers: layers?.levels?.slice(0, 10) ?? [],
    couplingHotspots: couplingHotspots.slice(0, 10),
    cyclicDependencies: cycles.slice(0, 10).map((c) => c.modules),
    knowledgeGaps: gaps.slice(0, 20).map((g) => ({
      module: g.module,
      suggestedFocus: g.suggestedFocus,
    })),
  };
}
