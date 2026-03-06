/**
 * @module JvmDiscoverer
 * @description Java / Kotlin 项目结构发现器
 *
 * 检测信号: build.gradle, build.gradle.kts, pom.xml, settings.gradle
 * 支持: Gradle (单模块/多模块), Maven (单模块/多模块)
 *
 * ⚠️ 不尝试精确解析 Gradle DSL，仅用正则启发式提取关键信息
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { LanguageService } from '../../shared/LanguageService.js';
import { ProjectDiscoverer } from './ProjectDiscoverer.js';

const SOURCE_EXTENSIONS = new Set(['.java', '.kt', '.kts']);
const EXCLUDE_DIRS = new Set([
  '.gradle',
  '.idea',
  '.cursor',
  'build',
  'target',
  '.git',
  'node_modules',
  'out',
  '.kotlin',
]);

export class JvmDiscoverer extends ProjectDiscoverer {
  #projectRoot = null;
  #targets = [];
  #depGraph = { nodes: [], edges: [] };
  #buildSystem = null; // 'gradle' | 'maven'

  // @ts-expect-error TS migration: TS2416
  get id() {
    return 'jvm';
  }
  // @ts-expect-error TS migration: TS2416
  get displayName() {
    return `JVM (${this.#buildSystem === 'maven' ? 'Maven' : 'Gradle'})`;
  }

  // @ts-expect-error TS migration: TS2416
  async detect(projectRoot) {
    let confidence = 0;
    const reasons = [];

    // Gradle
    if (
      existsSync(join(projectRoot, 'build.gradle')) ||
      existsSync(join(projectRoot, 'build.gradle.kts'))
    ) {
      confidence = 0.9;
      reasons.push('build.gradle(.kts) exists');
    }
    if (
      existsSync(join(projectRoot, 'settings.gradle')) ||
      existsSync(join(projectRoot, 'settings.gradle.kts'))
    ) {
      confidence = Math.max(confidence, 0.85);
      confidence = Math.min(confidence + 0.05, 1.0);
      reasons.push('settings.gradle(.kts) exists');
    }

    // Maven
    if (existsSync(join(projectRoot, 'pom.xml'))) {
      confidence = Math.max(confidence, 0.85);
      reasons.push('pom.xml exists');
    }

    return {
      match: confidence > 0,
      confidence: Math.min(confidence, 1.0),
      reason: reasons.join(', ') || 'No JVM markers found',
    };
  }

  async load(projectRoot) {
    this.#projectRoot = projectRoot;
    this.#targets = [];
    this.#depGraph = { nodes: [], edges: [] };

    // 判断构建系统
    const hasGradle =
      existsSync(join(projectRoot, 'build.gradle')) ||
      existsSync(join(projectRoot, 'build.gradle.kts'));
    const hasMaven = existsSync(join(projectRoot, 'pom.xml'));

    if (hasGradle) {
      this.#buildSystem = 'gradle';
      this.#loadGradle(projectRoot);
    } else if (hasMaven) {
      this.#buildSystem = 'maven';
      this.#loadMaven(projectRoot);
    }
  }

  // @ts-expect-error TS migration: TS2416
  async listTargets() {
    return this.#targets;
  }

  // @ts-expect-error TS migration: TS2416
  async getTargetFiles(target) {
    const targetObj =
      typeof target === 'string' ? this.#targets.find((t) => t.name === target) : target;

    if (!targetObj?.path || !existsSync(targetObj.path)) {
      return [];
    }

    const files = [];
    // JVM 约定: src/main/java, src/main/kotlin, src/test/java, src/test/kotlin
    const sourceDirs = [
      join(targetObj.path, 'src', 'main', 'java'),
      join(targetObj.path, 'src', 'main', 'kotlin'),
      join(targetObj.path, 'src', 'test', 'java'),
      join(targetObj.path, 'src', 'test', 'kotlin'),
    ];

    // 也支持非标准布局 — 直接在 target 路径下搜索
    const hasSrcDir = sourceDirs.some((d) => existsSync(d));
    if (hasSrcDir) {
      for (const srcDir of sourceDirs) {
        if (existsSync(srcDir)) {
          this.#collectFiles(srcDir, targetObj.path, files);
        }
      }
    } else {
      this.#collectFiles(targetObj.path, targetObj.path, files);
    }

    return files;
  }

  // @ts-expect-error TS migration: TS2416
  async getDependencyGraph() {
    return this.#depGraph;
  }

  // ── Gradle ──

  #loadGradle(projectRoot) {
    // 解析 settings.gradle 找子模块
    const submodules = this.#parseGradleSettings(projectRoot);

    if (submodules.length > 0) {
      // 多模块 Gradle 项目
      for (const mod of submodules) {
        const modPath = resolve(projectRoot, mod.replace(/:/g, '/'));
        if (!existsSync(modPath)) {
          continue;
        }

        const framework = this.#detectGradleFramework(modPath);
        const lang = this.#detectPrimaryLang(modPath);

        this.#targets.push({
          name: mod,
          path: modPath,
          type: this.#inferGradleTargetType(modPath, mod),
          language: lang,
          framework,
          metadata: { buildSystem: 'gradle', module: mod },
        });
        this.#depGraph.nodes.push(mod);
      }

      // 提取模块间依赖
      this.#parseGradleModuleDeps(projectRoot, submodules);
    } else {
      // 单模块 Gradle 项目
      const framework = this.#detectGradleFramework(projectRoot);
      const lang = this.#detectPrimaryLang(projectRoot);
      const name = basename(projectRoot);

      this.#targets.push({
        name,
        path: projectRoot,
        type: 'app',
        language: lang,
        framework,
        metadata: { buildSystem: 'gradle' },
      });
      this.#depGraph.nodes.push(name);
    }

    // 提取外部依赖
    this.#parseGradleExternalDeps(projectRoot);
  }

  #parseGradleSettings(projectRoot) {
    const modules = [];
    for (const fname of ['settings.gradle', 'settings.gradle.kts']) {
      const settingsPath = join(projectRoot, fname);
      if (!existsSync(settingsPath)) {
        continue;
      }

      try {
        const content = readFileSync(settingsPath, 'utf8');
        // include ':app', ':lib:core', ...
        const includeMatches = content.matchAll(
          /include\s*\(?[\s]*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])*/g
        );
        for (const m of includeMatches) {
          for (let i = 1; i < m.length; i++) {
            if (m[i]) {
              modules.push(m[i].replace(/^:/, ''));
            }
          }
        }
        // include(":app")
        const includeKtsMatches = content.matchAll(/include\s*\(\s*["']([^"']+)["']\s*\)/g);
        for (const m of includeKtsMatches) {
          if (m[1]) {
            modules.push(m[1].replace(/^:/, ''));
          }
        }
      } catch {
        /* skip */
      }
    }
    return [...new Set(modules)];
  }

  #detectGradleFramework(dir) {
    for (const fname of ['build.gradle', 'build.gradle.kts']) {
      const buildPath = join(dir, fname);
      if (!existsSync(buildPath)) {
        continue;
      }
      try {
        const content = readFileSync(buildPath, 'utf8');
        if (/com\.android|android\s*\{|apply.*android/.test(content)) {
          return 'android';
        }
        if (/org\.springframework|spring-boot/.test(content)) {
          return 'spring';
        }
        if (/io\.ktor/.test(content)) {
          return 'ktor';
        }
        if (/org\.jetbrains\.compose/.test(content)) {
          return 'compose';
        }
      } catch {
        /* skip */
      }
    }
    return null;
  }

  #inferGradleTargetType(dir, name) {
    for (const fname of ['build.gradle', 'build.gradle.kts']) {
      const buildPath = join(dir, fname);
      if (!existsSync(buildPath)) {
        continue;
      }
      try {
        const content = readFileSync(buildPath, 'utf8');
        if (/application|com\.android\.application/.test(content)) {
          return 'app';
        }
        if (/java-library|com\.android\.library/.test(content)) {
          return 'library';
        }
      } catch {
        /* skip */
      }
    }
    if (/test/i.test(name)) {
      return 'test';
    }
    return 'library';
  }

  #parseGradleModuleDeps(projectRoot, submodules) {
    const moduleSet = new Set(submodules);
    for (const mod of submodules) {
      const modPath = resolve(projectRoot, mod.replace(/:/g, '/'));
      for (const fname of ['build.gradle', 'build.gradle.kts']) {
        const buildPath = join(modPath, fname);
        if (!existsSync(buildPath)) {
          continue;
        }
        try {
          const content = readFileSync(buildPath, 'utf8');
          // project(':lib:core'), project(":lib:core")
          const projDeps = content.matchAll(/project\s*\(\s*['"][:.]?([^'"]+)['"]\s*\)/g);
          for (const m of projDeps) {
            const depMod = m[1].replace(/^:/, '');
            if (moduleSet.has(depMod)) {
              this.#depGraph.edges.push({ from: mod, to: depMod, type: 'depends_on' });
            }
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  #parseGradleExternalDeps(projectRoot) {
    for (const fname of ['build.gradle', 'build.gradle.kts']) {
      const buildPath = join(projectRoot, fname);
      if (!existsSync(buildPath)) {
        continue;
      }
      try {
        const content = readFileSync(buildPath, 'utf8');
        const rootTarget = this.#targets[0]?.name;
        if (!rootTarget) {
          return;
        }

        // implementation 'group:artifact:version' or implementation("group:artifact:version")
        const depMatches = content.matchAll(
          /(?:implementation|api|compileOnly|runtimeOnly)\s*[("']+([^)'"]+)[)'"]+/g
        );
        for (const m of depMatches) {
          const parts = m[1].split(':');
          if (parts.length >= 2) {
            const depName = `${parts[0]}:${parts[1]}`;
            this.#depGraph.edges.push({ from: rootTarget, to: depName, type: 'depends_on' });
          }
        }
      } catch {
        /* skip */
      }
    }
  }

  // ── Maven ──

  #loadMaven(projectRoot) {
    const pomPath = join(projectRoot, 'pom.xml');
    if (!existsSync(pomPath)) {
      return;
    }

    const pomContent = readFileSync(pomPath, 'utf8');
    const projectName = this.#extractXmlValue(pomContent, 'artifactId') || basename(projectRoot);

    // 提取子模块
    const modules = this.#parseMavenModules(pomContent);

    if (modules.length > 0) {
      for (const mod of modules) {
        const modPath = resolve(projectRoot, mod);
        if (!existsSync(modPath)) {
          continue;
        }

        const lang = this.#detectPrimaryLang(modPath);
        const framework = this.#detectMavenFramework(modPath);

        this.#targets.push({
          name: mod,
          path: modPath,
          type: /test/i.test(mod) ? 'test' : 'library',
          language: lang,
          framework,
          metadata: { buildSystem: 'maven', module: mod },
        });
        this.#depGraph.nodes.push(mod);
      }
    } else {
      const lang = this.#detectPrimaryLang(projectRoot);
      const framework = this.#detectMavenFramework(projectRoot);

      this.#targets.push({
        name: projectName,
        path: projectRoot,
        type: 'app',
        language: lang,
        framework,
        metadata: { buildSystem: 'maven' },
      });
      this.#depGraph.nodes.push(projectName);
    }

    // 提取外部依赖
    this.#parseMavenDeps(pomContent);
  }

  #parseMavenModules(pomContent) {
    const modules = [];
    const moduleMatches = pomContent.matchAll(/<module>([^<]+)<\/module>/g);
    for (const m of moduleMatches) {
      modules.push(m[1].trim());
    }
    return modules;
  }

  #detectMavenFramework(dir) {
    const pomPath = join(dir, 'pom.xml');
    if (!existsSync(pomPath)) {
      return null;
    }
    try {
      const content = readFileSync(pomPath, 'utf8');
      if (/spring-boot|springframework/.test(content)) {
        return 'spring';
      }
      if (/android/.test(content)) {
        return 'android';
      }
    } catch {
      /* skip */
    }
    return null;
  }

  #parseMavenDeps(pomContent) {
    const rootTarget = this.#targets[0]?.name;
    if (!rootTarget) {
      return;
    }

    // 简化: 提取 <dependency> 中的 groupId:artifactId
    const depBlocks = pomContent.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g);
    for (const block of depBlocks) {
      const groupId = this.#extractXmlValue(block[1], 'groupId');
      const artifactId = this.#extractXmlValue(block[1], 'artifactId');
      if (groupId && artifactId) {
        this.#depGraph.edges.push({
          from: rootTarget,
          to: `${groupId}:${artifactId}`,
          type: 'depends_on',
        });
      }
    }
  }

  // ── 共用工具 ──

  #detectPrimaryLang(dir) {
    let javaCount = 0;
    let kotlinCount = 0;

    const srcMain = join(dir, 'src', 'main');
    if (existsSync(join(srcMain, 'kotlin'))) {
      kotlinCount += 10;
    }
    if (existsSync(join(srcMain, 'java'))) {
      javaCount += 10;
    }

    // 快速采样
    const srcDirs = [join(srcMain, 'java'), join(srcMain, 'kotlin'), dir];
    for (const sd of srcDirs) {
      if (!existsSync(sd)) {
        continue;
      }
      try {
        const files = readdirSync(sd).slice(0, 20);
        for (const f of files) {
          if (f.endsWith('.kt') || f.endsWith('.kts')) {
            kotlinCount++;
          }
          if (f.endsWith('.java')) {
            javaCount++;
          }
        }
      } catch {
        /* skip */
      }
    }

    return kotlinCount > javaCount ? 'kotlin' : 'java';
  }

  #collectFiles(dir, rootDir, files, depth = 0) {
    if (depth > 15) {
      return;
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        if (EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          this.#collectFiles(fullPath, rootDir, files, depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if (SOURCE_EXTENSIONS.has(ext)) {
            files.push({
              name: entry.name,
              path: fullPath,
              relativePath: relative(rootDir, fullPath),
              language: LanguageService.inferLang(entry.name),
            });
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  #extractXmlValue(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return match ? match[1].trim() : null;
  }
}
