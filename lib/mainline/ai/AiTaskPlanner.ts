import type { ContextBundle, EvidencePackage } from "../knowledge/index.js";
import { type AiCapabilityDecision, AiCapabilityPolicy } from "./AiCapabilityPolicy.js";
import type { AiProviderStatus, AiTask } from "./AiPort.js";

export interface AiTaskPlan {
  allowed: boolean;
  decision: AiCapabilityDecision;
  tasks: AiTask[];
}

export interface ContentMiningAiTaskPlanRequest {
  evidencePackage: EvidencePackage;
  providerStatus?: AiProviderStatus | null;
}

export interface KnowledgeInjectionAiTaskPlanRequest {
  contextBundle: ContextBundle;
  providerStatus?: AiProviderStatus | null;
}

/**
 * AiTaskPlanner 只规划 AI 任务，不执行 AI 调用。
 * 内容挖掘和知识注入可以消费这些 task；真正调用 provider 必须通过 MainlineAiPort。
 */
export class AiTaskPlanner {
  readonly #policy: AiCapabilityPolicy;

  constructor(policy = new AiCapabilityPolicy()) {
    this.#policy = policy;
  }

  planContentMining(request: ContentMiningAiTaskPlanRequest): AiTaskPlan {
    const decision = this.#policy.decide(request.providerStatus);
    if (!decision.allowed) {
      return { allowed: false, decision, tasks: [] };
    }

    const evidence = request.evidencePackage;
    return {
      allowed: true,
      decision,
      tasks: [
        {
          id: `${evidence.id}:summarize-evidence`,
          origin: "content-mining",
          kind: "summarize-evidence",
          title: "Summarize compile-time evidence",
          prompt: buildEvidenceSummaryPrompt(evidence),
          evidencePackage: evidence,
        },
        {
          id: `${evidence.id}:propose-recipe-edges`,
          origin: "content-mining",
          kind: "propose-recipe-edges",
          title: "Propose RecipeEdge candidates from evidence",
          prompt: buildRecipeEdgePrompt(evidence),
          evidencePackage: evidence,
        },
      ],
    };
  }

  planKnowledgeInjection(request: KnowledgeInjectionAiTaskPlanRequest): AiTaskPlan {
    const decision = this.#policy.decide(request.providerStatus);
    if (!decision.allowed) {
      return { allowed: false, decision, tasks: [] };
    }

    const bundle = request.contextBundle;
    return {
      allowed: true,
      decision,
      tasks: [
        {
          id: `${bundle.id}:compress-context-bundle`,
          origin: "knowledge-injection",
          kind: "compress-context-bundle",
          title: "Compress ContextBundle for agent injection",
          prompt: buildContextCompressionPrompt(bundle),
          contextBundle: bundle,
        },
      ],
    };
  }
}

function buildEvidenceSummaryPrompt(evidence: EvidencePackage): string {
  return [
    "请基于以下编译期证据生成简洁摘要。",
    "只总结真实证据，不要补造项目事实。",
    `EvidencePackage: ${evidence.id}`,
    `Changed files: ${evidence.changedFiles.join(", ") || "(none)"}`,
    `Source refs: ${evidence.sourceRefs.map((ref) => ref.id).join(", ") || "(none)"}`,
    `Notes: ${evidence.notes.join(" | ") || "(none)"}`,
  ].join("\n");
}

function buildRecipeEdgePrompt(evidence: EvidencePackage): string {
  return [
    "请从证据中提议 RecipeEdge 候选关系。",
    "只能使用 requires/supports/conflicts_with/supersedes/refines/same_context/applies_to。",
    "每条关系必须说明 SourceRef 证据；没有证据就不要输出。",
    `EvidencePackage: ${evidence.id}`,
  ].join("\n");
}

function buildContextCompressionPrompt(bundle: ContextBundle): string {
  return [
    "请把 ContextBundle 压缩成适合代码 Agent 使用的上下文。",
    "保留规则、风险、SourceRef，不要触发工具或扫描。",
    `Bundle: ${bundle.id}`,
    `Files: ${bundle.activeContext.files.join(", ") || "(none)"}`,
    `Recipes: ${bundle.recipes.map((recipe) => recipe.title).join(", ") || "(none)"}`,
    `Risks: ${bundle.risks.map((risk) => risk.message).join(" | ") || "(none)"}`,
  ].join("\n");
}
