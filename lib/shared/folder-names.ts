export interface AlembicFolderNames {
  package: {
    config: string;
    dashboard: string;
    injectableSkills: string;
    internalSkills: string;
    resources: string;
    templates: string;
  };
  dev: {
    chainRuns: string;
    docs: string;
    scratch: string;
  };
  global: {
    cache: string;
    root: string;
    snippets: string;
    workspaces: string;
  };
  project: {
    cache: string;
    candidates: string;
    context: string;
    knowledgeBase: string;
    logs: string;
    recipes: string;
    runtime: string;
    skills: string;
    wiki: string;
  };
  ide: {
    cursorRoot: string;
    cursorRules: string;
    cursorSkills: string;
    githubRoot: string;
    vscodeRoot: string;
  };
}

export type PartialAlembicFolderNames = {
  [SectionKey in keyof AlembicFolderNames]?: Partial<AlembicFolderNames[SectionKey]>;
};

export const DEFAULT_FOLDER_NAMES: AlembicFolderNames = {
  package: {
    config: 'config',
    dashboard: 'dashboard',
    injectableSkills: 'injectable-skills',
    internalSkills: 'skills',
    resources: 'resources',
    templates: 'templates',
  },
  dev: {
    chainRuns: 'chain-runs',
    docs: 'docs-dev',
    scratch: 'scratch',
  },
  global: {
    cache: 'cache',
    root: '.asd',
    snippets: 'snippets',
    workspaces: 'workspaces',
  },
  project: {
    cache: 'cache',
    candidates: 'candidates',
    context: 'context',
    knowledgeBase: 'Alembic',
    logs: 'logs',
    recipes: 'recipes',
    runtime: '.asd',
    skills: 'skills',
    wiki: 'wiki',
  },
  ide: {
    cursorRoot: '.cursor',
    cursorRules: 'rules',
    cursorSkills: 'skills',
    githubRoot: '.github',
    vscodeRoot: '.vscode',
  },
};

export function validateFolderNameSegment(name: unknown, label: string): string {
  if (typeof name !== 'string') {
    throw new Error(`${label} must be a string folder name`);
  }
  if (name.trim() !== name || name.length === 0) {
    throw new Error(`${label} must be a non-empty folder name without surrounding whitespace`);
  }
  if (name === '.' || name === '..') {
    throw new Error(`${label} must not be a relative path marker`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`${label} must be a single folder name, not a path`);
  }
  if (name.startsWith('~')) {
    throw new Error(`${label} must be a folder name, not a home-relative path`);
  }
  return name;
}

export function resolveFolderNames(overrides: PartialAlembicFolderNames = {}): AlembicFolderNames {
  const resolved: AlembicFolderNames = {
    package: { ...DEFAULT_FOLDER_NAMES.package, ...overrides.package },
    dev: { ...DEFAULT_FOLDER_NAMES.dev, ...overrides.dev },
    global: { ...DEFAULT_FOLDER_NAMES.global, ...overrides.global },
    project: { ...DEFAULT_FOLDER_NAMES.project, ...overrides.project },
    ide: { ...DEFAULT_FOLDER_NAMES.ide, ...overrides.ide },
  };

  for (const [sectionName, section] of Object.entries(resolved)) {
    for (const [fieldName, value] of Object.entries(section)) {
      validateFolderNameSegment(value, `${sectionName}.${fieldName}`);
    }
  }

  return resolved;
}
