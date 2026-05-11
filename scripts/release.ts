#!/usr/bin/env node

/**
 * Alembic 发布辅助脚本
 * 用途：自动化发布前检查、版本提交和 tag 推送
 * 使用：node dist/scripts/release.js [check|patch|minor|major]
 *
 * npm 包发布由 .github/workflows/release.yml 在 v* tag 推送后完成。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DASHBOARD_DIR, PACKAGE_ROOT } from '../lib/shared/package-root.js';

const require = createRequire(import.meta.url);
// 颜色输出
const _colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(message: any, color = 'reset') {
  const code = _colors[color as keyof typeof _colors] ?? '';
  console.log(`${code}${message}${_colors.reset}`);
}

function success(message: any) {
  log(`✅ ${message}`, 'green');
}

function error(message: any) {
  log(`❌ ${message}`, 'red');
}

function warning(message: any) {
  log(`⚠️  ${message}`, 'yellow');
}

function info(message: any) {
  log(`ℹ️  ${message}`, 'blue');
}

function header(message: any) {
  log(`\n${'='.repeat(60)}`, 'bold');
  log(`  ${message}`, 'bold');
  log(`${'='.repeat(60)}`, 'bold');
}

function exec(command: any, options: any = {}) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options,
    });
  } catch (err: any) {
    if (!options.ignoreError) {
      throw err;
    }
    return null;
  }
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
}

// 检查项
class ReleaseChecker {
  errors: any;
  warnings: any;
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  // 检查 Git 状态
  checkGitStatus() {
    header('Git 状态检查');

    // 检查分支
    const branch = exec('git branch --show-current', { silent: true })?.trim();
    if (branch !== 'main' && branch !== 'master') {
      this.errors.push(`当前分支不是 main/master: ${branch}`);
      error(`当前分支: ${branch}`);
    } else {
      success(`当前分支: ${branch}`);
    }

    // 检查工作区
    const status = exec('git status --short', { silent: true });
    if (status?.trim()) {
      this.errors.push('工作区有未提交的变更');
      error('工作区不干净:');
    } else {
      success('工作区干净');
    }

    // 检查远程同步
    try {
      exec('git fetch origin', { silent: true });
      const behind = exec(`git rev-list HEAD..origin/${branch} --count`, {
        silent: true,
        ignoreError: true,
      })?.trim();
      if (behind && parseInt(behind) > 0) {
        this.warnings.push(`本地落后远程 ${behind} 个提交`);
        warning(`需要先 pull: git pull origin ${branch}`);
      } else {
        success('与远程同步');
      }
    } catch (_err: any) {
      warning('无法检查远程同步状态');
    }
  }

  // 检查 Node.js 环境
  checkNodeEnvironment() {
    header('Node.js 环境检查');

    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);

    if (majorVersion < 22) {
      this.errors.push(`Node.js 版本过低: ${nodeVersion} (需要 >=22)`);
      error(`Node.js: ${nodeVersion}`);
    } else {
      success(`Node.js: ${nodeVersion}`);
    }

    // 检查环境变量配置。发布不再改写 .env；CI 会在 tag 推送后独立构建和发布。
    const envPath = path.join(PACKAGE_ROOT, '.env');
    if (!fs.existsSync(envPath)) {
      warning('.env: 不存在（发布流程不依赖本地 .env）');
    } else {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const nodeEnv = envContent.match(/NODE_ENV=(\w+)/)?.[1];

      if (nodeEnv === 'production') {
        warning(`环境: ${nodeEnv}（发布流程不会改写 .env）`);
      } else {
        success(`环境: ${nodeEnv || 'development'}`);
      }

      const backupPath = path.join(PACKAGE_ROOT, '.env.backup');
      if (fs.existsSync(backupPath)) {
        warning('.env.backup 已存在，请确认是否为旧发布流程遗留');
      }
    }
  }

  // 本地构建校验。真正的发布构建会在 GitHub Actions 中再次执行。
  buildArtifacts() {
    header('构建发布产物');

    try {
      info('构建 TypeScript...');
      exec('npm run build');
      success('TypeScript 构建成功');

      info('构建 Dashboard...');
      exec('npm run build:dashboard');

      const distPath = path.join(DASHBOARD_DIR, 'dist/index.html');
      if (fs.existsSync(distPath)) {
        success('Dashboard 构建成功');
      } else {
        throw new Error('dist/index.html 不存在');
      }

      info('构建 VS Code 扩展...');
      exec('npm run build:vscode-ext');
      success('VS Code 扩展构建成功');
    } catch (err: any) {
      this.errors.push('发布产物构建失败');
      error('发布产物构建失败');
      throw err;
    }
  }

  // 检查其他构建产物
  checkBuildArtifacts() {
    header('其他构建产物检查');
    success('No platform-specific binaries to check');
  }

  // 运行测试
  runTests() {
    header('运行测试');

    try {
      info('运行单元测试...');
      exec('npm run test:unit');
      success('单元测试通过');
    } catch (_err: any) {
      this.errors.push('单元测试失败');
      error('单元测试失败');
    }

    try {
      info('运行集成测试...');
      exec('npm run test:integration', {
        env: {
          ...process.env,
          ASD_DISABLE_WRITE_GUARD: '1',
          ASD_DISABLE_RATE_LIMIT: '1',
        },
      });
      success('集成测试通过');
    } catch (_err: any) {
      this.errors.push('集成测试失败');
      error('集成测试失败');
    }
  }

  // 总结
  summary() {
    header('检查总结');

    if (this.errors.length === 0 && this.warnings.length === 0) {
      success('所有检查通过，可以发布！');
      return true;
    }

    if (this.errors.length > 0) {
      error(`发现 ${this.errors.length} 个错误：`);
      this.errors.forEach((err: any, i: any) => {
        error(`  ${i + 1}. ${err}`);
      });
    }

    if (this.warnings.length > 0) {
      warning(`发现 ${this.warnings.length} 个警告：`);
      this.warnings.forEach((warn: any, i: any) => {
        warning(`  ${i + 1}. ${warn}`);
      });
    }

    return this.errors.length === 0;
  }
}

// 发布流程
function release(versionType: any, checker: any) {
  header(`开始发布流程 (${versionType})`);

  // 读取当前版本
  const packageJson = readPackageJson();
  const currentVersion = packageJson.version;
  info(`当前版本: ${currentVersion}`);

  // 构建产物（本地预检；GitHub Actions 会在 tag 推送后再次构建）
  try {
    checker.buildArtifacts();
  } catch (_err: any) {
    error('构建失败，发布中止');
    process.exit(1);
  }

  // 执行版本升级
  try {
    info(`执行 npm version ${versionType} --no-git-tag-version...`);
    exec(`npm version ${versionType} --no-git-tag-version`, { silent: true });
    const newVersion = `v${readPackageJson().version}`;
    success(`版本已更新: ${currentVersion} → ${newVersion}`);

    info('请手动编辑 CHANGELOG.md，然后按回车继续...');
    // 等待用户输入
    require('node:child_process').spawnSync('read', ['-p', ''], {
      stdio: 'inherit',
      shell: true,
    });

    info('提交版本文件...');
    exec('git add package.json package-lock.json CHANGELOG.md');
    exec(`git commit -m "chore: release ${newVersion}"`);
    exec(`git tag ${newVersion}`);
    success('Release commit 和 tag 已创建');

    info('推送到 GitHub（触发 Release Action 自动发布 npm 包）...');
    exec('git push origin HEAD');
    exec(`git push origin ${newVersion}`);
    success('已推送到 GitHub，等待 Actions 构建、测试并发布 npm 包');

    header('🎉 发布流程完成！');
  } catch (err: any) {
    error('发布失败！');
    console.error(err.message);
    process.exit(1);
  }
}

// 主函数
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // 显示帮助
  if (!command || command === '--help' || command === '-h') {
    process.exit(0);
  }

  // 执行检查
  if (command === 'check') {
    const checker = new ReleaseChecker();
    checker.checkGitStatus();
    checker.checkNodeEnvironment();
    checker.checkBuildArtifacts();

    if (checker.summary()) {
      info('\n运行 `npm run test` 来执行完整测试');
      info('运行 `npm run release:patch/minor/major` 开始发布');
      process.exit(0);
    } else {
      error('\n请修复错误后再试');
      process.exit(1);
    }
  }

  // 执行发布
  if (['patch', 'minor', 'major'].includes(command)) {
    // 先执行检查
    const checker = new ReleaseChecker();
    checker.checkGitStatus();
    checker.checkNodeEnvironment();
    checker.checkBuildArtifacts();
    checker.runTests();

    if (!checker.summary()) {
      error('\n发布前检查未通过，请修复后再试');
      process.exit(1);
    }
    warning(`即将发布 ${command} 版本，是否继续？(y/N)`);

    const readline = require('node:readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    readline.question('> ', (answer: any) => {
      readline.close();

      if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        release(command, checker);
      } else {
        info('已取消发布');
        process.exit(0);
      }
    });

    return;
  }

  // 未知命令
  error(`未知命令: ${command}`);
  process.exit(1);
}

// 执行
main();
