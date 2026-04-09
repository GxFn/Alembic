/**
 * @module RubyDslParser
 * @description Ruby DSL 轻量解析器 — 从 Boxfile / podspec 类文件中提取项目结构信息
 *
 * 不需要完整的 Ruby 解析器，使用正则 + 上下文状态机提取：
 *  - 层级 (layer) 声明与层间访问规则
 *  - 模块 (box) 声明（本地/远程）
 *  - 宿主应用信息
 *  - 模块级 spec 依赖/源文件路径
 *
 * 支持 EasyBox (Boxfile + *.boxspec) 和结构类似的自研工具。
 */

// ── 解析结果类型 ─────────────────────────────────────

export interface ParsedModule {
  name: string;
  version: string;
  isLocal: boolean;
  localPath?: string;
  group?: string;
}

export interface ParsedLayer {
  name: string;
  order: number;
  accessibleLayers: string[];
  modules: ParsedModule[];
}

export interface ParsedProjectConfig {
  hostApp?: { name: string; version: string };
  layers: ParsedLayer[];
  globalDependencies: ParsedModule[];
}

export interface ParsedModuleSpec {
  name: string;
  version: string;
  sources: string;
  dependencies: string[];
  publicHeaders: string[];
  deploymentTarget?: string;
}

// ── Boxfile 解析 ────────────────────────────────────

/**
 * 解析 Boxfile 内容，提取层级、模块、宿主应用信息
 */
export function parseBoxfile(content: string): ParsedProjectConfig {
  const result: ParsedProjectConfig = {
    layers: [],
    globalDependencies: [],
  };

  // 提取 host_app
  const hostAppMatch = content.match(/host_app\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/);
  if (hostAppMatch) {
    result.hostApp = {
      name: hostAppMatch[1],
      version: hostAppMatch[2] || '0.0.0',
    };
  }

  // 按 layer block 分割解析
  const layerBlocks = extractLayerBlocks(content);
  let layerOrder = 0;

  for (const block of layerBlocks) {
    const layer: ParsedLayer = {
      name: block.name,
      order: layerOrder++,
      accessibleLayers: extractAccessLayers(block.body),
      modules: extractModules(block.body),
    };
    result.layers.push(layer);
  }

  // 提取 layer 外层的全局模块声明
  const outsideLayerContent = removeLayerBlocks(content);
  result.globalDependencies = extractModules(outsideLayerContent);

  return result;
}

// ── *.boxspec / *.podspec 解析 ────────────────────────

/**
 * 解析 boxspec/podspec 文件内容，提取模块元数据
 */
export function parseModuleSpec(content: string): ParsedModuleSpec {
  return {
    name: extractSpecField(content, 'name') || 'unknown',
    version: extractSpecField(content, 'version') || '0.0.0',
    sources:
      extractSpecField(content, 'source_files') ||
      extractSpecField(content, 'sources') ||
      extractSpecField(content, 'source') ||
      '',
    dependencies: extractSpecDependencies(content),
    publicHeaders:
      extractSpecArrayField(content, 'public_headers') ||
      extractSpecArrayField(content, 'public_header_files') ||
      [],
    deploymentTarget: extractSpecDeploymentTarget(content),
  };
}

// ── Layer 块提取 ────────────────────────────────────

interface LayerBlock {
  name: string;
  body: string;
  startIndex: number;
  endIndex: number;
}

/**
 * 提取所有 layer 'Name' do ... end 块
 * 使用 do/end 嵌套计数处理嵌套 block
 */
