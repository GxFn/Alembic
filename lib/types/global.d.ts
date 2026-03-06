/**
 * Global type declarations for AutoSnippet project.
 *
 * These types are referenced in JSDoc annotations across the codebase
 * but have no formal TypeScript definition. This file provides them
 * so that `tsc --checkJs` can resolve them.
 *
 * NOTE: All interfaces use index signatures `[key: string]: any` because
 * the codebase accesses many dynamic properties beyond the documented ones.
 * As the project migrates to TypeScript, these should be tightened.
 */

// ─── Tree-sitter ────────────────────────────────────────────

/** Tree-sitter syntax tree node (from tree-sitter package) */
interface TreeSitterNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  childCount: number;
  children: TreeSitterNode[];
  namedChildren: TreeSitterNode[];
  parent: TreeSitterNode | null;
  firstChild: TreeSitterNode | null;
  lastChild: TreeSitterNode | null;
  nextSibling: TreeSitterNode | null;
  previousSibling: TreeSitterNode | null;
  firstNamedChild: TreeSitterNode | null;
  lastNamedChild: TreeSitterNode | null;
  nextNamedSibling: TreeSitterNode | null;
  previousNamedSibling: TreeSitterNode | null;
  child(index: number): TreeSitterNode | null;
  namedChild(index: number): TreeSitterNode | null;
  childForFieldName(name: string): TreeSitterNode | null;
  descendantsOfType(type: string | string[], start?: { row: number; column: number }, end?: { row: number; column: number }): TreeSitterNode[];
  toString(): string;
  [key: string]: any;
}

// ─── AST Analysis ───────────────────────────────────────────

interface ClassInfo {
  name: string;
  superClass?: string;
  protocols?: string[];
  methods?: MethodInfo[];
  properties?: any[];
  file?: string;
  startLine?: number;
  endLine?: number;
  [key: string]: any;
}

interface MethodInfo {
  name: string;
  className?: string;
  isStatic?: boolean;
  parameters?: { name: string; type?: string }[];
  returnType?: string;
  bodyLines?: number;
  complexity?: number;
  startLine?: number;
  endLine?: number;
  [key: string]: any;
}

interface ProtocolInfo {
  name: string;
  methods?: MethodInfo[];
  properties?: any[];
  file?: string;
  [key: string]: any;
}

interface CategoryInfo {
  name: string;
  className?: string;
  methods?: MethodInfo[];
  file?: string;
  [key: string]: any;
}

interface FileSymbols {
  classes: ClassInfo[];
  protocols: ProtocolInfo[];
  categories: CategoryInfo[];
  functions: MethodInfo[];
  imports: any[];
  [key: string]: any;
}

interface ProjectAstSummary {
  classes: ClassInfo[];
  protocols: ProtocolInfo[];
  categories: CategoryInfo[];
  projectMetrics: {
    totalFiles: number;
    totalMethods: number;
    avgComplexity: number;
    maxNestingDepth: number;
    longMethods: MethodInfo[];
  };
  [key: string]: any;
}

type AstSummary = ProjectAstSummary;

// ─── Wiki ───────────────────────────────────────────────────

interface WikiResult {
  totalPages: number;
  pages: { path: string; title: string }[];
  errors: string[];
  [key: string]: any;
}

// ─── Project Overview ───────────────────────────────────────

interface ProjectOverview {
  name: string;
  language: string;
  targets: any[];
  dependencies: any[];
  [key: string]: any;
}

// ─── Agent / Task ───────────────────────────────────────────

interface Plan {
  steps: PlanStep[];
  goal: string;
  status: string;
  [key: string]: any;
}

interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: any;
  [key: string]: any;
}

interface Round {
  index: number;
  startedAt: number;
  endedAt?: number;
  toolCalls: number;
  hasNewInfo: boolean;
  [key: string]: any;
}

interface DistilledContext {
  summary: string;
  keyFacts: string[];
  openQuestions: string[];
  [key: string]: any;
}

// ─── Bootstrap ──────────────────────────────────────────────

interface DimensionDigest {
  dimId: string;
  label: string;
  status: string;
  candidateCount: number;
  [key: string]: any;
}

interface DimensionContextSnapshot {
  dimId: string;
  context: any;
  timestamp: number;
  [key: string]: any;
}

interface CandidateSummary {
  id: string;
  title: string;
  knowledgeType: string;
  score?: number;
  [key: string]: any;
}

// ─── Compliance ─────────────────────────────────────────────

interface ComplianceReport {
  total: number;
  passed: number;
  failed: number;
  violations: any[];
  timestamp: number;
  [key: string]: any;
}

// ─── Misc ───────────────────────────────────────────────────

interface FieldDef {
  name: string;
  type?: string;
  required?: boolean;
  default?: any;
  description?: string;
  [key: string]: any;
}

interface OverrideInfo {
  field: string;
  oldValue: any;
  newValue: any;
  [key: string]: any;
}
