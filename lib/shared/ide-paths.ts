import path from 'node:path';
import type { AlembicFolderNames } from './folder-names.js';
import { DEFAULT_FOLDER_NAMES } from './folder-names.js';

export function getCursorRoot(
  projectRoot: string,
  folderNames: AlembicFolderNames = DEFAULT_FOLDER_NAMES
): string {
  return path.join(projectRoot, folderNames.ide.cursorRoot);
}

export function getCursorRulesDir(
  projectRoot: string,
  folderNames: AlembicFolderNames = DEFAULT_FOLDER_NAMES
): string {
  return path.join(getCursorRoot(projectRoot, folderNames), folderNames.ide.cursorRules);
}

export function getCursorSkillsDir(
  projectRoot: string,
  folderNames: AlembicFolderNames = DEFAULT_FOLDER_NAMES
): string {
  return path.join(getCursorRoot(projectRoot, folderNames), folderNames.ide.cursorSkills);
}

export function getCursorRelativePath(...segments: string[]): string {
  return path.join(DEFAULT_FOLDER_NAMES.ide.cursorRoot, ...segments);
}

export function getCursorRulesRelativePath(...segments: string[]): string {
  return getCursorRelativePath(DEFAULT_FOLDER_NAMES.ide.cursorRules, ...segments);
}

export function getCursorSkillsRelativePath(...segments: string[]): string {
  return getCursorRelativePath(DEFAULT_FOLDER_NAMES.ide.cursorSkills, ...segments);
}
