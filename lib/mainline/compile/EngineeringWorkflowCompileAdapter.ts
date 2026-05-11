import path from "node:path";
import type {
  EngineeringCodeAstSummaryInput,
  EngineeringCodeCallGraphEdge,
  EngineeringCodeDataFlowEdge,
  EngineeringDependencyEdge,
  EngineeringDependencyGraph,
  EngineeringDependencyNode,
  EngineeringFile,
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowDiscoveryResult,
  EngineeringWorkflowInput,
  EngineeringWorkflowResult,
} from "../../engineering/index.js";
import { EngineeringWorkflowRunner } from "../../engineering/index.js";
import type {
  MainlineProjectCallGraphEdge,
  MainlineProjectDataFlowEdge,
  MainlineProjectGraph,
  MainlineProjectGraphExternalDependency,
  MainlineProjectGraphNode,
  MainlineProjectGraphUnresolvedDependency,
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceFile,
  MainlineProjectIntelligenceFileInput,
} from "../graph/index.js";

export interface MainlineEngineeringWorkflowCompileAdapterRequest {
  readonly projectRoot: string;
  readonly artifact: MainlineProjectIntelligenceArtifact;
  readonly files?: readonly MainlineProjectIntelligenceFileInput[];
  readonly generatedAt?: number;
  readonly computedAt?: number;
  readonly maxFiles?: number;
  readonly optionalStage?: EngineeringWorkflowInput["optionalStage"];
  readonly staleAfterMs?: number | null;
  readonly stale?: boolean;
}

export interface MainlineEngineeringWorkflowCompileAdapterDiagnostic {
  readonly source: "adapter" | "engineering-workflow";
  readonly severity: EngineeringWorkflowDiagnostic["severity"];
  readonly message: string;
  readonly phase?: EngineeringWorkflowDiagnostic["phase"];
  readonly code?: string;
  readonly cause?: string;
}

export interface MainlineEngineeringWorkflowCompileAdapterResult {
  readonly status: EngineeringWorkflowResult["status"];
  readonly input: EngineeringWorkflowInput;
  readonly workflowResult?: EngineeringWorkflowResult;
  readonly diagnostics: readonly MainlineEngineeringWorkflowCompileAdapterDiagnostic[];
}

export interface MainlineEngineeringWorkflowCompileAdapterPort {
  run(
    request: MainlineEngineeringWorkflowCompileAdapterRequest,
  ): Promise<MainlineEngineeringWorkflowCompileAdapterResult>;
}

export interface MainlineEngineeringWorkflowCompileAdapterDependencies {
  readonly workflowRunner?: Pick<EngineeringWorkflowRunner, "run">;
}

/**
 * 编译期 sidecar adapter：只做 mainline artifact 到 lib/engineering 输入的投影。
 * 它不替换旧 ProjectIntelligence artifact，也不把工程事实写回 Recipe/DB。
 */
export class MainlineEngineeringWorkflowCompileAdapter
  implements MainlineEngineeringWorkflowCompileAdapterPort
{
  readonly #workflowRunner: Pick<EngineeringWorkflowRunner, "run">;

  constructor(dependencies: MainlineEngineeringWorkflowCompileAdapterDependencies = {}) {
    this.#workflowRunner = dependencies.workflowRunner ?? new EngineeringWorkflowRunner();
  }

  async run(
    request: MainlineEngineeringWorkflowCompileAdapterRequest,
  ): Promise<MainlineEngineeringWorkflowCompileAdapterResult> {
    const input = buildEngineeringWorkflowInput(request);
    try {
      const workflowResult = await this.#workflowRunner.run(input);
      return {
        status: workflowResult.status,
        input,
        workflowResult,
        diagnostics: workflowResult.diagnostics.map(engineeringDiagnosticToAdapterDiagnostic),
      };
    } catch (error: unknown) {
      return {
        status: "failed",
        input,
        diagnostics: [
          {
            source: "adapter",
            severity: "error",
            message: "Engineering workflow sidecar failed during mainline compile.",
            cause: errorMessage(error),
          },
        ],
      };
    }
  }
}

