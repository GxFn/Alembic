import type { EngineeringCodeGraphReader } from "../code/EngineeringCodeGraphModel.js";
import type { EngineeringRelationshipGraph } from "../foundation/EngineeringCoreTypes.js";
import type {
  EngineeringCallFlowItem,
  EngineeringCallFlowSummary,
  EngineeringDimensionAnalysis,
  EngineeringDimensionWeakArea,
  EngineeringHealthDimension,
  EngineeringModuleCallFlow,
  EngineeringPanoramaGap,
  EngineeringPanoramaGapPriority,
  EngineeringPanoramaHealthSummary,
  EngineeringPanoramaModuleDetail,
  EngineeringPanoramaRefinement,
  EngineeringRecipeCoverageFact,
} from "./EngineeringPanoramaTypes.js";

export interface EngineeringDimensionAnalyzerInput {
  readonly modules: readonly EngineeringPanoramaModuleDetail[];
  readonly relationships: EngineeringRelationshipGraph;
  readonly refinement: EngineeringPanoramaRefinement;
  readonly codeGraph: EngineeringCodeGraphReader;
  readonly recipeFacts?: readonly EngineeringRecipeCoverageFact[];
}

export interface EngineeringDimensionAnalyzerResult {
  readonly dimensions: EngineeringDimensionAnalysis;
  readonly gaps: readonly EngineeringPanoramaGap[];
  readonly health: EngineeringPanoramaHealthSummary;
  readonly callFlow: EngineeringCallFlowSummary;
}

interface DimensionDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly weight: number;
  readonly relatedRoles: readonly string[];
  readonly suggestedTopics: readonly string[];
}

const DIMENSIONS: readonly DimensionDefinition[] = [
  {
    id: "module-structure",
    name: "Module Structure",
    description: "Modules have source ownership, tests or docs, and clear local boundaries.",
    weight: 0.2,
    relatedRoles: [],
    suggestedTopics: ["module ownership", "target boundaries", "source layout"],
  },
  {
    id: "language-stack",
    name: "Language Stack",
    description: "Languages and runtimes are visible enough to guide engineering conventions.",
    weight: 0.12,
    relatedRoles: [],
    suggestedTopics: ["language conventions", "runtime setup", "build toolchain"],
  },
  {
    id: "architecture-boundaries",
    name: "Architecture Boundaries",
    description: "Layers, cycles, and role boundaries are explicit and conflict-light.",
    weight: 0.24,
    relatedRoles: ["app", "core", "feature", "service", "ui"],
    suggestedTopics: ["layer policy", "dependency direction", "cycle remediation"],
  },
  {
    id: "dependency-health",
    name: "Dependency Health",
    description: "External dependency hotspots and fan-out risks are known.",
    weight: 0.16,
    relatedRoles: ["networking", "service", "storage"],
    suggestedTopics: ["dependency ownership", "third-party risk", "facade boundaries"],
  },
  {
    id: "testing-quality",
    name: "Testing Quality",
    description: "Test modules and test files cover meaningful implementation modules.",
    weight: 0.16,
    relatedRoles: ["test"],
    suggestedTopics: ["test strategy", "integration coverage", "fixture ownership"],
  },
  {
    id: "documentation-knowledge",
    name: "Documentation Knowledge",
    description: "Docs and recipes explain important module and architecture decisions.",
    weight: 0.12,
    relatedRoles: [],
    suggestedTopics: ["architecture decision records", "module guides", "recipe coverage"],
  },
  {
    id: "recipe-coverage",
    name: "Recipe Coverage",
    description:
      "Recipe facts cover active project dimensions; absent DB facts remain a placeholder.",
    weight: 0.12,
    relatedRoles: [],
    suggestedTopics: ["coding standards recipes", "architecture recipes", "testing recipes"],
  },
];

