/**
 * @module EnhancementRegistry
 * @description 增强包注册与自动选择
 *
 * Bootstrap 完成 Phase 1 后，根据主语言 + 检测到的框架自动筛选增强包。
 */

import type { EnhancementPack } from './EnhancementPack.js';

export class EnhancementRegistry {
  #packs: EnhancementPack[] = [];

  /** 注册增强包 */
  register(pack: EnhancementPack) {
    this.#packs.push(pack);
    return this;
  }

  /** 根据语言和框架筛选适用的增强包 */
  resolve(primaryLang: string, detectedFrameworks: string[] = []) {
    return this.#packs.filter((pack) => {
      const cond = pack.conditions;
      if (!cond) {
        return false;
      }
      const langMatch = !cond.languages || cond.languages.includes(primaryLang);
      const fwMatch =
        !cond.frameworks || cond.frameworks.some((f: string) => detectedFrameworks.includes(f));
      return langMatch && (cond.frameworks ? fwMatch : true);
    });
  }

  /** 获取所有已注册的增强包 */
  all() {
    return [...this.#packs];
  }
}
