import { validateFolderNameSegment } from '@alembic/core/workspace';

export interface AlembicIdeFolderNames {
  cursorRoot: string;
  cursorRules: string;
  cursorSkills: string;
  githubRoot: string;
  vscodeRoot: string;
}

export type PartialAlembicIdeFolderNames = Partial<AlembicIdeFolderNames>;

export const DEFAULT_IDE_FOLDER_NAMES: AlembicIdeFolderNames = {
  cursorRoot: '.cursor',
  cursorRules: 'rules',
  cursorSkills: 'skills',
  githubRoot: '.github',
  vscodeRoot: '.vscode',
};

export function resolveIdeFolderNames(
  overrides: PartialAlembicIdeFolderNames = {}
): AlembicIdeFolderNames {
  const resolved: AlembicIdeFolderNames = {
    ...DEFAULT_IDE_FOLDER_NAMES,
    ...overrides,
  };

  for (const [fieldName, value] of Object.entries(resolved)) {
    validateFolderNameSegment(value, `ide.${fieldName}`);
  }

  return resolved;
}