export class EngineeringDimensionAnalyzer {
  analyze(input: EngineeringDimensionAnalyzerInput): EngineeringDimensionAnalyzerResult {
    const recipeFacts = input.recipeFacts ?? [];
    const recipeCounts = classifyRecipes(recipeFacts);
    const moduleCoverage = analyzeModuleCoverage(input.modules);
    const languageCoverage = analyzeLanguageCoverage(input.modules);
    const architectureCoverage = {
      layerCount: input.refinement.layers.length,
      cycleCount: input.refinement.cycles.length,
      layerViolationCount: input.refinement.layerViolations.length,
      externalDependencyCount: input.refinement.externalDeps.length,
      configBasedLayers: input.refinement.configBasedLayers,
    };

    const dimensions = DIMENSIONS.map((definition) =>
      scoreDimension(definition, {
        recipeCount: recipeCounts.get(definition.id)?.count ?? 0,
        topRecipes: recipeCounts.get(definition.id)?.titles ?? [],
        modules: input.modules,
        moduleCoverage,
        languageCount: languageCoverage.languages.length,
        architectureCoverage,
      }),
    );
    const coveredDimensions = dimensions.filter((dimension) => dimension.recipeCount > 0).length;
    const totalWeight = DIMENSIONS.reduce((total, dimension) => total + dimension.weight, 0);
    const overallScore =
      totalWeight === 0
        ? 0
        : Math.round(
            dimensions.reduce((total, dimension, index) => {
              return total + dimension.score * (DIMENSIONS[index]?.weight ?? 0);
            }, 0) / totalWeight,
          );
    const recipeCoverage = {
      source: recipeFacts.length > 0 ? ("input-facts" as const) : ("placeholder" as const),
      totalRecipes: recipeFacts.length,
      coveredDimensions,
      totalDimensions: DIMENSIONS.length,
      ratio: DIMENSIONS.length === 0 ? 0 : round(coveredDimensions / DIMENSIONS.length),
      reason:
        recipeFacts.length > 0
          ? "Recipe coverage was computed from explicit input facts."
          : "No repository or recipe DB is connected; coverage is an explicit placeholder.",
    };
    const weakAreas = detectWeakAreas(dimensions, input.modules);
    const dimensionAnalysis: EngineeringDimensionAnalysis = {
      dimensions,
      overallScore,
      moduleCoverage,
      languageCoverage,
      architectureCoverage,
      recipeCoverage,
      weakAreas,
    };
    const gaps = buildGaps(input, dimensionAnalysis);
    const health = buildHealth(dimensionAnalysis, gaps);
    const callFlow = summarizeCallFlow(input);

    return { dimensions: dimensionAnalysis, gaps, health, callFlow };
  }
}

function analyzeModuleCoverage(
  modules: readonly EngineeringPanoramaModuleDetail[],
): EngineeringDimensionAnalysis["moduleCoverage"] {
  const concrete = modules.filter((module) => module.kind !== "external");
  const weakModules = concrete
    .filter(
      (module) =>
        module.sourceFileCount === 0 || (module.testFileCount === 0 && module.docFileCount === 0),
    )
    .map((module) => module.name)
    .sort();
  const coveredModules = concrete.length - weakModules.length;
  return {
    totalModules: concrete.length,
    coveredModules,
    weakModules,
    ratio: concrete.length === 0 ? 0 : round(coveredModules / concrete.length),
  };
}

function analyzeLanguageCoverage(
  modules: readonly EngineeringPanoramaModuleDetail[],
): EngineeringDimensionAnalysis["languageCoverage"] {
  const counts = new Map<string, number>();
  for (const module of modules) {
    for (const language of module.languages) {
      counts.set(language, (counts.get(language) ?? 0) + module.sourceFileCount);
    }
  }
  const languages = [...counts.entries()]
    .map(([name, fileCount]) => ({ name, fileCount }))
    .sort((left, right) => right.fileCount - left.fileCount || left.name.localeCompare(right.name));
  return {
    languages,
    primaryLanguages: languages.slice(0, 3).map((language) => language.name),
    mixedLanguage: languages.length > 1,
  };
}

