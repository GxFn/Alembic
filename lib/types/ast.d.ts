/**
 * Tree-sitter AST 类型声明
 */

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
  descendantsOfType(
    type: string | string[],
    start?: { row: number; column: number },
    end?: { row: number; column: number }
  ): TreeSitterNode[];
  toString(): string;
  [key: string]: any;
}

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
