import {
  defaultMainlineLanguageCatalog,
  type MainlineLanguageCatalog,
} from "./language-catalog.js";

export interface LanguageDetection {
  languageId: string;
  path: string;
  confidence: number;
  reason: string;
}

export interface MainlineLanguageService {
  inferLanguage(path: string): LanguageDetection;
  isSourceFile(path: string): boolean;
  isTestFile(path: string, languageId?: string): boolean;
  normalizeLanguage(languageId: string): string;
  displayName(languageId: string): string;
}

/**
 * ExtensionLanguageService 是新主线的最小语言识别实现。
 * 它只基于扩展名判断语言；旧 LanguageService 和 tree-sitter 能力后续通过 adapter 接入。
 */
export class ExtensionLanguageService implements MainlineLanguageService {
  readonly #catalog: MainlineLanguageCatalog;

  constructor(catalog: MainlineLanguageCatalog = defaultMainlineLanguageCatalog) {
    this.#catalog = catalog;
  }

  inferLanguage(path: string): LanguageDetection {
    const extension = extensionOf(path);
    const languageId = this.#catalog.inferLanguageId(path);

    return {
      languageId,
      path,
      confidence: languageId === "unknown" ? 0 : 0.75,
      reason:
        languageId === "unknown" ? "No known source extension matched." : `Matched ${extension}.`,
    };
  }

  isSourceFile(path: string): boolean {
    return this.inferLanguage(path).languageId !== "unknown";
  }

  isTestFile(path: string, languageId?: string): boolean {
    return this.#catalog.isTestFile(path, languageId);
  }

  normalizeLanguage(languageId: string): string {
    return this.#catalog.normalize(languageId);
  }

  displayName(languageId: string): string {
    return this.#catalog.displayName(languageId);
  }
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index).toLowerCase() : "";
}