function scoreDimension(
  definition: DimensionDefinition,
  facts: {
    readonly recipeCount: number;
    readonly topRecipes: readonly string[];
    readonly modules: readonly EngineeringPanoramaModuleDetail[];
    readonly moduleCoverage: EngineeringDimensionAnalysis["moduleCoverage"];
    readonly languageCount: number;
    readonly architectureCoverage: EngineeringDimensionAnalysis["architectureCoverage"];
  },
): EngineeringHealthDimension {
  const recipeBonus = Math.min(20, facts.recipeCount * 10);
  let baseScore = 0;
  switch (definition.id) {
    case "module-structure":
      baseScore = facts.moduleCoverage.ratio * 80;
      break;
    case "language-stack":
      baseScore = facts.languageCount > 0 ? 75 : 0;
      break;
    case "architecture-boundaries":
      baseScore =
        80 -
        facts.architectureCoverage.cycleCount * 25 -
        facts.architectureCoverage.layerViolationCount * 20 +
        (facts.architectureCoverage.layerCount > 0 ? 10 : 0);
      break;
    case "dependency-health":
      baseScore = 80 - externalHotspotCount(facts.modules) * 15;
      break;
    case "testing-quality":
      baseScore = testCoverageScore(facts.modules);
      break;
    case "documentation-knowledge":
      baseScore = docCoverageScore(facts.modules);
      break;
    case "recipe-coverage":
      baseScore = facts.recipeCount > 0 ? Math.min(80, facts.recipeCount * 20) : 0;
      break;
  }
  const score = clamp(Math.round(baseScore + recipeBonus), 0, 100);
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    score,
    status: scoreStatus(score, facts.recipeCount),
    level: radarLevel(score),
    recipeCount: facts.recipeCount,
    affectedModules: affectedModules(definition, facts.modules),
    topRecipes: facts.topRecipes.slice(0, 3),
  };
}

function classifyRecipes(
  recipes: readonly EngineeringRecipeCoverageFact[],
): Map<string, { count: number; titles: string[] }> {
  const result = new Map<string, { count: number; titles: string[] }>();
  for (const recipe of recipes) {
    const dimensionId = resolveRecipeDimensionId(recipe);
    const entry = result.get(dimensionId) ?? { count: 0, titles: [] };
    entry.count += 1;
    if (entry.titles.length < 3) {
      entry.titles.push(recipe.title);
    }
    result.set(dimensionId, entry);
  }
  return result;
}

function resolveRecipeDimensionId(recipe: EngineeringRecipeCoverageFact): string {
  if (recipe.dimensionId && DIMENSIONS.some((dimension) => dimension.id === recipe.dimensionId)) {
    return recipe.dimensionId;
  }
  const text = [recipe.category, recipe.knowledgeType, recipe.topicHint, recipe.kind, recipe.title]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/test|qa|fixture|mock/.test(text)) {
    return "testing-quality";
  }
  if (/doc|readme|knowledge|adr|recipe/.test(text)) {
    return "documentation-knowledge";
  }
  if (/layer|architecture|boundary|cycle|dependency direction/.test(text)) {
    return "architecture-boundaries";
  }
  if (/dependency|third.?party|package|external/.test(text)) {
    return "dependency-health";
  }
  if (/language|runtime|framework|stack/.test(text)) {
    return "language-stack";
  }
  if (/module|target|ownership|layout/.test(text)) {
    return "module-structure";
  }
  return "recipe-coverage";
}

function detectWeakAreas(
  dimensions: readonly EngineeringHealthDimension[],
  modules: readonly EngineeringPanoramaModuleDetail[],
): EngineeringDimensionWeakArea[] {
  const roles = new Set(modules.map((module) => module.role));
  const areas = dimensions.flatMap((dimension) => {
    if (dimension.status !== "missing" && dimension.status !== "weak") {
      return [];
    }
    const definition = DIMENSIONS.find((candidate) => candidate.id === dimension.id);
    if (!definition) {
      return [];
    }
    const roleMatch =
      definition.relatedRoles.length === 0 ||
      definition.relatedRoles.some((role) => roles.has(role));
    const priority: EngineeringPanoramaGapPriority =
      dimension.status === "missing" && (definition.weight >= 0.16 || roleMatch)
        ? "high"
        : dimension.status === "missing"
          ? "medium"
          : "low";
    return [
      {
        id: `dimension:${dimension.id}`,
        dimension: dimension.id,
        status: dimension.status,
        priority,
        reason: `${dimension.name} is ${dimension.status} (${dimension.score}/100).`,
        affectedModules: dimension.affectedModules,
        suggestedTopics: definition.suggestedTopics,
      },
    ];
  });
  return areas.sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority));
}

