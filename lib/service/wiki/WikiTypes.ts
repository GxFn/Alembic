/**
 * WikiTypes — Wiki 渲染器共享类型定义
 *
 * 从 WikiRenderers.ts 中提取的所有类型声明。
 * 供 WikiRenderers、WikiPageRenderers、WikiGenerator 共享使用。
 *
 * @module WikiTypes
 */

export interface WikiBuildSystem {
  buildTool: string;
  eco: string;
  file?: string;
}

export interface WikiDependency {
  name: string;
  [key: string]: unknown;
}

export interface WikiTarget {
  name: string;
  type?: string;
  path?: string;
  packageName?: string;
  dependencies?: (string | WikiDependency)[];
  info?: {
    path?: string;
    dependencies?: (string | WikiDependency)[];
  };
}

export interface WikiProjectInfo {
  name: string;
  primaryLanguage?: string;
  sourceFiles: string[];
  languages?: Record<string, number>;
  buildSystems?: WikiBuildSystem[];
  hasPackageSwift?: boolean;
  hasPodfile?: boolean;
  hasXcodeproj?: boolean;
  sourceFilesByModule?: Record<string, string[]>;
  root?: string;
}

export interface WikiAstOverview {
  totalClasses?: number;
  totalProtocols?: number;
  totalMethods?: number;
  topLevelModules?: string[];
  classesPerModule?: Record<string, number>;
  entryPoints?: string[];
}

export interface WikiAstInfo {
  overview?: WikiAstOverview;
  classNamesByModule?: Record<string, string[]>;
  protocolNamesByModule?: Record<string, string[]>;
  classes: string[];
  protocols: string[];
}

export interface WikiModuleInfo {
  targets: WikiTarget[];
  depGraph?: {
    edges?: Array<{ from?: string; to?: string }>;
  };
}

export interface WikiRecipeJson {
  title?: string;
  description?: string;
  category?: string;
  moduleName?: string;
  tags?: string[];
  doClause?: string;
  dontClause?: string;
  language?: string;
  content?: { pattern?: string };
  reasoning?: { whyStandard?: string };
}

export type WikiRecipe = WikiRecipeJson & { toJSON?: () => WikiRecipeJson };

export interface WikiKnowledgeInfo {
  recipes: WikiRecipe[];
}

export interface WikiCodeEntityGraph {
  queryEntities?: (filter: Record<string, unknown>) => Array<{ entityId: string; name: string }>;
  queryEdges?: (
    filter: Record<string, unknown>
  ) => Array<{ toId?: string; to_id?: string; fromId?: string }>;
}

export interface WikiFolderProfile {
  name: string;
  relPath: string;
  fileCount: number;
  totalSize: number;
  depth: number;
  langBreakdown: Record<string, number>;
  keyFiles: string[];
  fileNames: string[];
  readme: string | null;
  purpose: { zh?: string; en?: string } | null;
  imports: string[];
  entryPoints: string[];
  namingPatterns: string[];
  headerComments: string[];
}

export interface WikiTopic {
  type: string;
  id?: string;
  title?: string;
  path?: string;
  priority?: number;
  _allTopics?: WikiTopic[];
  _moduleData?: Record<string, unknown>;
  _patternData?: Record<string, unknown>;
  _folderProfiles?: Record<string, unknown>[];
  _folderProfile?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Narrowed shape of _moduleData for access inside renderers */
export interface WikiModuleData {
  target: WikiTarget;
  moduleFiles: string[];
}

/** Narrowed shape of _patternData for access inside renderers */
export interface WikiPatternData {
  category: string;
  recipes: WikiRecipeJson[];
}

export interface WikiData {
  projectInfo: WikiProjectInfo;
  astInfo: WikiAstInfo;
  moduleInfo: WikiModuleInfo;
  knowledgeInfo: WikiKnowledgeInfo;
}
