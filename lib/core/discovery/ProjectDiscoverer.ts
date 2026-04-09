/**
 * @module ProjectDiscoverer
 * @description 项目结构发现器 - 统一接口定义
 *
 * 每个实现负责一种构建系统/包管理器的解析。
 * Bootstrap Phase 1 通过 DiscovererRegistry 自动选择匹配的实现。
 */

export interface DiscoveredTarget {
  name: string;
  path: string;
  type: string;
  language?: string;
  framework?: string | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DiscoveredFile {
  name: string;
  path: string;
  relativePath: string;
  language: string;
  [key: string]: unknown;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: string;
}

export interface DependencyGraphLayer {
  name: string;
  order: number;
  accessibleLayers: string[];
}

export interface DependencyGraph {
  nodes: (
    | string
    | {
        id: string;
        label?: string;
        type?: string;
        fullPath?: string;
        indirect?: boolean;
        [key: string]: unknown;
      }
  )[];
  edges: DependencyEdge[];
  /** 层级元数据（来自自研构建系统的分层声明） */
  layers?: DependencyGraphLayer[];
}

export class ProjectDiscoverer {
  /** 检测此 Discoverer 是否适用于给定项目 */
  async detect(
    projectRoot: string
  ): Promise<{ match: boolean; confidence: number; reason: string }> {
    throw new Error('Not implemented');
  }

  /** 加载项目结构（解析配置文件、构建依赖图） */
  async load(projectRoot: string): Promise<void> {
    throw new Error('Not implemented');
  }

  /** 列出所有 Target/模块 */
  async listTargets(): Promise<DiscoveredTarget[]> {
    throw new Error('Not implemented');
  }

  /** 获取指定 Target 下的源码文件列表 */
  async getTargetFiles(target: DiscoveredTarget): Promise<DiscoveredFile[]> {
    throw new Error('Not implemented');
  }

  /** 获取模块间依赖关系图 */
  async getDependencyGraph(): Promise<DependencyGraph> {
    throw new Error('Not implemented');
  }

  /** Discoverer 标识 */
  get id(): string {
    throw new Error('Not implemented');
  }

  /** 人类可读名称 */
  get displayName(): string {
    throw new Error('Not implemented');
  }
}