function buildGaps(
  input: EngineeringDimensionAnalyzerInput,
  dimensions: EngineeringDimensionAnalysis,
): readonly EngineeringPanoramaGap[] {
  const gaps: EngineeringPanoramaGap[] = [];

  for (const cycle of input.refinement.cycles) {
    gaps.push({
      id: `cycle:${cycle.cycle.join(">")}`,
      type: "architecture-cycle",
      priority: cycle.severity === "error" || cycle.cycle.length > 3 ? "high" : "medium",
      title: "Module cycle detected",
      reason: `Cycle crosses ${cycle.cycle.length} modules.`,
      evidence: cycle.cycle,
      scoreImpact: cycle.severity === "error" ? 18 : 12,
    });
  }

  for (const violation of input.refinement.layerViolations) {
    gaps.push({
      id: `layer:${violation.from}>${violation.to}`,
      type: "layer-conflict",
      priority: "high",
      title: "Layer direction conflict",
      reason: `${violation.from} depends on ${violation.to} across disallowed layer direction.`,
      module: violation.from,
      evidence: [`${violation.fromLayer}->${violation.toLayer}`, violation.relation],
      scoreImpact: 15,
    });
  }

  for (const dependency of input.refinement.externalDeps.filter((dep) => dep.fanIn >= 3)) {
    gaps.push({
      id: `external:${dependency.name}`,
      type: "external-dependency-hotspot",
      priority: dependency.fanIn >= 5 ? "high" : "medium",
      title: "External dependency hotspot",
      reason: `${dependency.name} is depended on by ${dependency.fanIn} modules.`,
      evidence: dependency.dependedBy,
      scoreImpact: dependency.fanIn >= 5 ? 12 : 8,
    });
  }

  for (const module of input.modules) {
    if (module.roleResolution !== "uncertain" && module.roleResolution !== "fallback") {
      continue;
    }
    gaps.push({
      id: `role:${module.name}`,
      type: "role-uncertainty",
      priority: module.roleResolution === "fallback" ? "high" : "medium",
      title: "Module role needs confirmation",
      reason: `${module.name} role resolution is ${module.roleResolution}.`,
      module: module.name,
      evidence: [...module.uncertainSignals, ...module.fallbackSignals],
      scoreImpact: module.roleResolution === "fallback" ? 10 : 6,
    });
  }

  for (const moduleName of dimensions.moduleCoverage.weakModules) {
    gaps.push({
      id: `coverage:${moduleName}`,
      type: "structural-coverage",
      priority: "medium",
      title: "Weak module structural coverage",
      reason: `${moduleName} lacks source ownership, tests, or docs in the pure file facts.`,
      module: moduleName,
      evidence: [moduleName],
      scoreImpact: 5,
    });
  }

  for (const weakArea of dimensions.weakAreas) {
    if (weakArea.dimension !== "recipe-coverage" && weakArea.status !== "missing") {
      continue;
    }
    gaps.push({
      id: weakArea.id,
      type: "recipe-coverage",
      priority: weakArea.priority,
      title: "Recipe dimension coverage gap",
      reason: weakArea.reason,
      dimension: weakArea.dimension,
      evidence: weakArea.suggestedTopics,
      scoreImpact: weakArea.priority === "high" ? 12 : 6,
    });
  }

  return gaps.sort(
    (left, right) =>
      priorityRank(left.priority) - priorityRank(right.priority) ||
      right.scoreImpact - left.scoreImpact ||
      left.id.localeCompare(right.id),
  );
}

