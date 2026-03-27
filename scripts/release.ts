#!/usr/bin/env node

/**
 * AutoSnippet 发布辅助脚本
 * 用途：自动化发布前检查和发布流程
 * 使用：node scripts/release.js [patch|minor|major]
 */

import { DASHBOARD_DIR, PACKAGE_ROOT, RESOURCES_DIR } from '../lib/shared/package-root.js';

const __dirname = import.meta.dirname;

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

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

function log(message: any, color = 'reset') {}

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
      const behind = exec('git rev-list HEAD..origin/main --count', {
        silent: true,
        ignoreError: true,
      })?.trim();
      if (behind && parseInt(behind) > 0) {
        this.warnings.push(`本地落后远程 ${behind} 个提交`);
        warning(`需要先 pull: git pull origin main`);
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

    if (majorVersion < 16) {
      this.errors.push(`Node.js 版本过低: ${nodeVersion} (需要 >=16)`);
      error(`Node.js: ${nodeVersion}`);
    } else {
      success(`Node.js: ${nodeVersion}`);
    }

    // 检查环境变量配置
    const envPath = path.join(PACKAGE_ROOT, '.env');
    if (!fs.existsSync(envPath)) {
      this.errors.push('.env 文件不存在');
      error('.env: 不存在');
    } else {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const nodeEnv = envContent.match(/NODE_ENV=(\w+)/)?.[1];

      if (nodeEnv === 'production') {
        this.errors.push('.env 已是生产环境，发布前应该是开发环境');
        error(`环境: ${nodeEnv} (应该是 development)`);
      } else {
        success(`环境: ${nodeEnv || 'development'}`);
      }

      // 检查是否有备份
      const backupPath = path.join(PACKAGE_ROOT, '.env.backup');
      if (fs.existsSync(backupPath)) {
        warning('.env.backup 已存在，可能有未完成的发布');
      }
    }
  }

  // 检查并构建前端（生产环境）
  buildFrontend() {
    header('构建前端（生产环境）');

    // 备份 .env
    info('备份 .env 文件...');
    const envPath = path.join(PACKAGE_ROOT, '.env');
    const backupPath = path.join(PACKAGE_ROOT, '.env.backup');

    if (fs.existsSync(envPath)) {
      fs.copyFileSync(envPath, backupPath);
      success('.env 已备份');
    }

    // 切换到生产环境
    info('切换到生产环境...');
    const envContent = fs.readFileSync(envPath, 'utf8');
    const productionEnv = envContent
      .replace(/NODE_ENV=.*/g, 'NODE_ENV=production')
      .replace(/VITE_API_BASE_URL=.*/g, 'VITE_API_BASE_URL=https://your-production-api.com');

    fs.writeFileSync(envPath, productionEnv);
    success('已切换到生产环境');

    // 构建 Dashboard
    try {
      info('构建 Dashboard...');
      exec('cd dashboard && npm run build');

      const distPath = path.join(DASHBOARD_DIR, 'dist/index.html');
      if (fs.existsSync(distPath)) {
        success('Dashboard 构建成功');
      } else {
        throw new Error('dist/index.html 不存在');
      }
    } catch (err: any) {
      this.errors.push('Dashboard 构建失败');
      error('Dashboard 构建失败');

      // 恢复环境
      warning('恢复开发环境...');
      fs.copyFileSync(backupPath, envPath);
      fs.unlinkSync(backupPath);

      throw err;
    }

    // 恢复开发环境（稍后在发布完成后再恢复）
    info('⚠️  记得在发布完成后恢复开发环境');
  }

  // 恢复开发环境
  restoreEnvironment() {
    header('恢复开发环境');

    const envPath = path.join(PACKAGE_ROOT, '.env');
    const backupPath = path.join(PACKAGE_ROOT, '.env.backup');

    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, envPath);
      fs.unlinkSync(backupPath);
      success('已恢复开发环境');
    } else {
      warning('未找到 .env.backup，请手动检查环境变量');
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
      exec('npm run test:integration');
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
      this.errors.forEach((err: any, i: any) => {});
    }

    if (this.warnings.length > 0) {
      warning(`发现 ${this.warnings.length} 个警告：`);
      this.warnings.forEach((warn: any, i: any) => {});
    }

    return this.errors.length === 0;
  }
}

// 发布流程
function release(versionType: any, checker: any) {
  header(`开始发布流程 (${versionType})`);

  // 读取当前版本
  const packageJson = require('../package.json');
  const currentVersion = packageJson.version;
  info(`当前版本: ${currentVersion}`);

  // 构建前端（生产环境）
  try {
    checker.buildFrontend();
  } catch (_err: any) {
    error('前端构建失败，发布中止');
    process.exit(1);
  }

  // 执行版本升级
  try {
    info(`执行 npm version ${versionType}...`);
    const newVersion = exec(`npm version ${versionType}`, { silent: true })?.trim();
    success(`版本已更新: ${currentVersion} → ${newVersion}`);

    info('请手动编辑 CHANGELOG.md，然后按回车继续...');
    // 等待用户输入
    require('node:child_process').spawnSync('read', ['-p', ''], {
      stdio: 'inherit',
      shell: true,
    });

    // 修正 commit（包含 dist/ 文件）
    info('提交所有变更（包括构建产物）...');
    exec('git add .');
    exec(`git commit --amend -m "chore: release ${newVersion}"`);
    exec(`git tag -f ${newVersion}`);
    success('Commit 和 tag 已更新');

    // 推送到 GitHub
    info('推送到 GitHub（触发自动发布）...');
    exec('git push origin main --tags');
    success('已推送到 GitHub，等待 Actions 自动发布');

    // 恢复开发环境
    checker.restoreEnvironment();

    header('🎉 发布流程完成！');
  } catch (err: any) {
    error('发布失败！');
    console.error(err.message);

    // 尝试恢复环境
    try {
      checker.restoreEnvironment();
    } catch (_restoreErr: any) {
      error('恢复环境失败，请手动检查 .env 文件');
    }

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
