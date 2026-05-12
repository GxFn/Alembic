import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceResolver } from '../shared/WorkspaceResolver.js';

export type CodexKnowledgeStatus = 'not_initialized' | 'initialized_empty' | 'knowledge_ready';

export interface CodexKnowledgeState {
  hasKnowledge: boolean;
  initialized: boolean;
  recipeCount: number;
  skillCount: number;
  status: CodexKnowledgeStatus;
  usable: boolean;
}

export const EMPTY_CODEX_KNOWLEDGE_STATE: CodexKnowledgeState = {
  hasKnowledge: false,
  initialized: false,
  recipeCount: 0,
  skillCount: 0,
  status: 'not_initialized',
  usable: false,
};

export function inspectCodexKnowledge(projectRoot: string): CodexKnowledgeState {
  let resolver: WorkspaceResolver;
  try {
    resolver = WorkspaceResolver.fromProject(projectRoot);
  } catch {
    resolver = new WorkspaceResolver({ projectRoot });
  }
  const initialized =
    existsSync(resolver.configPath) &&
    existsSync(resolver.databasePath) &&
    existsSync(resolver.knowledgeDir) &&
    existsSync(resolver.recipesDir);
  const recipeCount = countMarkdownFiles(resolver.recipesDir, {
    excludeNames: new Set(['_template.md']),
  });
  const skillCount = countSkillFiles(resolver.skillsDir);
  const hasKnowledge = recipeCount > 0 || skillCount > 0;
  const usable = initialized && hasKnowledge;
  return {
    hasKnowledge,
    initialized,
    recipeCount,
    skillCount,
    status: usable ? 'knowledge_ready' : initialized ? 'initialized_empty' : 'not_initialized',
    usable,
  };
}

function countMarkdownFiles(dir: string, options: { excludeNames?: Set<string> } = {}): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce((count, entry) => {
      if (entry.isDirectory()) {
        return count + countMarkdownFiles(join(dir, entry.name), options);
      }
      return (
        count +
        (entry.isFile() && entry.name.endsWith('.md') && !options.excludeNames?.has(entry.name)
          ? 1
          : 0)
      );
    }, 0);
  } catch {
    return 0;
  }
}

function countSkillFiles(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce(
      (count, entry) =>
        count + (entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')) ? 1 : 0),
      0
    );
  } catch {
    return 0;
  }
}