function buildHealth(
  dimensions: EngineeringDimensionAnalysis,
  gaps: readonly EngineeringPanoramaGap[],
): EngineeringPanoramaHealthSummary {
  const penalty = gaps.reduce((total, gap) => total + gap.scoreImpact, 0);
  const score = clamp(Math.round(dimensions.overallScore - penalty), 0, 100);
  const status =
    score >= 80 ? "healthy" : score >= 60 ? "watch" : score >= 35 ? "risk" : "critical";
  return {
    status,
    score,
    reason: `${gaps.length} engineering panorama gap(s) detected; recipe coverage source is ${dimensions.recipeCoverage.source}.`,
    gaps,
  };
}

function summarizeCallFlow(input: EngineeringDimensionAnalyzerInput): EngineeringCallFlowSummary {
  const fileToModule = new Map<string, string>();
  for (const module of input.modules) {
    for (const file of module.files) {
      fileToModule.set(file, module.name);
    }
  }
  const readableCodeGraph = input.codeGraph as Partial<EngineeringCodeGraphReader>;
  const callEdges = readableCodeGraph.getCallGraphEdges?.() ?? [];
  const dataEdges = readableCodeGraph.getDataFlowEdges?.() ?? [];
  const relationshipCalls = input.relationships.moduleEdges.filter(
    (edge) => edge.source === "call" || edge.relation === "calls",
  );
  const relationshipDataFlows = input.relationships.moduleEdges.filter(
    (edge) => edge.source === "data_flow" || edge.relation === "data_flow",
  );

  const called = new Map<string, { count: number; modules: Set<string> }>();
  const callers = new Map<string, { count: number; modules: Set<string> }>();
  for (const edge of callEdges) {
    addCallItem(called, edge.callee, moduleForFile(edge.targetFilePath, fileToModule));
    addCallItem(
      callers,
      edge.caller,
      moduleForFile(edge.sourceFilePath ?? edge.filePath, fileToModule),
    );
  }

  const dataSources = new Map<string, { count: number; modules: Set<string> }>();
  const dataSinks = new Map<string, { count: number; modules: Set<string> }>();
  for (const edge of dataEdges) {
    addCallItem(
      dataSources,
      edge.from || edge.source || "(unknown)",
      moduleForFile(edge.filePath, fileToModule),
    );
    addCallItem(
      dataSinks,
      edge.to || edge.sink || "(unknown)",
      moduleForFile(edge.filePath, fileToModule),
    );
  }

  const moduleFlows = summarizeModuleFlows(relationshipCalls, relationshipDataFlows);
  const incomingSymbols = new Set(callEdges.map((edge) => edge.callee));
  const entryPoints = [...callers.entries()]
    .filter(([id]) => !incomingSymbols.has(id))
    .map(([id, item]) => toCallFlowItem(id, item))
    .sort(sortCallFlowItems)
    .slice(0, 20);

  return {
    edgeCounts: {
      calls: callEdges.length,
      dataFlows: dataEdges.length,
      relationshipCalls: relationshipCalls.length,
      relationshipDataFlows: relationshipDataFlows.length,
    },
    topCalled: [...called.entries()]
      .map(([id, item]) => toCallFlowItem(id, item))
      .sort(sortCallFlowItems)
      .slice(0, 10),
    entryPoints,
    dataProducers: [...dataSources.entries()]
      .map(([id, item]) => toCallFlowItem(id, item))
      .sort(sortCallFlowItems)
      .slice(0, 10),
    dataConsumers: [...dataSinks.entries()]
      .map(([id, item]) => toCallFlowItem(id, item))
      .sort(sortCallFlowItems)
      .slice(0, 10),
    moduleFlows,
  };
}

function summarizeModuleFlows(
  calls: readonly { readonly from: string; readonly to: string; readonly weight: number }[],
  dataFlows: readonly { readonly from: string; readonly to: string; readonly weight: number }[],
): readonly EngineeringModuleCallFlow[] {
  const flows = new Map<
    string,
    { count: number; weight: number; from: string; to: string; relation: "calls" | "data_flow" }
  >();
  for (const edge of calls) {
    addModuleFlow(flows, edge.from, edge.to, "calls", edge.weight);
  }
  for (const edge of dataFlows) {
    addModuleFlow(flows, edge.from, edge.to, "data_flow", edge.weight);
  }
  return [...flows.values()]
    .map((flow) => ({ ...flow, weight: round(flow.weight) }))
    .sort((left, right) => right.count - left.count || left.from.localeCompare(right.from));
}

