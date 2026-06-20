#!/usr/bin/env node
/**
 * check-shared-asset-drift.mjs — Shared-asset drift gate (Alembic ↔ AlembicPlugin)
 *
 * 按 config/shared-asset-manifest.json 比较本仓库与兄弟仓库 AlembicPlugin 的共享资产：
 *   - skill-shared-sections: 比较 SKILL.md 中 wakeflow-shared 标记段（标记段外的 host overlay 是声明的宿主差异）；
 *                            manifest 的 perHostSections 列出的段承载真 host-divergent 工具面，从 cross-host
 *                            coherence 排除（每侧即该 host 的 per-host 权威），其余 shared 段仍须 codex/cc 一致
 *   - main-only:             资产只允许存在于主仓库，插件侧出现未声明副本即失败
 *   - line-variants:         整文件比较，声明的 per-host 变体行替换为占位符后必须完全一致
 *   - exact:                 单文件精确比较（仅归一化换行、行尾空白和首尾空行）
 *   - json-exclude-paths:    JSON 深比较，排除声明的键路径（如 config/default.json 的 ai 块）
 *   - directory-exact:       目录逐文件精确比较，可对单文件声明变体行
 * 另外自检 selfCheckFiles（manifest + 本脚本）在插件侧的副本是否一致。
 *
 * 退出语义（分支原因都会打印，便于排查）：
 *   - 兄弟仓库 checkout 不存在 → 打印 skip 通知，退出 0（standalone clone 安全）
 *   - 共享段内容漂移 / 未声明差异 → 退出 1
 *   - pending-sync（插件侧尚未携带标记或脚本/清单副本，p2 落地前的过渡态）：
 *       默认退出 1；带 --allow-pending-sync 时仅通知并退出 0，主仓库 check 在 p2 前保持绿色
 *
 * 用法: node scripts/check-shared-asset-drift.mjs [--allow-pending-sync] [--sibling <path>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'config', 'shared-asset-manifest.json');

const args = process.argv.slice(2);
const allowPendingSync = args.includes('--allow-pending-sync');
const siblingArgIdx = args.indexOf('--sibling');
const siblingOverride = siblingArgIdx >= 0 ? args[siblingArgIdx + 1] : undefined;

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// ── 兄弟仓库定位：--sibling > 环境变量 > manifest 默认相对路径 ──
const siblingPath = path.resolve(
  repoRoot,
  siblingOverride ?? process.env[manifest.sibling.envVar] ?? manifest.sibling.defaultPath
);

const results = [];

function record(status, assetId, detail) {
  results.push({ status, assetId, detail });
}

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

// 归一化：去行尾空白、统一换行、去首尾空行 — 共享段比较只关心内容
function normalizeBlock(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

// ── SKILL.md 共享段解析 ─────────────────────────────────────
const SHARED_BEGIN_RE = /^<!-- wakeflow-shared:begin section="([A-Za-z0-9_-]+)" -->$/;
const SHARED_END = '<!-- wakeflow-shared:end -->';

function parseSharedSections(content, label) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const begin = SHARED_BEGIN_RE.exec(line);
    if (begin) {
      if (current) {
        throw new Error(`${label}: nested wakeflow-shared:begin at line ${i + 1}`);
      }
      if (sections.some((s) => s.name === begin[1])) {
        throw new Error(`${label}: duplicate shared section "${begin[1]}"`);
      }
      current = { name: begin[1], startLine: i + 1, body: [] };
      continue;
    }
    if (line === SHARED_END) {
      if (!current) {
        throw new Error(`${label}: wakeflow-shared:end without begin at line ${i + 1}`);
      }
      sections.push({ name: current.name, content: normalizeBlock(current.body.join('\n')) });
      current = null;
      continue;
    }
    if (current) {
      current.body.push(lines[i]);
    }
  }
  if (current) {
    throw new Error(`${label}: unclosed shared section "${current.name}"`);
  }
  return sections;
}

function parseFrontmatterName(content) {
  const match = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }
  const nameLine = match[1].split('\n').find((l) => l.startsWith('name:'));
  return nameLine ? nameLine.slice('name:'.length).trim() : null;
}

function checkSkillSharedSections(asset) {
  const mainContent = readFileOrNull(path.join(repoRoot, asset.path));
  const pluginContent = readFileOrNull(path.join(siblingPath, asset.path));
  if (mainContent === null) {
    record('drift', asset.id, `main file missing: ${asset.path}`);
    return;
  }
  if (pluginContent === null) {
    record('drift', asset.id, `plugin file missing: ${asset.path}`);
    return;
  }
  let mainSections;
  try {
    mainSections = parseSharedSections(mainContent, `main ${asset.path}`);
  } catch (err) {
    record('drift', asset.id, err instanceof Error ? err.message : String(err));
    return;
  }
  if (mainSections.length === 0) {
    // 主仓库是共享段权威，缺标记说明 manifest 与源文件脱节，按漂移处理
    record('drift', asset.id, `main file carries no wakeflow-shared markers: ${asset.path}`);
    return;
  }
  let pluginSections;
  try {
    pluginSections = parseSharedSections(pluginContent, `plugin ${asset.path}`);
  } catch (err) {
    record('drift', asset.id, err instanceof Error ? err.message : String(err));
    return;
  }
  if (pluginSections.length === 0) {
    // p2 落地前插件侧尚未携带标记 — 过渡态，不算内容漂移
    record(
      'pending-sync',
      asset.id,
      'plugin copy carries no wakeflow-shared markers yet (p2 pending)'
    );
    return;
  }
  const problems = [];
  const mainName = parseFrontmatterName(mainContent);
  const pluginName = parseFrontmatterName(pluginContent);
  if (mainName !== pluginName) {
    problems.push(`frontmatter name differs: main=${mainName} plugin=${pluginName}`);
  }
  // ── per-host 段处理（DH-4b：dual-host 工具面分叉） ──────────────
  // perHostSections 声明的共享段承载真 host-divergent 的工具面（codex/main: alembic_knowledge /
  // alembic_guard / alembic_structure(...) ↔ claude-code/plugin: alembic_search / alembic_code_guard /
  // alembic_project_matrix(...)）。这些段从 cross-host coherence 比较中排除：每侧文件就是该 host 的
  // per-host 权威，互不比较，避免强行对齐改掉某一宿主四工具对外语义。其余非 host 的 shared 段仍须
  // codex/cc 一致（cross-host coherence 保留）。
  const perHostSections = new Set(asset.perHostSections ?? []);
  const mainCoherence = mainSections.filter((s) => !perHostSections.has(s.name));
  const pluginCoherence = pluginSections.filter((s) => !perHostSections.has(s.name));
  const mainNames = mainCoherence.map((s) => s.name).join(',');
  const pluginNames = pluginCoherence.map((s) => s.name).join(',');
  if (mainNames !== pluginNames) {
    problems.push(`shared section sequence differs: main=[${mainNames}] plugin=[${pluginNames}]`);
  } else {
    for (let i = 0; i < mainCoherence.length; i++) {
      if (mainCoherence[i].content !== pluginCoherence[i].content) {
        problems.push(`shared section "${mainCoherence[i].name}" content drifted`);
      }
    }
  }
  // 声明的 per-host 段必须存在于 main（codex/main 权威）侧，防止 manifest 声明与源文件脱节后静默漏检
  const mainSectionNames = new Set(mainSections.map((s) => s.name));
  for (const name of perHostSections) {
    if (!mainSectionNames.has(name)) {
      problems.push(`declared per-host section "${name}" missing from main authority`);
    }
  }
  if (problems.length > 0) {
    record('drift', asset.id, problems.join('; '));
  } else {
    const perHostNote =
      perHostSections.size > 0
        ? `, ${perHostSections.size} per-host section(s) coherence-skipped`
        : '';
    record('ok', asset.id, `${mainCoherence.length} shared sections in sync${perHostNote}`);
  }
}

// ── main-only：插件侧必须不存在 ─────────────────────────────
function checkMainOnly(asset) {
  if (!fs.existsSync(path.join(repoRoot, asset.path))) {
    record('drift', asset.id, `declared main-only asset missing in main: ${asset.path}`);
    return;
  }
  if (fs.existsSync(path.join(siblingPath, asset.path))) {
    record('drift', asset.id, `undeclared plugin copy exists for main-only asset: ${asset.path}`);
  } else {
    record('ok', asset.id, 'main-only as declared');
  }
}

// ── line-variants：声明变体行替换占位符后整文件必须一致 ──────
function applyLineVariants(content, variants, side, missing) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (const variant of variants) {
    const target = side === 'main' ? variant.mainLine : variant.pluginLine;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === target) {
        const indent = lines[i].slice(0, lines[i].length - lines[i].trimStart().length);
        lines[i] = `${indent}«variant:${variant.key}»`;
        found = true;
      }
    }
    if (!found) {
      missing.push(`${side} side missing declared variant line for ${variant.key}`);
    }
  }
  return lines.join('\n');
}

function compareWithVariants(asset, relPath, variants) {
  const mainContent = readFileOrNull(path.join(repoRoot, relPath));
  const pluginContent = readFileOrNull(path.join(siblingPath, relPath));
  if (mainContent === null || pluginContent === null) {
    return [
      `file missing: ${relPath} (main=${mainContent !== null} plugin=${pluginContent !== null})`,
    ];
  }
  const problems = [];
  const mainSub = applyLineVariants(mainContent, variants, 'main', problems);
  const pluginSub = applyLineVariants(pluginContent, variants, 'plugin', problems);
  if (normalizeBlock(mainSub) !== normalizeBlock(pluginSub)) {
    problems.push(`content differs beyond declared variants: ${relPath}`);
  }
  return problems;
}

function checkLineVariants(asset) {
  const problems = compareWithVariants(asset, asset.path, asset.variants ?? []);
  if (problems.length > 0) {
    record('drift', asset.id, problems.join('; '));
  } else {
    record(
      'ok',
      asset.id,
      `identical modulo ${asset.variants?.length ?? 0} declared variant lines`
    );
  }
}

// ── exact：单文件精确比较（仅归一化换行、行尾空白和首尾空行） ───
function checkExactFile(asset) {
  const mainContent = readFileOrNull(path.join(repoRoot, asset.path));
  const pluginContent = readFileOrNull(path.join(siblingPath, asset.path));
  if (mainContent === null || pluginContent === null) {
    record(
      'drift',
      asset.id,
      `file missing: ${asset.path} (main=${mainContent !== null} plugin=${pluginContent !== null})`
    );
    return;
  }
  if (normalizeBlock(mainContent) !== normalizeBlock(pluginContent)) {
    record('drift', asset.id, `content differs: ${asset.path}`);
  } else {
    record('ok', asset.id, 'files in sync');
  }
}

// ── json-exclude-paths：JSON 深比较，排除声明键路径 ──────────
function deleteJsonPath(obj, dotPath) {
  const keys = dotPath.split('.');
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node === null || typeof node !== 'object') {
      return;
    }
    node = node[keys[i]];
  }
  if (node !== null && typeof node === 'object') {
    delete node[keys[keys.length - 1]];
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checkJsonExcludePaths(asset) {
  const mainContent = readFileOrNull(path.join(repoRoot, asset.path));
  const pluginContent = readFileOrNull(path.join(siblingPath, asset.path));
  if (mainContent === null || pluginContent === null) {
    record('drift', asset.id, `file missing: ${asset.path}`);
    return;
  }
  let mainJson;
  let pluginJson;
  try {
    mainJson = JSON.parse(mainContent);
    pluginJson = JSON.parse(pluginContent);
  } catch (err) {
    record(
      'drift',
      asset.id,
      `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  for (const excludePath of asset.excludePaths ?? []) {
    deleteJsonPath(mainJson, excludePath);
    deleteJsonPath(pluginJson, excludePath);
  }
  if (stableStringify(mainJson) !== stableStringify(pluginJson)) {
    record(
      'drift',
      asset.id,
      `JSON differs beyond excluded paths [${(asset.excludePaths ?? []).join(',')}]`
    );
  } else {
    record('ok', asset.id, `deep-equal excluding [${(asset.excludePaths ?? []).join(',')}]`);
  }
}

// ── directory-exact：目录逐文件精确比较（可声明单文件变体行） ──
function listFilesRecursive(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

function checkDirectoryExact(asset) {
  const mainDir = path.join(repoRoot, asset.path);
  const pluginDir = path.join(siblingPath, asset.path);
  if (!fs.existsSync(mainDir) || !fs.existsSync(pluginDir)) {
    record(
      'drift',
      asset.id,
      `directory missing: ${asset.path} (main=${fs.existsSync(mainDir)} plugin=${fs.existsSync(pluginDir)})`
    );
    return;
  }
  const mainFiles = listFilesRecursive(mainDir);
  const pluginFiles = listFilesRecursive(pluginDir);
  const problems = [];
  for (const f of mainFiles.filter((f) => !pluginFiles.includes(f))) {
    problems.push(`missing on plugin side: ${f}`);
  }
  for (const f of pluginFiles.filter((f) => !mainFiles.includes(f))) {
    problems.push(`extra on plugin side: ${f}`);
  }
  for (const f of mainFiles.filter((f) => pluginFiles.includes(f))) {
    const variants = asset.fileVariants?.[f];
    if (variants) {
      problems.push(...compareWithVariants(asset, `${asset.path}/${f}`, variants));
    } else {
      const mainContent = readFileOrNull(path.join(mainDir, f));
      const pluginContent = readFileOrNull(path.join(pluginDir, f));
      if (normalizeBlock(mainContent ?? '') !== normalizeBlock(pluginContent ?? '')) {
        problems.push(`content differs: ${f}`);
      }
    }
  }
  if (problems.length > 0) {
    record('drift', asset.id, problems.join('; '));
  } else {
    record('ok', asset.id, `${mainFiles.length} files in sync`);
  }
}

// ── selfCheck：脚本与 manifest 在插件侧的副本必须一致 ─────────
function checkSelfCheckFiles() {
  for (const rel of manifest.selfCheckFiles ?? []) {
    const mainContent = readFileOrNull(path.join(repoRoot, rel));
    const pluginContent = readFileOrNull(path.join(siblingPath, rel));
    if (mainContent === null) {
      record('drift', `self-check:${rel}`, 'main copy missing');
      continue;
    }
    if (pluginContent === null) {
      // p2 落地前插件侧还没有脚本/清单副本 — 过渡态
      record('pending-sync', `self-check:${rel}`, 'plugin copy not present yet (p2 pending)');
      continue;
    }
    if (normalizeBlock(mainContent) !== normalizeBlock(pluginContent)) {
      record('drift', `self-check:${rel}`, 'plugin copy differs from main authority');
    } else {
      record('ok', `self-check:${rel}`, 'copies match');
    }
  }
}

// ── 主流程 ──────────────────────────────────────────────────
// 兄弟仓库缺失（standalone clone）→ 明确通知后跳过，门禁不拦截
if (
  !fs.existsSync(siblingPath) ||
  !fs.existsSync(path.join(siblingPath, manifest.sibling.sanityPath))
) {
  console.log(
    `[shared-asset-drift] SKIP — sibling checkout not found at ${siblingPath} ` +
      `(set ${manifest.sibling.envVar} or use --sibling to point at ${manifest.sibling.name}). ` +
      'Standalone clones skip this gate by design.'
  );
  process.exit(0);
}

const MODE_HANDLERS = {
  'skill-shared-sections': checkSkillSharedSections,
  'main-only': checkMainOnly,
  'line-variants': checkLineVariants,
  exact: checkExactFile,
  'json-exclude-paths': checkJsonExcludePaths,
  'directory-exact': checkDirectoryExact,
};

for (const asset of manifest.assets) {
  const handler = MODE_HANDLERS[asset.mode];
  if (!handler) {
    record('drift', asset.id, `unknown comparison mode in manifest: ${asset.mode}`);
    continue;
  }
  handler(asset);
}
checkSelfCheckFiles();

const driftCount = results.filter((r) => r.status === 'drift').length;
const pendingCount = results.filter((r) => r.status === 'pending-sync').length;

console.log(`[shared-asset-drift] sibling: ${siblingPath}`);
for (const r of results) {
  console.log(`  [${r.status}] ${r.assetId} — ${r.detail}`);
}
console.log(
  `[shared-asset-drift] summary: ${results.length} checks, ` +
    `${driftCount} drift, ${pendingCount} pending-sync`
);

if (driftCount > 0) {
  console.error(
    '[shared-asset-drift] FAIL — shared-asset drift detected. Edit in the authority side and sync (see AGENTS.md).'
  );
  process.exit(1);
}
if (pendingCount > 0 && !allowPendingSync) {
  console.error(
    '[shared-asset-drift] FAIL — pending-sync items present and --allow-pending-sync not set (expected only before RC5 p2 lands on the plugin side).'
  );
  process.exit(1);
}
if (pendingCount > 0) {
  console.log(
    '[shared-asset-drift] PASS with pending-sync notices (--allow-pending-sync; remove the flag after RC5 p2 syncs the plugin side).'
  );
} else {
  console.log('[shared-asset-drift] PASS — all shared assets in sync.');
}
