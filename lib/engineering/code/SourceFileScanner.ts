import fs from "node:fs/promises";
import path from "node:path";
import {
  defaultMainlineLanguageCatalog,
  type MainlineLanguageCatalog,
  type MainlineLanguageProfile,
} from "./LanguageCatalog.js";
import { ExtensionLanguageService, type MainlineLanguageService } from "./LanguageServicePort.js";

export interface MainlineSourceFileScanOptions {
  readonly root: string;
  readonly maxDepth?: number;
  readonly maxFiles?: number;
  readonly includeTests?: boolean;
  readonly includeDocs?: boolean;
  readonly includeMarkdown?: boolean;
  readonly skipDirs?: readonly string[];
}

export type MainlineScannedSourceFileKind = "source" | "doc";

export interface MainlineScannedSourceFile {
  readonly path: string;
  readonly relativePath: string;
  readonly kind: MainlineScannedSourceFileKind;
  readonly languageId: string;
  readonly isTest: boolean;
  readonly sizeBytes: number;
}

export interface MainlineSourceFileScanMetadata {
  readonly maxDepth: number;
  readonly maxFiles: number;
  readonly includeTests: boolean;
  readonly includeDocs: boolean;
  readonly includeMarkdown: boolean;
  readonly skipDirs: string[];
  readonly totalFiles: number;
  readonly sourceFiles: number;
  readonly docFiles: number;
  readonly testFiles: number;
}

export interface MainlineSourceFileScanResult {
  readonly root: string;
  readonly files: MainlineScannedSourceFile[];
  readonly languageCounts: Record<string, number>;
  readonly documentCounts: Record<string, number>;
  readonly profile: MainlineLanguageProfile;
  readonly metadata: MainlineSourceFileScanMetadata;
  readonly truncated: boolean;
}

/**
 * MainlineSourceFileScanner 是编译期的轻量源码发现器。
 * 它只做目录遍历、忽略目录、语言识别和测试文件标记；构建系统 Discoverer 继续留给 adapter。
 */
export class MainlineSourceFileScanner {
  readonly #languageService: MainlineLanguageService;
  readonly #catalog: MainlineLanguageCatalog;

  constructor(
    languageService: MainlineLanguageService = new ExtensionLanguageService(),
    catalog: MainlineLanguageCatalog = defaultMainlineLanguageCatalog,
  ) {
    this.#languageService = languageService;
    this.#catalog = catalog;
  }

  async scan(options: MainlineSourceFileScanOptions): Promise<MainlineSourceFileScanResult> {
    const root = path.resolve(options.root);
    const maxDepth = options.maxDepth ?? 8;
    const maxFiles = options.maxFiles ?? 5_000;
    const includeTests = options.includeTests === true;
    const includeDocs = options.includeDocs === true;
    const includeMarkdown = options.includeMarkdown === true;
    const skipDirList = [...(options.skipDirs ?? this.#catalog.scanSkipDirs())].sort();
    const skipDirs = new Set(skipDirList);
    const files: MainlineScannedSourceFile[] = [];
    const languageCounts: Record<string, number> = {};
    const documentCounts: Record<string, number> = {};
    let truncated = false;

    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth || truncated) {
        return;
      }

      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return comparePath(left.name, right.name);
      });

      for (const entry of entries) {
        if (truncated) {
          return;
        }
        const absolute = path.join(dir, entry.name);
        const relativePath = toPosixRelativePath(root, absolute);
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) {
            continue;
          }
          await visit(absolute, depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        const sourceDetection = this.#languageService.inferLanguage(absolute);
        const isSource = sourceDetection.languageId !== "unknown";
        const isMarkdown = this.#catalog.isMarkdownFile(absolute);
        const isDoc =
          !isSource && (includeDocs || (includeMarkdown && isMarkdown))
            ? this.#catalog.isDocumentFile(absolute)
            : false;
        if (!isSource && !isDoc) {
          continue;
        }

        const languageId = isSource
          ? sourceDetection.languageId
          : isMarkdown
            ? "markdown"
            : "document";
        const isTest = isSource
          ? this.#languageService.isTestFile(relativePath, sourceDetection.languageId)
          : false;
        if (isTest && !includeTests) {
          continue;
        }

        let sizeBytes = 0;
        try {
          sizeBytes = (await fs.stat(absolute)).size;
        } catch {
          sizeBytes = 0;
        }

        files.push({
          path: absolute,
          relativePath,
          kind: isSource ? "source" : "doc",
          languageId,
          isTest,
          sizeBytes,
        });
        if (isSource) {
          languageCounts[sourceDetection.languageId] =
            (languageCounts[sourceDetection.languageId] ?? 0) + 1;
        } else {
          documentCounts[languageId] = (documentCounts[languageId] ?? 0) + 1;
        }

        if (files.length >= maxFiles) {
          truncated = true;
        }
      }
    };

    await visit(root, 0);
    files.sort((left, right) => comparePath(left.relativePath, right.relativePath));

    return {
      root,
      files,
      languageCounts,
      documentCounts,
      profile: this.#catalog.detectProfile(languageCounts),
      metadata: {
        maxDepth,
        maxFiles,
        includeTests,
        includeDocs,
        includeMarkdown,
        skipDirs: skipDirList,
        totalFiles: files.length,
        sourceFiles: files.filter((file) => file.kind === "source").length,
        docFiles: files.filter((file) => file.kind === "doc").length,
        testFiles: files.filter((file) => file.isTest).length,
      },
      truncated,
    };
  }
}

function toPosixRelativePath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function comparePath(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
