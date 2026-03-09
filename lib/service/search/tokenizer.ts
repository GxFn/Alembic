/**
 * tokenizer — 中英文混合分词器
 *
 * 从 SearchEngine.ts 提取的独立分词模块。
 * 支持 camelCase/PascalCase 拆分 + CJK bigram 覆盖 + 停用词过滤。
 *
 * @module tokenizer
 */

/** BM25 调参常量 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/**
 * 中文停用词表 — 过滤常见虚词/助词/代词/连词，减少 BM25 噪声
 * 参考 jieba / Elasticsearch smartcn_stop / 百度停用词表
 */
const CJK_STOPWORDS = new Set([
  // 助词 / 语气词
  '的',
  '了',
  '着',
  '过',
  '吗',
  '呢',
  '吧',
  '啊',
  '呀',
  '哦',
  '嘛',
  '么',
  // 代词
  '我',
  '你',
  '他',
  '她',
  '它',
  '们',
  '这',
  '那',
  '哪',
  '谁',
  '什',
  '怎',
  // 介词 / 连词
  '在',
  '和',
  '与',
  '及',
  '或',
  '而',
  '但',
  '却',
  '虽',
  '所',
  '被',
  '把',
  // 副词
  '不',
  '没',
  '也',
  '都',
  '就',
  '才',
  '又',
  '很',
  '太',
  '更',
  '最',
  '已',
  // 动词虚化
  '是',
  '有',
  '为',
  '以',
  '将',
  '从',
  '到',
  '向',
  '对',
  '于',
  '给',
  '让',
  // 疑问助词
  '如',
  '何',
  '几',
  '多',
  // 量词 / 数词
  '个',
  '些',
  '每',
  '各',
  // 其他高频虚词
  '地',
  '得',
  '之',
  '其',
  '可',
  '能',
  '要',
  '会',
  '该',
  '应',
]);

/** 英文停用词表 — 过滤常见虚词 */
const EN_STOPWORDS = new Set([
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'must',
  'can',
  'could',
  'an',
  'and',
  'or',
  'but',
  'if',
  'so',
  'at',
  'by',
  'for',
  'in',
  'of',
  'on',
  'to',
  'up',
  'it',
  'its',
  'as',
  'no',
  'not',
  'that',
  'this',
  'with',
  'from',
  'into',
  'about',
]);

// CJK 正则（中日韩统一表意文字 + 扩展区）
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const CJK_SEQ_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;

/**
 * 分词: 中英文混合分词
 * 英文: camelCase / PascalCase 拆分 + 小写化 + 停用词过滤
 * 中文: bigram + 完整片段 — 停用词级别单字被过滤，无需分词词典即可支持子串匹配
 */
export function tokenize(text: string) {
  if (!text) {
    return [];
  }
  // 先拆 camelCase/PascalCase（必须在 toLowerCase 之前，否则大小写边界丢失）
  let expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  // 拆全大写前缀：URLSession → URL Session, UITableView → UI Table View
  expanded = expanded.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const normalized = expanded.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, ' ');
  const rawTokens = normalized.split(/[\s_-]+/).filter((t: string) => t.length >= 1);

  const tokens: string[] = [];

  for (const raw of rawTokens) {
    if (CJK_RE.test(raw)) {
      // 中文片段：提取所有 CJK 连续子串，生成 bigram + 完整片段覆盖
      const cjkChars = raw.match(CJK_SEQ_RE) || [];
      for (const seg of cjkChars) {
        // 单字仅在非停用词时保留（保留特殊技术单字如 "表"、"栈" 等）
        for (const ch of seg) {
          if (!CJK_STOPWORDS.has(ch)) {
            tokens.push(ch);
          }
        }
        // bigram — 跳过双停用词组合（如 "的是"），保留含义义词的组合（如 "网络"）
        for (let i = 0; i < seg.length - 1; i++) {
          const bi = seg[i] + seg[i + 1];
          if (!CJK_STOPWORDS.has(seg[i]) || !CJK_STOPWORDS.has(seg[i + 1])) {
            tokens.push(bi);
          }
        }
        // 完整片段（≥3 字时额外保留，提升精确匹配权重）
        if (seg.length >= 3) {
          tokens.push(seg);
        }
      }
      // 非 CJK 部分（英文/数字）也保留
      const nonCjk = raw.replace(CJK_SEQ_RE, ' ').trim();
      if (nonCjk) {
        for (const t of nonCjk.split(/\s+/)) {
          if (t.length >= 2 && !EN_STOPWORDS.has(t)) {
            tokens.push(t);
          }
        }
      }
    } else if (raw.length >= 2 && !EN_STOPWORDS.has(raw)) {
      tokens.push(raw);
    }
  }
  return [...new Set(tokens)];
}
