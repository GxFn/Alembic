import { inferLang } from './LanguageExtensionBuilder.js';
import { inferFilePriority } from './TargetClassifier.js';

export interface TargetFile {
  name: string;
  relativePath: string;
  language: string;
  totalLines: number;
  priority: string;
  content: string;
  truncated: boolean;
}

interface SourceFile {
  name: string;
  relativePath: string;
  targetName: string;
  content: string;
}

export function buildTargetFileMap(
  allFiles: SourceFile[],
  contentMaxLines: number,
  sort = false
): Record<string, TargetFile[]> {
  const targetFileMap: Record<string, TargetFile[]> = {};

  for (const file of allFiles) {
    if (!targetFileMap[file.targetName]) {
      targetFileMap[file.targetName] = [];
    }
    const lines = file.content.split('\n');
    targetFileMap[file.targetName].push({
      name: file.name,
      relativePath: file.relativePath,
      language: inferLang(file.name),
      totalLines: lines.length,
      priority: inferFilePriority(file.name),
      content: lines.slice(0, contentMaxLines).join('\n'),
      truncated: lines.length > contentMaxLines,
    });
  }

  if (sort) {
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    for (const targetName of Object.keys(targetFileMap)) {
      targetFileMap[targetName].sort(
        (left, right) => (priorityOrder[left.priority] ?? 1) - (priorityOrder[right.priority] ?? 1)
      );
    }
  }

  return targetFileMap;
}