function addModuleFlow(
  flows: Map<
    string,
    { count: number; weight: number; from: string; to: string; relation: "calls" | "data_flow" }
  >,
  from: string,
  to: string,
  relation: "calls" | "data_flow",
  weight: number,
): void {
  const key = `${from}\u0000${to}\u0000${relation}`;
  const current = flows.get(key) ?? { from, to, relation, count: 0, weight: 0 };
  current.count += 1;
  current.weight += weight;
  flows.set(key, current);
}

function addCallItem(
  target: Map<string, { count: number; modules: Set<string> }>,
  id: string,
  moduleName: string | null,
): void {
  if (!id) {
    return;
  }
  const current = target.get(id) ?? { count: 0, modules: new Set<string>() };
  current.count += 1;
  if (moduleName) {
    current.modules.add(moduleName);
  }
  target.set(id, current);
}

function toCallFlowItem(
  id: string,
  item: { readonly count: number; readonly modules: ReadonlySet<string> },
): EngineeringCallFlowItem {
  return { id, count: item.count, modules: [...item.modules].sort() };
}

function moduleForFile(
  filePath: string | null | undefined,
  fileToModule: ReadonlyMap<string, string>,
): string | null {
  return filePath ? (fileToModule.get(filePath) ?? null) : null;
}

function sortCallFlowItems(left: EngineeringCallFlowItem, right: EngineeringCallFlowItem): number {
  return right.count - left.count || left.id.localeCompare(right.id);
}

function affectedModules(
  definition: DimensionDefinition,
  modules: readonly EngineeringPanoramaModuleDetail[],
): readonly string[] {
  if (definition.relatedRoles.length === 0) {
    return modules.map((module) => module.name).sort();
  }
  return modules
    .filter((module) => definition.relatedRoles.includes(module.role))
    .map((module) => module.name)
    .sort();
}

function externalHotspotCount(modules: readonly EngineeringPanoramaModuleDetail[]): number {
  return modules.reduce(
    (total, module) =>
      total + module.externalDeps.filter((dependency) => dependency.fanIn >= 3).length,
    0,
  );
}

function testCoverageScore(modules: readonly EngineeringPanoramaModuleDetail[]): number {
  const sourceModules = modules.filter(
    (module) => module.sourceFileCount > 0 && module.role !== "test",
  );
  if (sourceModules.length === 0) {
    return 0;
  }
  const withTests = sourceModules.filter((module) => module.testFileCount > 0).length;
  const dedicatedTests = modules.some(
    (module) => module.role === "test" || module.testFileCount > 0,
  )
    ? 15
    : 0;
  return Math.min(100, Math.round((withTests / sourceModules.length) * 85 + dedicatedTests));
}

function docCoverageScore(modules: readonly EngineeringPanoramaModuleDetail[]): number {
  if (modules.length === 0) {
    return 0;
  }
  const documented = modules.filter((module) => module.docFileCount > 0).length;
  return Math.round((documented / modules.length) * 100);
}

function scoreStatus(score: number, recipeCount: number): EngineeringHealthDimension["status"] {
  if (score >= 80 || recipeCount >= 5) {
    return "strong";
  }
  if (score >= 50 || recipeCount >= 2) {
    return "adequate";
  }
  if (score > 0 || recipeCount === 1) {
    return "weak";
  }
  return "missing";
}

function radarLevel(score: number): EngineeringHealthDimension["level"] {
  if (score >= 80) {
    return "adopt";
  }
  if (score >= 40) {
    return "trial";
  }
  if (score > 0) {
    return "assess";
  }
  return "hold";
}

function priorityRank(priority: EngineeringPanoramaGapPriority): number {
  return { high: 0, medium: 1, low: 2 }[priority];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
