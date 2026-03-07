/**
 * TriggerResolver — 触发器规范化
 * 将原始触发输入规范化为标准格式，添加类型标签
 */

export class TriggerResolver {
  /**
   * 规范化触发器
   * @param {object|string} trigger
   * @returns {{ type: string, name?: string, params?: object, raw: unknown }}
   */
  resolve(trigger: string | Record<string, unknown>) {
    if (typeof trigger === 'string') {
      return this.#resolveString(trigger);
    }

    if (trigger && typeof trigger === 'object') {
      return {
        type: String(trigger.type || 'unknown'),
        name: String(trigger.name || ''),
        params: (trigger.params as Record<string, unknown>) || {},
        raw: trigger,
      };
    }

    return { type: 'unknown', raw: trigger };
  }

  #resolveString(input: string) {
    const trimmed = input.trim();

    // 检测 as:xxx 格式
    const asMatch = trimmed.match(/^as:(\w+)\s*(.*)/);
    if (asMatch) {
      return {
        type: this.#mapDirectiveType(asMatch[1]),
        name: asMatch[1],
        params: { option: asMatch[2].trim() },
        raw: input,
      };
    }

    // 检测事件类型格式 file:changed, timer:cron
    const eventMatch = trimmed.match(/^(\w+):(\w+)\s*(.*)/);
    if (eventMatch) {
      return {
        type: eventMatch[1],
        name: eventMatch[2],
        params: { option: eventMatch[3].trim() },
        raw: input,
      };
    }

    return { type: 'custom', name: trimmed, params: {}, raw: input };
  }

  #mapDirectiveType(name: string) {
    const map: Record<string, string> = {
      search: 'search',
      s: 'search',
      create: 'create',
      c: 'create',
      audit: 'audit',
      a: 'audit',
      include: 'injection',
      import: 'injection',
      alink: 'alink',
    };
    return map[name] || 'directive';
  }
}
