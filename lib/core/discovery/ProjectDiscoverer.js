/**
 * @module ProjectDiscoverer
 * @description 项目结构发现器 - 统一接口定义
 *
 * 每个实现负责一种构建系统/包管理器的解析。
 * Bootstrap Phase 1 通过 DiscovererRegistry 自动选择匹配的实现。
 */

/**
 * @typedef {object} DiscoveredTarget
 * @property {string}   name         模块/Target 名称
 * @property {string}   path         模块根目录绝对路径
 * @property {string}   type         - 'library'|'executable'|'test'|'app'|'package'
 * @property {string}   [language]   主语言
 * @property {string}   [framework]  检测到的框架 (react/vue/express/django/spring/...)
 * @property {object}   [metadata]   构建系统特有元数据
 */

/**
 * @typedef {object} DiscoveredFile
 * @property {string} name         文件名
 * @property {string} path         绝对路径
 * @property {string} relativePath 相对于项目根的路径
 * @property {string} language     推断语言
 */

/**
 * @typedef {object} DependencyEdge
 * @property {string} from 源模块名
 * @property {string} to   目标模块名
 * @property {string} type - 'depends_on'|'dev_depends_on'|'peer_depends_on'
 */

export class ProjectDiscoverer {
  /**
   * 检测此 Discoverer 是否适用于给定项目
   * @param {string} projectRoot
   * @returns {Promise<{ match: boolean, confidence: number, reason: string }>}
   */
  async detect(projectRoot) {
    throw new Error('Not implemented');
  }

  /**
   * 加载项目结构（解析配置文件、构建依赖图）
   * @param {string} projectRoot
   * @returns {Promise<void>}
   */
  async load(projectRoot) {
    throw new Error('Not implemented');
  }

  /**
   * 列出所有 Target/模块
   * @returns {Promise<DiscoveredTarget[]>}
   */
  async listTargets() {
    throw new Error('Not implemented');
  }

  /**
   * 获取指定 Target 下的源码文件列表
   * @param {DiscoveredTarget|string} target
   * @returns {Promise<DiscoveredFile[]>}
   */
  async getTargetFiles(target) {
    throw new Error('Not implemented');
  }

  /**
   * 获取模块间依赖关系图
   * @returns {Promise<{ nodes: (string | {id: string, label?: string, type?: string, fullPath?: string, indirect?: boolean})[], edges: DependencyEdge[] }>}
   */
  async getDependencyGraph() {
    throw new Error('Not implemented');
  }

  /**
   * Discoverer 标识
   * @returns {string} 如 'spm', 'node', 'python', 'gradle', 'maven', 'generic'
   */
  get id() {
    throw new Error('Not implemented');
  }

  /**
   * 人类可读名称
   * @returns {string}
   */
  get displayName() {
    throw new Error('Not implemented');
  }
}
