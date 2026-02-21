import { v4 as uuidv4 } from 'uuid';

/**
 * Snippet - 代码片段实体
 *
 * 与 Recipe 的区别:
 * - Recipe: 抽象的知识模式 / 最佳实践
 * - Snippet: 具体的、可安装的代码片段（支持多 IDE: Xcode / VSCode / Cursor）
 */
export class Snippet {
  constructor(props) {
    this.id = props.id || uuidv4();
    this.identifier = props.identifier; // 唯一标识符（如 com.autosnippet.guard-let）
    this.title = props.title;
    this.language = props.language || 'unknown';
    this.category = props.category;
    this.completion = props.completion; // 自动补全触发词
    this.summary = props.summary || '';
    this.code = Array.isArray(props.code) ? props.code.join('\n') : props.code || '';

    // 多 IDE 安装状态
    // targets = { xcode: { installed, path }, vscode: { installed, path } }
    this.targets = props.targets || {};

    // 向后兼容: 旧数据的 installed/installedPath 迁移到 targets.xcode
    if (props.installed && !this.targets.xcode) {
      this.targets.xcode = { installed: true, path: props.installedPath || null };
    }

    // Source tracking
    this.sourceRecipeId = props.sourceRecipeId || null;
    this.sourceCandidateId = props.sourceCandidateId || null;

    // Metadata
    this.metadata = props.metadata || null;
    this.createdBy = props.createdBy || null;
    this.createdAt = props.createdAt || Math.floor(Date.now() / 1000);
    this.updatedAt = props.updatedAt || Math.floor(Date.now() / 1000);
  }

  /**
   * 是否已安装到指定 IDE (不传则检查任意)
   * @param {string} [target] — 'xcode' | 'vscode'
   */
  isInstalled(target) {
    if (target) {
      return !!this.targets[target]?.installed;
    }
    return Object.values(this.targets).some((t) => t?.installed);
  }

  /**
   * 获取指定 IDE 的安装路径
   * @param {string} target
   */
  getInstalledPath(target) {
    return this.targets[target]?.path || null;
  }

  /**
   * 验证 Snippet 完整性
   */
  isValid() {
    return (
      this.identifier &&
      this.identifier.trim().length > 0 &&
      this.title &&
      this.title.trim().length > 0 &&
      this.code &&
      this.code.trim().length > 0
    );
  }

  /**
   * 转换为 JSON（前端 / API 返回格式）
   */
  toJSON() {
    return {
      id: this.id,
      identifier: this.identifier,
      title: this.title,
      language: this.language,
      category: this.category,
      completion: this.completion,
      summary: this.summary,
      code: this.code,
      targets: this.targets,
      // 向后兼容: 保留 installed 字段 (任意 IDE 已安装即为 true)
      installed: this.isInstalled(),
      sourceRecipeId: this.sourceRecipeId,
      sourceCandidateId: this.sourceCandidateId,
      metadata: this.metadata,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * 从 JSON 创建 Snippet
   */
  static fromJSON(data) {
    return new Snippet(data);
  }
}

export default Snippet;
