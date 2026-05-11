import { plugin as dartPlugin, setGrammar as setDartGrammar } from "./ast/lang-dart.js";
import { plugin as goPlugin, setGrammar as setGoGrammar } from "./ast/lang-go.js";
import { plugin as javaPlugin, setGrammar as setJavaGrammar } from "./ast/lang-java.js";
import { plugin as kotlinPlugin, setGrammar as setKotlinGrammar } from "./ast/lang-kotlin.js";
import { plugin as objcPlugin, setGrammar as setObjcGrammar } from "./ast/lang-objc.js";
import { plugin as rustPlugin, setGrammar as setRustGrammar } from "./ast/lang-rust.js";
import { setGrammar as setSwiftGrammar, plugin as swiftPlugin } from "./ast/lang-swift.js";
import { javascriptPlugin, setJavaScriptGrammar } from "./lang-javascript.js";
import { pythonPlugin, setPythonGrammar } from "./lang-python.js";
import {
  setTsxGrammar,
  setTypeScriptGrammar,
  tsxPlugin,
  typescriptPlugin,
} from "./lang-typescript.js";
import { initParser, loadLanguageWasm } from "./parser-init.js";
import type {
  EngineeringTreeSitterLanguageId,
  EngineeringTreeSitterLanguagePlugin,
} from "./types.js";

interface BuiltinLanguageEntry {
  readonly languageId: EngineeringTreeSitterLanguageId;
  readonly wasmFile: string;
  readonly plugin: EngineeringTreeSitterLanguagePlugin;
  setGrammar(grammar: unknown): void;
}

const BUILTIN_LANGUAGES: readonly BuiltinLanguageEntry[] = [
  {
    languageId: "typescript",
    wasmFile: "tree-sitter-typescript.wasm",
    plugin: typescriptPlugin,
    setGrammar: setTypeScriptGrammar,
  },
  {
    languageId: "tsx",
    wasmFile: "tree-sitter-tsx.wasm",
    plugin: tsxPlugin,
    setGrammar: setTsxGrammar,
  },
  {
    languageId: "javascript",
    wasmFile: "tree-sitter-javascript.wasm",
    plugin: javascriptPlugin,
    setGrammar: setJavaScriptGrammar,
  },
  {
    languageId: "python",
    wasmFile: "tree-sitter-python.wasm",
    plugin: pythonPlugin,
    setGrammar: setPythonGrammar,
  },
  {
    languageId: "swift",
    wasmFile: "tree-sitter-swift.wasm",
    plugin: swiftPlugin as unknown as EngineeringTreeSitterLanguagePlugin,
    setGrammar: setSwiftGrammar,
  },
  {
    languageId: "objectivec",
    wasmFile: "tree-sitter-objc.wasm",
    plugin: objcPlugin as unknown as EngineeringTreeSitterLanguagePlugin,
    setGrammar: setObjcGrammar,
  },
  {
    languageId: "java",
    wasmFile: "tree-sitter-java.wasm",
    plugin: javaPlugin as unknown as EngineeringTreeSitterLanguagePlugin,
    setGrammar: setJavaGrammar,
  },
  {
    languageId: "kotlin",
    wasmFile: "tree-sitter-kotlin.wasm",
    plugin: kotlinPlugin as unknown as EngineeringTreeSitterLanguagePlugin,
    setGrammar: setKotlinGrammar,
  },
  {
    languageId: "go",
    wasmFile: "tree-sitter-go.wasm",
    plugin: goPlugin as unknown as EngineeringTreeSitterLanguagePlugin,
    setGrammar: setGoGrammar,
  },
  {
    languageId: "dart",
    wasmFile: "tree-sitter-dart.wasm",
    plugin: dartPlugin as unknown as EngineeringTreeSitterLanguagePlugin,
    setGrammar: setDartGrammar,
  },
  {
    languageId: "rust",
    wasmFile: "tree-sitter-rust.wasm",
    plugin: rustPlugin as unknown as EngineeringTreeSitterLanguagePlugin,
    setGrammar: setRustGrammar,
  },
];

const languagePlugins = new Map<
  EngineeringTreeSitterLanguageId,
  EngineeringTreeSitterLanguagePlugin
>();
const parserCacheClearers = new Set<() => void>();
let initialized = false;

export async function initializeTreeSitterRuntime(
  languages: readonly EngineeringTreeSitterLanguageId[] = BUILTIN_LANGUAGES.map(
    (entry) => entry.languageId,
  ),
): Promise<void> {
  if (initialized && languages.every((languageId) => languagePlugins.has(languageId))) {
    return;
  }

  await initParser();
  const requested = new Set(languages);
  for (const entry of BUILTIN_LANGUAGES) {
    if (!requested.has(entry.languageId) || languagePlugins.has(entry.languageId)) {
      continue;
    }
    // 中文说明：web-tree-sitter 在部分 Node/wasm 组合下并行加载会偶发竞态。
    const grammar = await loadLanguageWasm(entry.wasmFile);
    entry.setGrammar(grammar);
    registerLanguage(entry.languageId, entry.plugin);
  }
  initialized = true;
}

export function registerLanguage(
  languageId: EngineeringTreeSitterLanguageId,
  plugin: EngineeringTreeSitterLanguagePlugin,
): void {
  languagePlugins.set(languageId, plugin);
  for (const clearParserCache of parserCacheClearers) {
    clearParserCache();
  }
}

export function getLanguagePlugin(
  languageId: EngineeringTreeSitterLanguageId,
): EngineeringTreeSitterLanguagePlugin | null {
  return languagePlugins.get(languageId) ?? null;
}

export function supportedLanguages(): readonly EngineeringTreeSitterLanguageId[] {
  return [...languagePlugins.keys()].sort();
}

export function knownLanguages(): readonly EngineeringTreeSitterLanguageId[] {
  return BUILTIN_LANGUAGES.map((entry) => entry.languageId);
}

export function hasRegisteredLanguage(languageId?: EngineeringTreeSitterLanguageId): boolean {
  return languageId ? languagePlugins.has(languageId) : languagePlugins.size > 0;
}

export function onLanguageRegistryChanged(clearParserCache: () => void): void {
  parserCacheClearers.add(clearParserCache);
}