export function buildEngineeringWorkflowInput(
  request: MainlineEngineeringWorkflowCompileAdapterRequest,
): EngineeringWorkflowInput {
  const generatedAt = request.artifact.generatedAt ?? request.generatedAt;
  const astSummaries = buildEngineeringAstSummary(request.artifact);
  return {
    projectRoot: request.projectRoot,
    discoveryResult: buildEngineeringDiscoveryResult(request),
    fileContents: fileContentsFromMainlineFiles(request.files ?? []),
    ...(astSummaries === undefined ? {} : { astSummaries }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...(request.computedAt === undefined ? {} : { computedAt: request.computedAt }),
    ...(request.maxFiles === undefined ? {} : { maxFiles: request.maxFiles }),
    optionalStage: request.optionalStage ?? false,
    ...(request.staleAfterMs === undefined ? {} : { staleAfterMs: request.staleAfterMs }),
    ...(request.stale === undefined ? {} : { stale: request.stale }),
  };
}

function buildEngineeringDiscoveryResult(
  request: MainlineEngineeringWorkflowCompileAdapterRequest,
): EngineeringWorkflowDiscoveryResult {
  const targetName = targetNameForProjectRoot(request.projectRoot);
  return {
    targets: [
      {
        name: targetName,
        path: request.projectRoot,
        type: "project",
        language: dominantLanguage(request.artifact.files),
        metadata: {
          source: "mainline-project-intelligence",
        },
      },
    ],
    files: request.artifact.files.map((file) => engineeringFileFromArtifactFile(file, targetName)),
    dependencyGraph: engineeringDependencyGraphFromMainline(request.artifact.projectGraph),
    discovererId: "mainline-project-intelligence",
    discovererName: "Mainline Project Intelligence Adapter",
  };
}

function engineeringFileFromArtifactFile(
  file: MainlineProjectIntelligenceFile,
  targetName: string,
): EngineeringFile {
  const relativePath = normalizeArtifactPath(file.path);
  return {
    name: path.posix.basename(relativePath),
    path: relativePath,
    relativePath,
    language: file.languageId,
    targetName,
    isTest: isTestPath(relativePath),
  };
}

function engineeringDependencyGraphFromMainline(
  graph: MainlineProjectGraph,
): EngineeringDependencyGraph {
  const nodes = new Map<string, EngineeringDependencyNode>();
  const edges = new Map<string, EngineeringDependencyEdge>();

  for (const node of graph.nodes) {
    nodes.set(node.id, engineeringNodeFromMainline(node));
  }
  for (const edge of graph.edges) {
    nodes.set(edge.from, nodes.get(edge.from) ?? { id: edge.from, label: edge.from });
    nodes.set(edge.to, nodes.get(edge.to) ?? { id: edge.to, label: edge.to });
    appendDependencyEdge(edges, {
      from: edge.from,
      to: edge.to,
      type: edge.kind,
      ...(edge.specifier === undefined ? {} : { scope: edge.specifier }),
      weight: edge.kind === "declares" ? 0.5 : 1,
    });
  }
  for (const dependency of graph.externalDependencies) {
    appendExternalDependency(nodes, edges, dependency);
  }
  for (const dependency of graph.unresolvedDependencies) {
    appendUnresolvedDependency(nodes, edges, dependency);
  }

  return {
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort(
      (left, right) =>
        left.from.localeCompare(right.from) ||
        left.to.localeCompare(right.to) ||
        left.type.localeCompare(right.type),
    ),
  };
}

function engineeringNodeFromMainline(node: MainlineProjectGraphNode): EngineeringDependencyNode {
  return {
    id: node.id,
    label: node.symbol ?? node.path ?? node.id,
    type: node.kind,
    ...(node.path === undefined ? {} : { fullPath: node.path }),
    ...(node.languageId === undefined ? {} : { languageId: node.languageId }),
    ...(node.metadata === undefined ? {} : { metadata: node.metadata }),
  };
}

function appendExternalDependency(
  nodes: Map<string, EngineeringDependencyNode>,
  edges: Map<string, EngineeringDependencyEdge>,
  dependency: MainlineProjectGraphExternalDependency,
): void {
  const nodeId = externalDependencyNodeId(dependency.specifier);
  nodes.set(nodeId, {
    id: nodeId,
    label: dependency.specifier,
    type: "external",
    indirect: true,
  });
  appendDependencyEdge(edges, {
    from: fileNodeId(dependency.fromPath),
    to: nodeId,
    type: dependency.kind,
    scope: "external",
    weight: 0.75,
  });
}

function appendUnresolvedDependency(
  nodes: Map<string, EngineeringDependencyNode>,
  edges: Map<string, EngineeringDependencyEdge>,
  dependency: MainlineProjectGraphUnresolvedDependency,
): void {
  const nodeId = unresolvedDependencyNodeId(dependency.normalizedTarget);
  nodes.set(nodeId, {
    id: nodeId,
    label: dependency.normalizedTarget,
    type: "unresolved",
    indirect: true,
  });
  appendDependencyEdge(edges, {
    from: fileNodeId(dependency.fromPath),
    to: nodeId,
    type: dependency.kind,
    scope: dependency.specifier,
    weight: 0.25,
  });
}

function appendDependencyEdge(
  edges: Map<string, EngineeringDependencyEdge>,
  edge: EngineeringDependencyEdge,
): void {
  edges.set(`${edge.from}\0${edge.to}\0${edge.type}\0${edge.scope ?? ""}`, edge);
}

function buildEngineeringAstSummary(
  artifact: MainlineProjectIntelligenceArtifact,
): EngineeringCodeAstSummaryInput | undefined {
  const fileSummaries = artifact.astProjectSummary?.fileSummaries ?? [];
  const callGraphEdges = (artifact.callGraph?.callEdges ?? []).map(engineeringCallEdgeFromMainline);
  const dataFlowEdges = (artifact.callGraph?.dataFlowEdges ?? []).map(
    engineeringDataFlowEdgeFromMainline,
  );

  if (fileSummaries.length === 0 && callGraphEdges.length === 0 && dataFlowEdges.length === 0) {
    return undefined;
  }

  return {
    fileSummaries,
    ...(callGraphEdges.length === 0 ? {} : { callGraphEdges }),
    ...(dataFlowEdges.length === 0 ? {} : { dataFlowEdges }),
  };
}

function engineeringCallEdgeFromMainline(
  edge: MainlineProjectCallGraphEdge,
): EngineeringCodeCallGraphEdge {
  return {
    caller: edge.caller,
    callee: edge.callee,
    callType: edge.callType,
    resolveMethod: edge.resolveMethod,
    line: edge.line,
    filePath: edge.file,
    isAwait: edge.isAwait,
    argCount: edge.argCount,
    sourceFilePath: edge.file,
    targetFilePath: null,
  };
}

function engineeringDataFlowEdgeFromMainline(
  edge: MainlineProjectDataFlowEdge,
): EngineeringCodeDataFlowEdge {
  return {
    from: edge.from,
    to: edge.to,
    flowType: edge.flowType,
    direction: edge.direction,
    confidence: edge.confidence ?? null,
    filePath: null,
    line: null,
    source: null,
    sink: null,
  };
}

function fileContentsFromMainlineFiles(
  files: readonly MainlineProjectIntelligenceFileInput[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    files.map((file) => [normalizeArtifactPath(file.path), file.content] as const),
  );
}

function targetNameForProjectRoot(projectRoot: string): string {
  return path.basename(projectRoot) || "project";
}

function dominantLanguage(files: readonly MainlineProjectIntelligenceFile[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    counts.set(file.languageId, (counts.get(file.languageId) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]?.[0] ?? "unknown"
  );
}

function normalizeArtifactPath(filePath: string): string {
  return path.posix.normalize(filePath.replace(/\\/g, "/")).replace(/^\.\//, "");
}

function fileNodeId(filePath: string): string {
  return `file:${normalizeArtifactPath(filePath)}`;
}

function externalDependencyNodeId(specifier: string): string {
  return `external:${specifier}`;
}

function unresolvedDependencyNodeId(specifier: string): string {
  return `unresolved:${specifier}`;
}

function isTestPath(filePath: string): boolean {
  return (
    /(^|\/)(test|tests|__tests__)\//i.test(filePath) || /\.(test|spec)\.[^.]+$/i.test(filePath)
  );
}

function engineeringDiagnosticToAdapterDiagnostic(
  diagnostic: EngineeringWorkflowDiagnostic,
): MainlineEngineeringWorkflowCompileAdapterDiagnostic {
  return {
    source: "engineering-workflow",
    severity: diagnostic.severity,
    message: diagnostic.message,
    phase: diagnostic.phase,
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
    ...(diagnostic.cause === undefined ? {} : { cause: diagnostic.cause }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
