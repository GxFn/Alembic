/** Vitest 测试环境设置 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';

// 测试沙箱硬隔离（2026-07-06 事故修复）：集成测试经 AppRuntime 全链初始化时，
// WorkspaceResolver 会从 cwd walk-up 解析到父工作区（AlembicWorkspace）的真实
// 数据根 ~/.asd/workspaces/<id>——KnowledgeCRUD 等测试曾直接清写用户受保护
// 知识库（76 条 → 21 条 fixture，靠 recipes/candidates 物化 .md 才得以恢复）。
// 每个 vitest worker 进程绑定一次性临时 ALEMBIC_HOME，让所有 resolver 路径
// （DB/向量索引/daemon state/registry）都落在沙箱内；显式设置过 ALEMBIC_HOME
// 的场景（如专项隔离验收）尊重外部值。
if (!process.env.ALEMBIC_HOME) {
  process.env.ALEMBIC_HOME = mkdtempSync(join(tmpdir(), 'alembic-vitest-home-'));
}
// 防 walk-up 逃逸的第二道闸：项目根固定指向沙箱内目录，而不是仓库 cwd。
if (!process.env.ALEMBIC_PROJECT_DIR) {
  process.env.ALEMBIC_PROJECT_DIR = mkdtempSync(join(tmpdir(), 'alembic-vitest-project-'));
}

export default {};
