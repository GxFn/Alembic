/**
 * TriggerSymbol - Snippet 触发符配置
 *
 * 默认使用 @，可通过环境变量 ASD_TRIGGER_SYMBOL 覆盖（单字符）。
 * V2 ESM 版本，对应 V1 TriggerSymbol.js
 */

const DEFAULT_SYMBOL = '@';

function fromEnv() {
  const raw = process.env.ASD_TRIGGER_SYMBOL;
  if (raw != null && String(raw).length === 1) {
    return String(raw);
  }
  return DEFAULT_SYMBOL;
}

function escapeRegExp(s: any) {
  return s.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
}

/** 当前触发符（可配置） */
export const TRIGGER_SYMBOL = fromEnv();

/** 用于拆分的触发符集合 */
export const TRIGGER_SYMBOLS = [TRIGGER_SYMBOL];

/** 用于按触发符拆分的正则 */
export const TRIGGER_SPLIT_REGEX = new RegExp(`[${TRIGGER_SYMBOLS.map(escapeRegExp).join('')}]`);

/** str 是否以触发符开头 */
export function hasTriggerPrefix(str: any) {
  if (!str || typeof str !== 'string') {
    return false;
  }
  const s = String(str).trim();
  return TRIGGER_SYMBOLS.some((sym) => s.startsWith(sym));
}

/** 去掉 str 开头的连续触发符 */
export function stripTriggerPrefix(str: any) {
  if (!str || typeof str !== 'string') {
    return String(str);
  }
  let s = String(str).trim();
  while (s.length && TRIGGER_SYMBOLS.some((sym) => s.startsWith(sym))) {
    s = s.slice(1).trimStart();
  }
  return s;
}

/** 若 str 不以触发符开头，则加上默认触发符 */
export function ensureTriggerPrefix(str: any) {
  if (!str || typeof str !== 'string') {
    return str;
  }
  const s = String(str).trim();
  if (!s) {
    return s;
  }
  return hasTriggerPrefix(s) ? s : TRIGGER_SYMBOL + s;
}

/** 获取 str 已带的触发符，否则返回默认触发符 */
export function getPrefixFromTrigger(str: any) {
  if (!str || typeof str !== 'string') {
    return TRIGGER_SYMBOL;
  }
  const s = String(str).trim();
  for (const sym of TRIGGER_SYMBOLS) {
    if (s.startsWith(sym)) {
      return sym;
    }
  }
  return TRIGGER_SYMBOL;
}
