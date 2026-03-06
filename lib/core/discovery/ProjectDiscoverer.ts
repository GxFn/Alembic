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
  framework?: string;
  metadata?: Record<string, any>;
  [key: string]: any;
}

export interface DiscoveredFile {
  name: string;
  path: string;
  relativePath: string;
  language: string;
  [key: string]: any;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: string;
}

export interface DependencyGraph {
  nodes: (string | { id: string; label?: string; type?: string; fullPath?: string; indirect?: boolean })[];
  edges: DependencyEdge[];
}

export class ProjectDiscoverer {
  /**
   * 检测此 Discoverer 是否适用于给定项目
   */
  async detect(projectRoot: any): Promise<{ match: boolean; confidence: number; reason: string }> {
    throw new Error('Not implemented');
  }

  /**
   * 加载项目结构（解析配置文件、构建依赖图）
   */
  async load(projectRoot: any): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * 列出所有 Target/模块
   */
  async listTargets(): Promise<DiscoveredTarget[]> {
    throw new Error('Not implemented');
  }

  /**
   * 获取指定 Target 下的源码文件列表
   */
  async getTargetFiles(target: any): Promise<DiscoveredFile[]> {
    throw new Error('Not implemented');
  }

  /**
   * 获取模块间依赖关系图
   */
  async getDependencyGraph(): Promise<DependencyGraph> {
    throw new Error('Not implemented');
  }

  /**
   * Discoverer 标识
   */
  get id(): string {
    throw new Error('Not implemented');
  }

  /**
   * 人类可读名称
   */
  get displayName(): string {
    throw new Error('Not implemented');
  }
}