function extractLayerBlocks(content: string): LayerBlock[] {
  const blocks: LayerBlock[] = [];
  const layerRe = /layer\s+['"](\w+)['"]\s+do\b/g;
  let match: RegExpExecArray | null;

  while ((match = layerRe.exec(content)) !== null) {
    const name = match[1];
    const startIndex = match.index;
    const bodyStart = match.index + match[0].length;

    const endIndex = findMatchingEnd(content, bodyStart);
    if (endIndex === -1) {
      continue;
    }

    blocks.push({
      name,
      body: content.substring(bodyStart, endIndex),
      startIndex,
      endIndex: endIndex + 3, // 'end' is 3 chars
    });
  }

  return blocks;
}

/**
 * 从 do 之后的位置开始，找到匹配的 end
 * 处理嵌套的 do...end 块（如 group do ... end）
 */
function findMatchingEnd(content: string, startPos: number): number {
  let depth = 1;
  // 逐行扫描以正确识别 do/end 关键字（避免匹配字符串内的）
  const lines = content.substring(startPos).split('\n');
  let pos = startPos;

  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过注释行
    if (trimmed.startsWith('#')) {
      pos += line.length + 1;
      continue;
    }

    // 计算该行的 do 和 end
    // 匹配行尾的 do（不匹配字符串内的）
    if (/\bdo\b\s*(?:#.*)?$/.test(trimmed)) {
      depth++;
    }
    // 匹配行首的 end（独立的 end 关键字）
    if (/^\s*end\b/.test(line)) {
      depth--;
      if (depth === 0) {
        return pos;
      }
    }

    pos += line.length + 1;
  }

  return -1;
}

/**
 * 移除所有 layer 块，返回剩余内容（用于提取全局模块）
 */
function removeLayerBlocks(content: string): string {
  const blocks = extractLayerBlocks(content);
  if (blocks.length === 0) {
    return content;
  }

  let result = '';
  let lastEnd = 0;
  for (const block of blocks) {
    result += content.substring(lastEnd, block.startIndex);
    lastEnd = block.endIndex;
  }
  result += content.substring(lastEnd);
  return result;
}

// ── Box/模块提取 ────────────────────────────────────

/**
 * 从内容中提取所有 box 声明
 *
 * 支持格式：
 *   box 'Name', 'Version'
 *   box 'Name', :path => 'LocalModule/Name'
 *   box 'Name', path: 'LocalModule/Name'
 *   box 'Name', '~> 1.0', :path => '...'
 */
function extractModules(content: string): ParsedModule[] {
  const modules: ParsedModule[] = [];
  const seen = new Set<string>();

  // 当前 group 上下文跟踪
  let currentGroup: string | undefined;
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // 跳过注释
    if (trimmed.startsWith('#')) {
      continue;
    }

    // 检查 group 开始
    const groupMatch = trimmed.match(/group\s+['"]([^'"]+)['"]\s+do/);
    if (groupMatch) {
      currentGroup = groupMatch[1];
      continue;
    }

    // 检查 group/layer 结束
    if (/^\s*end\b/.test(line) && currentGroup) {
      currentGroup = undefined;
      continue;
    }

    // 解析 box 声明
    const boxMatch = trimmed.match(/^box\s+['"]([^'"]+)['"]/);
    if (!boxMatch) {
      continue;
    }

    const name = boxMatch[1];
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    const rest = trimmed.substring(boxMatch[0].length);

    // 检查是否有 :path（本地模块）
    const pathMatch = rest.match(/:path\s*=>\s*['"]([^'"]+)['"]|path:\s*['"]([^'"]+)['"]/);
    const isLocal = pathMatch !== null;
    const localPath = pathMatch ? pathMatch[1] || pathMatch[2] : undefined;

    // 提取版本号
    let version = '';
    const versionMatch = rest.match(/,\s*['"]([^'"]+)['"]/);
    if (versionMatch && !versionMatch[1].includes('/')) {
      version = versionMatch[1];
    }

    modules.push({
      name,
      version,
      isLocal,
      localPath,
      group: currentGroup,
    });
  }

  return modules;
}

// ── Access 规则提取 ─────────────────────────────────

/**
 * 提取 access 声明中的层名列表
 *
 * 支持格式：
 *   access 'Layer1', 'Layer2', 'Layer3'
 *   access "Layer1", "Layer2"
 */
function extractAccessLayers(content: string): string[] {
  const layers: string[] = [];
  const accessRe = /access\s+(.+)/g;
  let match: RegExpExecArray | null;

  while ((match = accessRe.exec(content)) !== null) {
    const rest = match[1];
    const nameRe = /['"]([^'"]+)['"]/g;
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = nameRe.exec(rest)) !== null) {
      if (!layers.includes(nameMatch[1])) {
        layers.push(nameMatch[1]);
      }
    }
  }

  return layers;
}

// ── Spec 字段提取 ───────────────────────────────────

/**
 * 从 podspec/boxspec 中提取单值字段
 * 支持: s.name = 'Value' 和 spec.name = 'Value'
 */
function extractSpecField(content: string, field: string): string | undefined {
  const re = new RegExp(`\\b\\w+\\.${field}\\s*=\\s*['"]([^'"]+)['"]`, 'i');
  const match = content.match(re);
  return match ? match[1] : undefined;
}

/**
 * 从 podspec/boxspec 中提取 dependency 声明列表
 *
 * 支持:
 *   s.dependency 'ModuleName'
 *   s.dependency 'ModuleName', '~> 1.0'
 *   s.dependency "ModuleName"
 */
function extractSpecDependencies(content: string): string[] {
  const deps: string[] = [];
  const re = /\b\w+\.dependency\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(content)) !== null) {
    if (!deps.includes(match[1])) {
      deps.push(match[1]);
    }
  }

  return deps;
}

/**
 * 从 podspec/boxspec 中提取数组字段
 * 支持: s.public_headers = ['path1', 'path2']
 */
function extractSpecArrayField(content: string, field: string): string[] | undefined {
  const re = new RegExp(`\\b\\w+\\.${field}\\s*=\\s*\\[([^\\]]+)\\]`, 'i');
  const match = content.match(re);
  if (!match) {
    return undefined;
  }

  const items: string[] = [];
  const itemRe = /['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(match[1])) !== null) {
    items.push(m[1]);
  }
  return items.length > 0 ? items : undefined;
}

/**
 * 提取部署目标版本
 * 支持: s.ios.deployment_target = '13.0'
 */
function extractSpecDeploymentTarget(content: string): string | undefined {
  const match = content.match(/\b\w+\.ios\.deployment_target\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1] : undefined;
}
