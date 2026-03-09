/**
 * SnippetCodec — IDE Snippet 格式抽象接口
 *
 * 子类实现:
 *   - XcodeCodec  (.codesnippet plist XML)
 *   - VSCodeCodec (.code-snippets JSON, 兼容 Cursor)
 *
 * SnippetSpec 结构 (IDE 无关中间表示):
 *   { identifier, title, completion, summary, code, language }
 */
export interface SnippetSpec {
  identifier: string;
  title?: string;
  completion?: string;
  trigger?: string;
  summary?: string;
  code?: string | string[];
  language?: string;
  [key: string]: unknown;
}

export class SnippetCodec {
  /** @returns codec 标识 ('xcode' | 'vscode') */
  get id(): string {
    throw new Error('SnippetCodec.id is abstract');
  }

  /** 输出文件的扩展名 ('.codesnippet' | '.code-snippets') */
  get fileExtension(): string {
    throw new Error('SnippetCodec.fileExtension is abstract');
  }

  /** 单个 SnippetSpec → IDE 格式字符串 */
  generate(spec: SnippetSpec): string {
    throw new Error('SnippetCodec.generate() is abstract');
  }

  /**
   * 批量 specs → IDE 格式输出
   *   Xcode:  返回 Array<{ filename, content }>（每个 snippet 一个文件）
   *   VSCode: 返回 string（单个 JSON bundle 文件内容）
   * @returns >}
   */
  generateBundle(specs: SnippetSpec[]): string | Array<{ filename: string; content: string }> {
    throw new Error('SnippetCodec.generateBundle() is abstract');
  }

  /** 目标 snippet 安装目录路径 */
  getInstallDir(projectRoot?: string): string {
    throw new Error('SnippetCodec.getInstallDir() is abstract');
  }

  /** AutoSnippet 语言标识 → IDE 语言标识映射 */
  mapLanguage(lang: string): string {
    throw new Error('SnippetCodec.mapLanguage() is abstract');
  }

  /** 获取 bundle 文件名 (VSCode = 'autosnippet.code-snippets', Xcode = per-file) */
  getBundleFilename(): string | null {
    return null;
  }
}
