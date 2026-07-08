#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  resolveDashboardSource,
  verifyDashboardArtifactFreshness,
} from './dashboard-artifact-metadata.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const defaultOutputDir = join(repoRoot, '.release', 'alembic-ai');
const args = new Set(process.argv.slice(2));
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputDir = outputArg
  ? resolve(repoRoot, outputArg.slice('--output='.length))
  : defaultOutputDir;
const shouldPackDryRun = args.has('--pack-dry-run');
const shouldSkipDashboardBuild = args.has('--skip-dashboard-build');

const rootPackage = readJson(join(repoRoot, 'package.json'));
const corePackage = readJson(join(repoRoot, '..', 'AlembicCore', 'package.json'));
const agentPackage = readJson(join(repoRoot, '..', 'AlembicAgent', 'package.json'));
const dashboardSource = resolveDashboardSource();
const dashboardPackage = {
  name: dashboardSource.packageName,
  version: dashboardSource.packageVersion,
};

const dependencyReplacements = {
  '@alembic/core': corePackage.version,
  '@alembic/agent': agentPackage.version,
};

verifyRootDevManifest(rootPackage);
if (!shouldSkipDashboardBuild) {
  writeLine('Building Dashboard assets before publish staging.');
  execFileSync('npm', ['run', 'build:dashboard'], { cwd: repoRoot, stdio: 'inherit' });
}
verifyDashboardArtifact('Dashboard artifact', join(repoRoot, 'dashboard', 'dist'), dashboardSource);
prepareOutputDirectory(outputDir);

const stagingPackage = createStagingPackageJson(rootPackage, dependencyReplacements);
copyPackagePayload(stagingPackage.files ?? [], outputDir);
copyOptionalRootFiles(outputDir);
bundlePrivateDependencies(outputDir);

const sourceMetadata = createSourceMetadata(stagingPackage);
writeJson(join(outputDir, 'package.json'), stagingPackage);
writeJson(join(outputDir, 'alembic-release-source.json'), sourceMetadata);

verifyStagingManifest(stagingPackage, sourceMetadata, outputDir, dashboardSource);
writeLine(`Prepared Alembic publish staging package: ${relativeFromRepo(outputDir)}`);
writeLine(`- @alembic/core: ${dependencyReplacements['@alembic/core']}`);
writeLine(`- @alembic/agent: ${dependencyReplacements['@alembic/agent']}`);
writeLine(`- Core source: ${sourceMetadata.sources.AlembicCore.commit}`);
writeLine(`- Agent source: ${sourceMetadata.sources.AlembicAgent.commit}`);
writeLine(
  `- Dashboard source: ${sourceMetadata.sources.AlembicDashboard.commit} (${dashboardSource.displayPath})`
);

if (shouldPackDryRun) {
  const npmCacheDir = join(repoRoot, '.release', '.npm-cache');
  mkdirSync(npmCacheDir, { recursive: true });
  const packOutput = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', npmCacheDir],
    {
      cwd: outputDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  writeLine(packOutput.trim());
}

function verifyRootDevManifest(packageJson) {
  if (packageJson.name !== 'alembic-ai') {
    throw new Error(
      `Expected Alembic main package name to be alembic-ai, found ${packageJson.name}`
    );
  }

  for (const dependencyName of Object.keys(dependencyReplacements)) {
    const spec = packageJson.dependencies?.[dependencyName];
    if (typeof spec !== 'string' || !spec.startsWith('file:../')) {
      throw new Error(
        `Root dev manifest must keep ${dependencyName} as a workspace-local file dependency before staging; found ${String(spec)}`
      );
    }
  }
}

function prepareOutputDirectory(targetDir) {
  const relativeTarget = relative(repoRoot, targetDir);
  if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
    throw new Error(`Refusing to write publish staging outside this repository: ${targetDir}`);
  }

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
}

