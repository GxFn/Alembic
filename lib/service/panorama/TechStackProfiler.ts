/**
 * TechStackProfiler — 技术栈画像聚合
 *
 * 根据外部依赖名称自动分类，生成项目技术栈画像。
 * 使用已知库名映射表 + 关键词启发式进行分类。
 *
 * @module TechStackProfiler
 */

import type { ExternalDepProfile, TechStackProfile } from './PanoramaTypes.js';

/* ═══ Known Library Categories ════════════════════════════ */

/**
 * 知名开源库 → 技术栈分类映射
 * 覆盖 iOS/Swift/ObjC + 跨平台常见 + Node/Web 常见
 */
const KNOWN_LIBRARIES: Record<string, string> = {
  // 网络
  afnetworking: 'Networking',
  alamofire: 'Networking',
  moya: 'Networking',
  axios: 'Networking',
  urlsession: 'Networking',
  grpc: 'Networking',
  starscream: 'Networking',
  socketrocket: 'Networking',

  // 图片
  sdwebimage: 'Image',
  kingfisher: 'Image',
  nuke: 'Image',
  yyimage: 'Image',
  flanimatedimage: 'Image',

  // UI / 布局
  snapkit: 'UI',
  masonry: 'UI',
  flexlayout: 'UI',
  yoga: 'UI',
  texture: 'UI',
  asyncdisplaykit: 'UI',
  iglistkit: 'UI',
  mbprogresshud: 'UI',
  svprogresshud: 'UI',
  lottie: 'UI',
  yytext: 'UI',
  dzzfloatingactionbutton: 'UI',
  herocard: 'UI',

  // 响应式 / 函数式
  rxswift: 'Reactive',
  rxcocoa: 'Reactive',
  reactiveswift: 'Reactive',
  combine: 'Reactive',
  openombine: 'Reactive',
  promisekit: 'Reactive',

  // 数据 / 存储
  realm: 'Storage',
  coredata: 'Storage',
  fmdb: 'Storage',
  grdb: 'Storage',
  sqlite: 'Storage',
  wcdb: 'Storage',
  mmkv: 'Storage',
  userdefaults: 'Storage',
  yymodel: 'Serialization',
  objectmapper: 'Serialization',
  codable: 'Serialization',
  swiftyjson: 'Serialization',
  mantle: 'Serialization',
  handyjson: 'Serialization',
  mjextension: 'Serialization',

  // 日志 / 诊断
  cocoalumberjack: 'Logging',
  swiftybeaver: 'Logging',
  oslog: 'Logging',
  bugly: 'Diagnostics',
  sentry: 'Diagnostics',
  firebase: 'Diagnostics',
  crashlytics: 'Diagnostics',

  // 路由
  urlnavigator: 'Routing',
  deeplink: 'Routing',
  arouter: 'Routing',
  ctmediator: 'Routing',

  // 测试
  quick: 'Testing',
  nimble: 'Testing',
  xctest: 'Testing',
  ocmock: 'Testing',
  ohhttpstubs: 'Testing',

  // 安全 / 加密
  cryptoswift: 'Security',
  keychain: 'Security',
  keychainaccess: 'Security',
  commonCrypto: 'Security',

  // 依赖注入
  swinject: 'Architecture',
  needle: 'Architecture',

  // 工具
  swiftlint: 'Tooling',
  r_swift: 'Tooling',
  swiftgen: 'Tooling',
  cocoapods: 'Tooling',
};

/**
 * 关键词 → 分类的启发式映射
 * 用于 KNOWN_LIBRARIES 未命中时的 fallback
 */
const KEYWORD_CATEGORIES: Array<[RegExp, string]> = [
  [/net(work)?|http|api|url|request|socket|grpc/i, 'Networking'],
  [/image|photo|picture|avatar|thumbnail/i, 'Image'],
  [/ui|view|layout|widget|button|label|cell|collection|table/i, 'UI'],
  [/anim(at)?|lottie|transition|motion/i, 'Animation'],
  [/rx|reactive|combine|signal|observable|promise/i, 'Reactive'],
  [/db|database|sql|realm|store|cache|storage|persist/i, 'Storage'],
  [/json|model|mapper|serial|codable|parse|decode/i, 'Serialization'],
  [/log|debug|trace|monitor|crash|sentry|bugly|diagnostic/i, 'Diagnostics'],
  [/route|router|navigation|deeplink|scheme|mediator/i, 'Routing'],
  [/test|mock|stub|spec|expect|assert/i, 'Testing'],
  [/crypto|encrypt|security|keychain|auth|token|oauth/i, 'Security'],
  [/player|video|audio|media|av|stream/i, 'Media'],
  [/map|location|geo|coordinate|clocation/i, 'Location'],
  [/pay|purchase|billing|iap/i, 'Payment'],
  [/push|notification|apns|message/i, 'Messaging'],
  [/analytics|track|event|statistics/i, 'Analytics'],
  [/ad|banner|interstitial|reward/i, 'Advertising'],
];

/* ═══ TechStackProfiler ═══════════════════════════════════ */

/** Fan-in 阈值：高于此值视为关键依赖热点 */
const HOTSPOT_THRESHOLD = 3;

/**
 * 对外部依赖进行分类，生成技术栈画像
 */
export function profileTechStack(externalDeps: ExternalDepProfile[]): TechStackProfile {
  if (externalDeps.length === 0) {
    return { categories: [], hotspots: [], totalExternalDeps: 0 };
  }

  // 1. 分类每个外部依赖
  const categoryMap = new Map<string, Array<{ name: string; fanIn: number; version?: string }>>();

  for (const dep of externalDeps) {
    const category = classifyDependency(dep.name);
    dep.category = category;

    if (!categoryMap.has(category)) {
      categoryMap.set(category, []);
    }
    categoryMap.get(category)!.push({
      name: dep.name,
      fanIn: dep.fanIn,
      version: dep.version,
    });
  }

  // 2. 按分类排序（每个分类内按 fan-in 降序，分类间按依赖数降序）
  const categories = [...categoryMap.entries()]
    .map(([name, deps]) => ({
      name,
      deps: deps.sort((a, b) => b.fanIn - a.fanIn),
    }))
    .sort((a, b) => b.deps.length - a.deps.length);

  // 3. 提取热点（fan-in ≥ 阈值）
  const hotspots = externalDeps
    .filter((d) => d.fanIn >= HOTSPOT_THRESHOLD)
    .map((d) => ({ name: d.name, fanIn: d.fanIn, dependedBy: d.dependedBy }))
    .sort((a, b) => b.fanIn - a.fanIn);

  return {
    categories,
    hotspots,
    totalExternalDeps: externalDeps.length,
  };
}

/**
 * 分类单个外部依赖
 */
function classifyDependency(name: string): string {
  // 标准化名称：移除前缀、转小写
  const normalized = name
    .replace(/^(BDMV|BDP|FMT|BD|MTL|Bai|Ali|TX|TT)/, '')
    .toLowerCase()
    .replace(/[-_]/g, '');

  // 1. 精确匹配已知库
  if (KNOWN_LIBRARIES[normalized]) {
    return KNOWN_LIBRARIES[normalized];
  }

  // 尝试原始名称小写
  const rawLower = name.toLowerCase().replace(/[-_]/g, '');
  if (KNOWN_LIBRARIES[rawLower]) {
    return KNOWN_LIBRARIES[rawLower];
  }

  // 2. 关键词启发式
  for (const [pattern, category] of KEYWORD_CATEGORIES) {
    if (pattern.test(name)) {
      return category;
    }
  }

  // 3. 默认分类
  return 'Other';
}
