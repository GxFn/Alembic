import path from 'node:path';
import {
  type AlembicIdeFolderNames,
  DEFAULT_IDE_FOLDER_NAMES,
  type PartialAlembicIdeFolderNames,
  resolveIdeFolderNames,
} from './ide-folder-names.js';

export type AlembicIdeFolderNamesInput =
  | PartialAlembicIdeFolderNames
  | { ide?: PartialAlembicIdeFolderNames };

function resolveCursorFolderNames(folderNames?: AlembicIdeFolderNamesInput): AlembicIdeFolderNames {
  if (!folderNames) {
    return DEFAULT_IDE_FOLDER_NAMES;
  }

  const overrides =
    'ide' in folderNames ? folderNames.ide : (folderNames as PartialAlembicIdeFolderNames);
  return resolveIdeFolderNames(overrides);
}

export function getCursorRoot(
  projectRoot: string,
  folderNames?: AlembicIdeFolderNamesInput
): string {
  return path.join(projectRoot, resolveCursorFolderNames(folderNames).cursorRoot);
}

export function getCursorRulesDir(
  projectRoot: string,
  folderNames?: AlembicIdeFolderNamesInput
): string {
  const resolved = resolveCursorFolderNames(folderNames);
  return path.join(projectRoot, resolved.cursorRoot, resolved.cursorRules);
}

export function getCursorSkillsDir(
  projectRoot: string,
  folderNames?: AlembicIdeFolderNamesInput
): string {
  const resolved = resolveCursorFolderNames(folderNames);
  return path.join(projectRoot, resolved.cursorRoot, resolved.cursorSkills);
}

export function getCursorRelativePath(...segments: string[]): string {
  return path.join(DEFAULT_IDE_FOLDER_NAMES.cursorRoot, ...segments);
}

export function getCursorRulesRelativePath(...segments: string[]): string {
  return getCursorRelativePath(DEFAULT_IDE_FOLDER_NAMES.cursorRules, ...segments);
}

export function getCursorSkillsRelativePath(...segments: string[]): string {
  return getCursorRelativePath(DEFAULT_IDE_FOLDER_NAMES.cursorSkills, ...segments);
}
