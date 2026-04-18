/**
 * UpgradeService — IDE 集成升级服务
 *
 * 当 Alembic 发布新版本后，老用户执行 `asd upgrade` 即可更新所有 IDE 集成文件。
 * 底层委托 FileDeployer 按 MANIFEST 定义的策略执行，确保与 SetupService 使用同一套部署逻辑。
 *
 * 额外职责：
 *   - Skills 路径迁移（.asd/skills/ → Alembic/skills/）
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_KNOWLEDGE_BASE_DIR } from '../shared/ProjectMarkers.js';
import { ProjectRegistry } from '../shared/ProjectRegistry.js';
import { FileDeployer } from './deploy/FileDeployer.js';

export class UpgradeService {
  projectRoot: string;
  projectName: string;
  ghost: boolean;
  constructor(options: { projectRoot: string }) {
    this.projectRoot = resolve(options.projectRoot);
    this.projectName = this.projectRoot.split('/').pop() || '';
    this.ghost = ProjectRegistry.isGhost(this.projectRoot);
  }

  async run({ skillsOnly = false, mcpOnly = false } = {}) {
    const deployer = new FileDeployer({
      projectRoot: this.projectRoot,
      force: false,
      ghost: this.ghost,
    });

    let filter: string[] | undefined;
    if (skillsOnly) {
      filter = ['skills'];
    } else if (mcpOnly) {
      filter = ['mcp'];
    }

    const { deployed, skipped, errors } = deployer.deployAll('upgrade', { filter });

    if (errors.length > 0) {
      for (const { id, error } of errors) {
        console.error(`   ⚠ ${id}: ${error}`);
      }
    }

    // Skills 路径迁移（一次性操作，不属于文件部署）
    if (!skillsOnly && !mcpOnly) {
      this._migrateSkillsPath();
    }

    return { deployed, skipped, errors };
  }

  /* ═══ Skills 路径迁移 ═══════════════════════════════ */

  _migrateSkillsPath() {
    const oldSkillsDir = join(this.projectRoot, '.asd', 'skills');
    const newSkillsDir = join(this.projectRoot, DEFAULT_KNOWLEDGE_BASE_DIR, 'skills');

    if (!existsSync(oldSkillsDir)) {
      return;
    }
    if (!existsSync(join(this.projectRoot, DEFAULT_KNOWLEDGE_BASE_DIR))) {
      return;
    }

    try {
      mkdirSync(newSkillsDir, { recursive: true });
      const entries = readdirSync(oldSkillsDir, { withFileTypes: true });
      let migrated = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const src = join(oldSkillsDir, entry.name);
        const dest = join(newSkillsDir, entry.name);
        if (existsSync(dest)) {
          continue;
        }
        // 复制目录
        execSync(`cp -r "${src}" "${dest}"`, { stdio: 'pipe' });
        migrated++;
      }

      if (migrated > 0) {
      } else {
      }
    } catch (e: unknown) {
      console.error(`   ❌ 迁移失败: ${(e as Error).message}`);
    }
  }
}

export default UpgradeService;
