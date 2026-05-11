/**
 * 工程 Enhancement Pack 基类。
 *
 * 这一层迁入 Alembic-legacy 已验证的框架增强模型：每个 pack 都可以追加
 * Bootstrap 维度、Guard 规则、AST 设计模式检测，以及类似 Vue SFC 的预处理能力。
 */

export interface EngineeringEnhancementConditions {
  readonly languages: readonly string[];
  readonly frameworks?: readonly string[];
}

/** AST method info from analyzeFile/analyzeProject */
export interface AstMethodInfo {
  readonly name: string;
  readonly className?: string | undefined;
  readonly line?: number | undefined;
  readonly paramCount?: number | undefined;
  readonly isAsync?: boolean | undefined;
  readonly isExported?: boolean | undefined;
  readonly isClassMethod?: boolean | undefined;
  readonly decorators?: readonly string[] | undefined;
  readonly annotations?: readonly string[] | undefined;
}

/** AST class/struct info */
export interface AstClassInfo {
  readonly name: string;
  readonly line?: number | undefined;
  readonly superclass?: string | undefined;
  readonly kind?: string | undefined;
  readonly methods?: readonly string[] | undefined;
  readonly interfaces?: readonly string[] | undefined;
  readonly annotations?: readonly string[] | undefined;
  readonly decorators?: readonly string[] | undefined;
  readonly embeddedTypes?: readonly string[] | undefined;
  readonly fieldCount?: number | undefined;
  readonly derives?: readonly string[] | undefined;
  readonly traitName?: string | undefined;
}

/** AST protocol/interface info */
export interface AstProtocolInfo {
  readonly name: string;
  readonly line?: number | undefined;
  readonly methods?: readonly string[] | undefined;
}

/** Pattern info from AST analysis */
export interface AstPatternInfo {
  readonly type: string;
  readonly count?: number | undefined;
  readonly confidence?: number | undefined;
}

/** analyzeFile/analyzeProject return value */
export interface AstSummary {
  readonly methods?: readonly AstMethodInfo[] | undefined;
  readonly classes?: readonly AstClassInfo[] | undefined;
  readonly imports?: readonly string[] | undefined;
  readonly protocols?: readonly AstProtocolInfo[] | undefined;
  readonly patterns?: readonly AstPatternInfo[] | undefined;
}

/** Detected design pattern */
export interface DetectedPattern {
  readonly type: string;
  readonly className?: string | undefined;
  readonly methodName?: string | undefined;
  readonly line?: number | undefined;
  readonly confidence: number;
  readonly [key: string]: unknown;
}

/** Bootstrap extra dimension definition */
export interface ExtraDimension {
  readonly id: string;
  readonly label: string;
  readonly guide: string;
  readonly tierHint?: number | undefined;
  readonly knowledgeTypes: readonly string[];
  readonly skillWorthy?: boolean | undefined;
  readonly dualOutput?: boolean | undefined;
  readonly skillMeta?:
    | {
        readonly name: string;
        readonly description: string;
      }
    | undefined;
  readonly conditions?:
    | {
        readonly languages?: readonly string[] | undefined;
        readonly frameworks?: readonly string[] | undefined;
      }
    | undefined;
  readonly source?: string | undefined;
}

/** Guard rule definition */
export interface GuardRule {
  readonly ruleId: string;
  readonly category: string;
  readonly dimension: string;
  readonly severity: string;
  readonly languages: readonly string[];
  readonly pattern: RegExp;
  readonly message: string;
  readonly source?: string | undefined;
}

export interface PreprocessedEnhancementFile {
  readonly content: string;
  readonly lang: string;
}

export class EnhancementPack {
  /** 增强包 ID */
  get id(): string {
    throw new Error("Not implemented");
  }

  /** 适用条件 */
  get conditions(): EngineeringEnhancementConditions {
    throw new Error("Not implemented");
  }

  /** 人类可读名称 */
  get displayName(): string {
    return this.id;
  }

  /**
   * 额外的 Bootstrap 维度定义。
   *
   * 维度会进入冷启动/增量工程扫描的可选阶段，用于把框架特定关注点补充到通用工程全景里。
   */
  getExtraDimensions(): ExtraDimension[] {
    return [];
  }

  /** 额外的 Guard 规则 */
  getGuardRules(): GuardRule[] {
    return [];
  }

  /** 额外的设计模式检测 */
  detectPatterns(_astSummary: AstSummary): DetectedPattern[] {
    return [];
  }

  /** 非标准源码预处理，例如 Vue SFC 的 script/script setup 提取 */
  preprocessFile(_content: string, _ext: string): PreprocessedEnhancementFile | null {
    return null;
  }

  /** Reference Skill 路径（Bootstrap 时自动加载，相对于 skills/ 目录） */
  getReferenceSkillPath(): string | null {
    return null;
  }
}

export { EnhancementPack as EngineeringEnhancementPack };
