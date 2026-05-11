import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TreeSitterParserConstructor } from "./types.js";

let parserClass: TreeSitterParserConstructor | null = null;
let parserNamespace: Record<string, unknown> | null = null;
let initialized = false;
let grammarsDirPromise: Promise<string> | null = null;

export async function initParser(): Promise<void> {
  if (initialized) {
    return;
  }

  const moduleNamespace = await import("web-tree-sitter");
  const resolvedNamespace = normalizeTreeSitterNamespace(moduleNamespace);
  const Parser = parserConstructorFromNamespace(resolvedNamespace);
  await Parser.init();

  parserNamespace = resolvedNamespace;
  parserClass = Parser;
  initialized = true;
}

export function getParserClass(): TreeSitterParserConstructor | null {
  return parserClass;
}

export function isParserReady(): boolean {
  return initialized && parserClass !== null && parserNamespace !== null;
}

export async function loadLanguageWasm(wasmFileName: string): Promise<unknown> {
  if (!isParserReady() || !parserNamespace || !parserClass) {
    throw new Error("web-tree-sitter parser is not initialized.");
  }

  const Language = languageLoaderFromNamespace(parserNamespace, parserClass);
  const wasmPath = path.join(await resolveGrammarsDir(), wasmFileName);
  const buffer = await readFile(wasmPath);
  return await Language.load(new Uint8Array(buffer));
}

export async function resolveGrammarsDir(): Promise<string> {
  grammarsDirPromise ??= findGrammarsDir();
  return await grammarsDirPromise;
}

async function findGrammarsDir(): Promise<string> {
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  let current = startDir;

  for (let depth = 0; depth < 12; depth++) {
    const candidate = path.resolve(current, "resources", "grammars");
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return path.resolve(process.cwd(), "resources", "grammars");
}

function normalizeTreeSitterNamespace(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const defaultExport = record.default;
  if (typeof defaultExport === "function") {
    return { ...record, Parser: defaultExport };
  }
  if (isRecord(defaultExport)) {
    return defaultExport;
  }
  return record;
}

function parserConstructorFromNamespace(
  namespace: Record<string, unknown>,
): TreeSitterParserConstructor {
  const candidate = namespace.Parser ?? namespace.default;
  if (typeof candidate !== "function" || !("init" in candidate)) {
    throw new Error("web-tree-sitter did not expose a Parser constructor.");
  }
  return candidate as TreeSitterParserConstructor;
}

function languageLoaderFromNamespace(
  namespace: Record<string, unknown>,
  Parser: TreeSitterParserConstructor,
): { readonly load: (bytes: Uint8Array) => Promise<unknown> } {
  const fromNamespace = namespace.Language;
  const fromParser = (Parser as unknown as Record<string, unknown>).Language;
  const candidate = fromNamespace ?? fromParser;
  if (
    (typeof candidate !== "function" && !isRecord(candidate)) ||
    typeof (candidate as Record<string, unknown>).load !== "function"
  ) {
    throw new Error("web-tree-sitter did not expose Language.load().");
  }
  return candidate as { readonly load: (bytes: Uint8Array) => Promise<unknown> };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