function createStagingPackageJson(packageJson, replacements) {
  const staged = structuredClone(packageJson);
  staged.dependencies = { ...staged.dependencies };

  for (const [dependencyName, version] of Object.entries(replacements)) {
    staged.dependencies[dependencyName] = version;
  }

  if (staged.scripts && typeof staged.scripts === 'object') {
    for (const lifecycleScript of [
      'prepare',
      'prepack',
      'postpack',
      'prepublishOnly',
      'postpublish',
    ]) {
      delete staged.scripts[lifecycleScript];
    }
  }

  const existingFiles = Array.isArray(staged.files)
    ? staged.files.filter((filePath) => existsSync(join(repoRoot, filePath)))
    : [];
  staged.files = Array.from(new Set([...existingFiles, 'alembic-release-source.json']));

  // Path B（自足 npm 包）：私有 @alembic/core + @alembic/agent 不发布到 registry，
  // 而是 vendored 进 node_modules/@alembic/* 并随 tarball 一起发布（bundledDependencies）。
  // 安装时 npm 直接用 bundle 的副本，不去 registry 拉 @alembic/*；其余依赖是公共 npm 包。
  // 依赖仍保留为版本号（verifyStagingManifest 的版本一致性检查照常通过）。
  staged.bundledDependencies = ['@alembic/core', '@alembic/agent'];

  return staged;
}

function copyPackagePayload(files, targetDir) {
  for (const filePath of files) {
    if (filePath === 'alembic-release-source.json') {
      continue;
    }

    const source = join(repoRoot, filePath);
    if (!existsSync(source)) {
      writeError(
        `Warning: package files entry does not exist and will be absent from staging: ${filePath}`
      );
      continue;
    }

    const destination = join(targetDir, filePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: false });
  }
}

function copyOptionalRootFiles(targetDir) {
  for (const fileName of ['README.md', 'README_CN.md', 'LICENSE', 'CHANGELOG.md']) {
    const source = join(repoRoot, fileName);
    if (existsSync(source)) {
      cpSync(source, join(targetDir, basename(fileName)));
    }
  }
}

// Path B：把私有 @alembic/core + @alembic/agent（各自 npm pack 的已发布形态）vendored
// 进 staging node_modules，随 bundledDependencies 一起进 tarball。两者都放在顶层：
// @alembic/agent 依赖 @alembic/core，安装后 Agent 的 Core import 解析到同级 bundle 的 Core。
// Core/Agent 的公共依赖（better-sqlite3 等）已在 alembic-ai 的 dependencies 里，正常解析。
function bundlePrivateDependencies(targetDir) {
  const nodeModulesDir = join(targetDir, 'node_modules');
  const privatePackages = [
    { name: '@alembic/core', sourcePath: join(repoRoot, '..', 'AlembicCore') },
    { name: '@alembic/agent', sourcePath: join(repoRoot, '..', 'AlembicAgent') },
  ];
  const packDir = join(repoRoot, '.release', '.bundle-pack');
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  for (const { name, sourcePath } of privatePackages) {
    if (!existsSync(join(sourcePath, 'dist'))) {
      throw new Error(
        `Cannot bundle ${name}: ${join(sourcePath, 'dist')} is missing. Build the sibling package first.`
      );
    }
    // --ignore-scripts：只取被 vendor 包的文件，不运行其 prepack/prepare lifecycle
    // （例如 @alembic/agent 的 prepack 是独立发布边界守卫，bundle 时不适用）。
    const packOutput = execFileSync(
      'npm',
      ['pack', sourcePath, '--pack-destination', packDir, '--silent', '--ignore-scripts'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
    );
    const tarball = packOutput.trim().split('\n').pop().trim();
    const extractDir = join(packDir, 'extract');
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    // npm tarballs 顶层是 `package/`。
    execFileSync('tar', ['-xzf', join(packDir, tarball), '-C', extractDir]);
    const destination = join(nodeModulesDir, ...name.split('/'));
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(extractDir, 'package'), destination, { recursive: true, force: true });
    const bundled = readJson(join(destination, 'package.json'));
    if (bundled.version !== dependencyReplacements[name]) {
      throw new Error(
        `Bundled ${name} version ${bundled.version} does not match staged ${dependencyReplacements[name]}.`
      );
    }
    writeLine(`- bundled ${name}@${bundled.version} into node_modules`);
  }
  rmSync(packDir, { recursive: true, force: true });
}

