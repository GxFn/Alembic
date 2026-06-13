/**
 * Alembic package asset paths.
 *
 * Core owns generic package-root primitives; this adapter keeps Alembic-owned
 * config, templates, resources, dashboard, and package skill paths anchored
 * to the outer `alembic-ai` package.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_FOLDER_NAMES } from '@alembic/core/workspace';

const __dirname = import.meta.dirname;

function findAlembicPackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
        if (pkg.name === 'alembic-ai') {
          return dir;
        }
      } catch {
        // Continue walking ancestors.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('[Alembic] Could not locate package root for alembic-ai.');
}

export const PACKAGE_ROOT = findAlembicPackageRoot();

export const CONFIG_DIR = path.join(PACKAGE_ROOT, DEFAULT_FOLDER_NAMES.package.config);

export const PACKAGE_SKILLS_DIR = path.join(
  PACKAGE_ROOT,
  DEFAULT_FOLDER_NAMES.package.internalSkills
);

export const INTERNAL_SKILLS_DIR = PACKAGE_SKILLS_DIR;
export const SKILLS_DIR = PACKAGE_SKILLS_DIR;

export const TEMPLATES_DIR = path.join(PACKAGE_ROOT, DEFAULT_FOLDER_NAMES.package.templates);

export const RESOURCES_DIR = path.join(PACKAGE_ROOT, DEFAULT_FOLDER_NAMES.package.resources);

export const DASHBOARD_DIR = path.join(PACKAGE_ROOT, DEFAULT_FOLDER_NAMES.package.dashboard);
