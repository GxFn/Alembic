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

export function summarizePanorama(panoramaResult: unknown): Record<string, unknown> | null {
  if (!panoramaResult || typeof panoramaResult !== 'object') {
    return null;
  }

  const result = panoramaResult as Record<string, unknown>;
  const moduleMap = result.modules as Map<string, PanoramaModule> | undefined;
  const layers = result.layers as { levels?: PanoramaLayerLevel[] } | undefined;
  const gaps = (result.gaps as PanoramaGap[] | undefined) ?? [];
  const cycles = (result.cycles as PanoramaCycle[] | undefined) ?? [];
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
    cyclicDependencies: cycles.slice(0, 10).map((cycle) => cycle.modules),
    knowledgeGaps: gaps.slice(0, 20).map((gap) => ({
      module: gap.module,
      suggestedFocus: gap.suggestedFocus,
    })),
  };
}
