/**
 * @module SpmDiscoverer
 * @description 包装现有 SpmService，适配 ProjectDiscoverer 接口
 *
 * 检测: 项目根或子目录存在 Package.swift
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { LanguageService } from '../../../shared/LanguageService.js';
import { ProjectDiscoverer } from '../../../core/discovery/ProjectDiscoverer.js';

export class SpmDiscoverer extends ProjectDiscoverer {
  /** @type {import('./SpmService.js').SpmService|null} */
  #spm = null;
  #projectRoot = null;

  get id() {
    return 'spm';
  }
  get displayName() {
    return 'Swift Package Manager (SPM)';
  }

  async detect(projectRoot) {
    // 检查项目根是否有 Package.swift
    const hasRoot = existsSync(join(projectRoot, 'Package.swift'));
    if (hasRoot) {
      return { match: true, confidence: 0.95, reason: 'Package.swift found at project root' };
    }

    // 检查子目录是否有 Package.swift（多包项目）
    try {
      const entries = readdirSync(projectRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          if (existsSync(join(projectRoot, entry.name, 'Package.swift'))) {
            return {
              match: true,
              confidence: 0.85,
              reason: `Package.swift found in ${entry.name}/`,
            };
          }
        }
      }
    } catch {
      /* ignore */
    }

    return { match: false, confidence: 0, reason: 'No Package.swift found' };
  }

  async load(projectRoot) {
    this.#projectRoot = projectRoot;
    // 动态加载 SpmService（避免循环导入）
    const { SpmService } = await import('./SpmService.js');
    this.#spm = new SpmService(projectRoot);
    await this.#spm.load();
  }

  async listTargets() {
    if (!this.#spm) {
      return [];
    }
    const rawTargets = await this.#spm.listTargets();
    return rawTargets.map((t) => {
      const name = typeof t === 'string' ? t : t.name;
      return {
        name,
        path: typeof t === 'object' ? t.path || this.#projectRoot : this.#projectRoot,
        type: typeof t === 'object' ? t.type || 'library' : 'library',
        language: 'swift',
        metadata: typeof t === 'object' ? t : { name },
      };
    });
  }

  async getTargetFiles(target) {
    if (!this.#spm) {
      return [];
    }
    const targetName = typeof target === 'string' ? target : target.name;
    const fileList = await this.#spm.getTargetFiles(targetName);
    return fileList.map((f) => {
      const fp = typeof f === 'string' ? f : f.path;
      const lang = this.#inferLang(fp);
      return {
        name: typeof f === 'object' ? f.name || basename(fp) : basename(fp),
        path: fp,
        relativePath:
          typeof f === 'object'
            ? f.relativePath || relative(this.#projectRoot, fp)
            : relative(this.#projectRoot, fp),
        language: lang,
      };
    });
  }

  async getDependencyGraph() {
    if (!this.#spm) {
      return { nodes: [], edges: [] };
    }
    const raw = await this.#spm.getDependencyGraph();
    return {
      nodes: (raw.nodes || []).map((n) => (typeof n === 'string' ? n : n.id || n.name)),
      edges: (raw.edges || []).map((e) => ({
        from: e.from,
        to: e.to,
        type: 'depends_on',
      })),
    };
  }

  /** 获取底层 SpmService（向后兼容） */
  getSpmService() {
    return this.#spm;
  }

  #inferLang(filePath) {
    return LanguageService.inferLang(filePath);
  }
}
