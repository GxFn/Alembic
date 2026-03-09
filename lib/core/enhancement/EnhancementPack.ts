/**
 * @module EnhancementPack
 * @description 语言/框架特有增强能力包 - 接口定义
 *
 * 每个增强包负责:
 * - 额外的 Bootstrap 维度
 * - 额外的 Guard 规则
 * - 额外的设计模式检测
 * - SFC 预处理（.vue → 提取 <script>）
 * - Reference Skill 路径
 */
/** AST method info from analyzeFile/analyzeProject */
export interface AstMethodInfo {
  name: string;
  className?: string;
  line?: number;
  paramCount?: number;
  isAsync?: boolean;
  isExported?: boolean;
  isClassMethod?: boolean;
  decorators?: string[];
  annotations?: string[];
}

/** AST class/struct info */
export interface AstClassInfo {
  name: string;
  line?: number;
  superclass?: string;
  kind?: string;
  methods?: string[];
  interfaces?: string[];
  annotations?: string[];
  decorators?: string[];
  embeddedTypes?: string[];
  fieldCount?: number;
  derives?: string[];
  traitName?: string;
}

/** AST protocol/interface info */
export interface AstProtocolInfo {
  name: string;
  line?: number;
  methods?: string[];
}

/** Pattern info from AST analysis */
export interface AstPatternInfo {
  type: string;
  count?: number;
  confidence?: number;
}

/** analyzeFile/analyzeProject return value */
export interface AstSummary {
  methods?: AstMethodInfo[];
  classes?: AstClassInfo[];
  imports?: string[];
  protocols?: AstProtocolInfo[];
  patterns?: AstPatternInfo[];
}

/** Detected design pattern */
export interface DetectedPattern {
  type: string;
  className?: string;
  methodName?: string;
  line?: number;
  confidence: number;
  [key: string]: unknown;
}

/** Bootstrap extra dimension definition */
export interface ExtraDimension {
  id: string;
  label: string;
  guide: string;
  tierHint?: number;
  knowledgeTypes: string[];
  skillWorthy?: boolean;
  dualOutput?: boolean;
  skillMeta?: {
    name: string;
    description: string;
  };
}

/** Guard rule definition */
export interface GuardRule {
  ruleId: string;
  category: string;
  dimension: string;
  severity: string;
  languages: string[];
  pattern: RegExp;
  message: string;
}
export class EnhancementPack {
  /** 增强包 ID */
  get id(): string {
    throw new Error('Not implemented');
  }

  /** 适用条件 */
  get conditions(): { languages: string[]; frameworks?: string[] } {
    throw new Error('Not implemented');
  }

  /** 人类可读名称 */
  get displayName(): string {
    return this.id;
  }

  /**
   * 额外的 Bootstrap 维度定义
   *
   * 维度对象支持以下字段:
   *   - id {string}            — 维度 ID（TierScheduler 使用）
   *   - label {string}         — 人类可读标签
   *   - guide {string}         — AI Agent 分析指引
   *   - tierHint {number}      — 首选 Tier（1/2/3）；未声明时默认 Tier 1
   *   - knowledgeTypes {string[]} — 产出的知识类型
   *   - skillWorthy {boolean}  — 是否生成 Skill
   *   - dualOutput {boolean}   — 是否同时产出 Skill + Candidate
   *   - skillMeta {object}     — Skill 元数据（name, description）
   */
  getExtraDimensions(): ExtraDimension[] {
    return [];
  }

  /** 额外的 Guard 规则 */
  getGuardRules(): GuardRule[] {
    return [];
  }

  /**
   * 额外的设计模式检测
   * @param astSummary analyzeFile/analyzeProject 的返回值
   * @returns >}
   */
  detectPatterns(astSummary: AstSummary): DetectedPattern[] {
    return [];
  }

  /**
   * SFC 预处理器 — 将非标准文件转换为可解析的脚本内容
   * @param content 原始文件内容
   * @param ext 文件扩展名 (含 .)
   * @returns | null}
   */
  preprocessFile(content: string, ext: string): { content: string; lang: string } | null {
    return null;
  }

  /** Reference Skill 路径（Bootstrap 时自动加载，相对于 skills/ 目录） */
  getReferenceSkillPath(): string | null {
    return null;
  }
}
