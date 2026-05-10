import type { RecipeMarkdownFileIndex } from "../data/index.js";
import type {
  DimensionLensActivation,
  EvidencePackage,
  Recipe,
  RecipeEdge,
  SourceRef,
} from "../knowledge/index.js";
import type { CompileArtifacts, CompileArtifactWriter } from "./CompileArtifactWriter.js";
import type { CompileReport } from "./CompileReport.js";
import { CompileReportBuilder } from "./CompileReport.js";
import { DimensionLensPolicy } from "./DimensionLensPolicy.js";
import { RecipeRelationMiner } from "./RecipeRelationMiner.js";
import {
  SourceRefFreshnessCheck,
  type SourceRefFreshnessFinding,
} from "./SourceRefFreshnessCheck.js";

export interface ContentMiningPipelineRequest {
  readonly evidencePackage: EvidencePackage;
  readonly recipes?: readonly Recipe[];
  readonly recipeFiles?: readonly RecipeMarkdownFileIndex[];
  readonly reportId?: string;
  readonly generatedAt?: number;
}

export interface ContentMiningPipelineDependencies {
  readonly dimensionLensPolicy?: DimensionLensPolicy;
  readonly relationMiner?: RecipeRelationMiner;
  readonly freshnessCheck?: SourceRefFreshnessCheck;
  readonly compileReportBuilder?: CompileReportBuilder;
}

export interface ContentMiningPipelineArtifacts extends CompileArtifacts {
  readonly evidencePackage: EvidencePackage;
  readonly lensActivations: readonly DimensionLensActivation[];
  readonly recipes: readonly Recipe[];
  readonly recipeFiles: readonly RecipeMarkdownFileIndex[];
  readonly edges: readonly RecipeEdge[];
  readonly sourceRefs: readonly SourceRef[];
  readonly freshnessFindings: readonly SourceRefFreshnessFinding[];
  readonly compileReport: CompileReport;
  toWritableArtifacts(): CompileArtifacts;
  writeWith(writer: Pick<CompileArtifactWriter, "write">): Promise<void>;
}

/**
 * ContentMiningPipeline 是内容挖掘下层 pipeline。
 * 中文注释：它只把 EvidencePackage 和已存在 Recipe 编译成 artifact 包；
 * 不调用 LLM、不生成候选文本、不接旧 Wiki/ToolForge/ReverseGuard。
 */
export class ContentMiningPipeline {
  readonly #dimensionLensPolicy: DimensionLensPolicy;
  readonly #relationMiner: RecipeRelationMiner;
  readonly #freshnessCheck: SourceRefFreshnessCheck;
  readonly #compileReportBuilder: CompileReportBuilder;

  constructor(dependencies: ContentMiningPipelineDependencies = {}) {
    this.#dimensionLensPolicy = dependencies.dimensionLensPolicy ?? new DimensionLensPolicy();
    this.#relationMiner = dependencies.relationMiner ?? new RecipeRelationMiner();
    this.#freshnessCheck = dependencies.freshnessCheck ?? new SourceRefFreshnessCheck();
    this.#compileReportBuilder = dependencies.compileReportBuilder ?? new CompileReportBuilder();
  }

  compile(request: ContentMiningPipelineRequest): ContentMiningPipelineArtifacts {
    const evidencePackage = request.evidencePackage;
    const lensActivations = this.#dimensionLensPolicy.activate(evidencePackage);
    const recipes = [...(request.recipes ?? [])];
    const recipeFiles = [...(request.recipeFiles ?? [])];
    const edges = this.#relationMiner.mineSourceRefOverlap(recipes);
    const freshnessFindings = this.#freshnessCheck.check(evidencePackage.sourceRefs);
    const compileReport = this.#compileReportBuilder.build({
      evidencePackage,
      lensActivations,
      recipes,
      edges,
      freshnessFindings,
      ...(request.reportId ? { id: request.reportId } : {}),
      ...(request.generatedAt !== undefined ? { generatedAt: request.generatedAt } : {}),
    });

    return createContentMiningArtifacts({
      evidencePackage,
      lensActivations,
      recipes,
      recipeFiles,
      edges,
      freshnessFindings,
      compileReport,
    });
  }
}

interface CreateContentMiningArtifactsRequest {
  readonly evidencePackage: EvidencePackage;
  readonly lensActivations: readonly DimensionLensActivation[];
  readonly recipes: readonly Recipe[];
  readonly recipeFiles: readonly RecipeMarkdownFileIndex[];
  readonly edges: readonly RecipeEdge[];
  readonly freshnessFindings: readonly SourceRefFreshnessFinding[];
  readonly compileReport: CompileReport;
}

function createContentMiningArtifacts(
  request: CreateContentMiningArtifactsRequest,
): ContentMiningPipelineArtifacts {
  const writableArtifacts: CompileArtifacts = {
    sourceRefs: request.evidencePackage.sourceRefs,
    recipes: request.recipes,
    recipeFiles: request.recipeFiles,
    edges: request.edges,
  };

  return {
    ...request,
    sourceRefs: request.evidencePackage.sourceRefs,
    toWritableArtifacts: () => writableArtifacts,
    writeWith: (writer) => writer.write(writableArtifacts),
  };
}