function createSourceMetadata(stagingPackage) {
  return {
    schemaVersion: 1,
    packageName: stagingPackage.name,
    packageVersion: stagingPackage.version,
    stagingKind: 'npm-publish',
    generatedAt: new Date().toISOString(),
    registryDependencies: dependencyReplacements,
    sources: {
      Alembic: gitInfo(repoRoot),
      AlembicCore: {
        ...gitInfo(join(repoRoot, '..', 'AlembicCore')),
        packageName: corePackage.name,
        packageVersion: corePackage.version,
      },
      AlembicAgent: {
        ...gitInfo(join(repoRoot, '..', 'AlembicAgent')),
        packageName: agentPackage.name,
        packageVersion: agentPackage.version,
      },
      AlembicDashboard: {
        commit: dashboardSource.commit,
        dirty: dashboardSource.dirty,
        displayPath: dashboardSource.displayPath,
        kind: dashboardSource.kind,
        packageName: dashboardPackage.name,
        packageVersion: dashboardPackage.version,
        sourceFingerprint: dashboardSource.sourceFingerprint,
      },
    },
  };
}

function verifyStagingManifest(packageJson, metadata, targetDir, expectedDashboardSource) {
  const dependencySections = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
  ];

  const errors = [];
  for (const section of dependencySections) {
    const dependencies = packageJson[section];
    if (!dependencies || typeof dependencies !== 'object') {
      continue;
    }

    for (const [name, spec] of Object.entries(dependencies)) {
      if (
        typeof spec === 'string' &&
        (spec.startsWith('file:../') || spec.startsWith('file:vendor/'))
      ) {
        errors.push(`Staging package ${section}.${name} still uses ${spec}`);
      }
    }
  }

  for (const [dependencyName, expectedVersion] of Object.entries(dependencyReplacements)) {
    const spec = packageJson.dependencies?.[dependencyName];
    if (spec !== expectedVersion) {
      errors.push(
        `Staging package dependency ${dependencyName} expected ${expectedVersion}, found ${String(spec)}`
      );
    }
  }

  for (const sourceName of ['Alembic', 'AlembicCore', 'AlembicAgent', 'AlembicDashboard']) {
    if (!metadata.sources[sourceName]?.commit) {
      errors.push(`Missing source commit metadata for ${sourceName}`);
    }
  }

  const dashboardArtifact = verifyDashboardArtifact(
    'Staging dashboard artifact',
    join(targetDir, 'dashboard', 'dist'),
    expectedDashboardSource,
    { collectOnly: true }
  );
  errors.push(...dashboardArtifact.errors);
  const dashboardMetadata = dashboardArtifact.metadata?.source;
  const dashboardSourceMetadata = metadata.sources.AlembicDashboard;
  if (
    dashboardMetadata &&
    dashboardSourceMetadata &&
    dashboardMetadata.commit !== dashboardSourceMetadata.commit
  ) {
    errors.push(
      `Staging dashboard metadata commit ${String(dashboardMetadata.commit)} does not match release source ${String(dashboardSourceMetadata.commit)}.`
    );
  }
  if (
    dashboardMetadata &&
    dashboardSourceMetadata &&
    dashboardMetadata.sourceFingerprint !== dashboardSourceMetadata.sourceFingerprint
  ) {
    errors.push(
      `Staging dashboard metadata sourceFingerprint ${String(dashboardMetadata.sourceFingerprint)} does not match release source ${String(dashboardSourceMetadata.sourceFingerprint)}.`
    );
  }

  if (errors.length > 0) {
    throw new Error(`Publish staging verification failed:\n- ${errors.join('\n- ')}`);
  }
}

function verifyDashboardArtifact(label, artifactDir, expectedSource, options = {}) {
  const result = verifyDashboardArtifactFreshness({
    artifactDir,
    expectedSource,
  });
  if (result.ok || options.collectOnly) {
    return {
      errors: result.errors.map((error) => `${label}: ${error}`),
      metadata: result.metadata,
      ok: result.ok,
    };
  }
  throw new Error(`${label} freshness check failed:\n- ${result.errors.join('\n- ')}`);
}

function gitInfo(repoPath) {
  return {
    commit: git(repoPath, ['rev-parse', 'HEAD']),
    dirty: git(repoPath, ['status', '--short']).trim().length > 0,
  };
}

function git(repoPath, gitArgs) {
  return execFileSync('git', ['-C', repoPath, ...gitArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function relativeFromRepo(path) {
  return path.replace(`${repoRoot}/`, '');
}

function writeLine(message) {
  process.stdout.write(`${message}\n`);
}

function writeError(message) {
  process.stderr.write(`${message}\n`);
}
