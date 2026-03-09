/**
 * WikiRenderers.js — Wiki 文档渲染函数
 *
 * 从 WikiGenerator.js 中提取的 Markdown 渲染器和 AI Prompt 构建函数。
 * 所有函数均为无状态纯函数（不依赖 class 实例）。
 *
 * 类型定义已提取到 WikiTypes.ts，供多文件共享使用。
 *
 * @module WikiRenderers
 */

import path from 'node:path';
import { LanguageService } from '../../shared/LanguageService.js';
import type {
  WikiAstInfo,
  WikiBuildSystem,
  WikiCodeEntityGraph,
  WikiData,
  WikiDependency,
  WikiFolderProfile,
  WikiKnowledgeInfo,
  WikiModuleData,
  WikiModuleInfo,
  WikiPatternData,
  WikiProjectInfo,
  WikiRecipe,
  WikiRecipeJson,
  WikiTarget,
  WikiTopic,
} from './WikiTypes.js';
import {
  getInheritanceRoots,
  getLangTerms,
  getModuleSourceFiles,
  inferModulePurpose,
  mermaidId,
  slug,
} from './WikiUtils.js';

// Re-export types for backward compatibility
export type { WikiData } from './WikiTypes.js';

// ═══ AI Prompt 构建 ════════════════════════════════════════

/**
 * 为特定主题构建 AI 撰写 prompt (V3 AI-first 核心)
 *
 * 关键区别: 不是润色骨架，而是提供丰富数据让 AI 写完整文章
 *
 * @param data { projectInfo, astInfo, moduleInfo, knowledgeInfo }
 */
export function buildArticlePrompt(
  topic: WikiTopic,
  data: WikiData,
  isZh: boolean,
  codeEntityGraph: WikiCodeEntityGraph | null
) {
  const { projectInfo, astInfo, moduleInfo, knowledgeInfo } = data;
  const parts: string[] = [];
  const langTerms = getLangTerms(projectInfo.primaryLanguage || 'unknown');
  const tl = isZh ? langTerms.typeLabel.zh : langTerms.typeLabel.en;
  const il = isZh ? langTerms.interfaceLabel.zh : langTerms.interfaceLabel.en;

  // 公共项目上下文
  parts.push(`# 项目: ${projectInfo.name}`);
  parts.push(
    `源文件数: ${projectInfo.sourceFiles.length}, 模块: ${moduleInfo.targets.length}, 活跃知识条目: ${knowledgeInfo.recipes.length}`
  );
  if (projectInfo.languages) {
    parts.push(
      `语言分布: ${(Object.entries(projectInfo.languages) as [string, number][])
        .sort((a, b) => b[1] - a[1])
        .map(([l, c]) => `${l}(${c})`)
        .join(', ')}`
    );
  }
  parts.push('');

  switch (topic.type) {
    case 'overview': {
      parts.push('## 任务: 撰写项目概述文档');
      parts.push('');

      // 项目类型
      const buildTypes = (projectInfo.buildSystems || []).map((b: WikiBuildSystem) => b.buildTool);
      if (projectInfo.hasPackageSwift && !buildTypes.some((t: string) => t.includes('SPM'))) {
        buildTypes.push('SPM');
      }
      if (projectInfo.hasPodfile && !buildTypes.includes('CocoaPods')) {
        buildTypes.push('CocoaPods');
      }
      if (projectInfo.hasXcodeproj) {
        buildTypes.push('Xcode Project');
      }
      if (buildTypes.length > 0) {
        parts.push(`构建系统: ${buildTypes.join(' + ')}`);
      }
      parts.push('');

      // 模块结构
      if (moduleInfo.targets.length > 0) {
        parts.push('### 模块列表');
        for (const t of moduleInfo.targets) {
          const files = getModuleSourceFiles(t, projectInfo);
          const cls = astInfo.classNamesByModule?.[t.name]?.length || 0;
          const deps = (t.dependencies || t.info?.dependencies || []).map(
            (d: string | WikiDependency) => (typeof d === 'string' ? d : d.name)
          );
          parts.push(
            `- ${t.name} (${t.type || 'target'}): ${files.length} 文件, ${cls} 个类型${deps.length > 0 ? `, 依赖: ${deps.join(', ')}` : ''}`
          );
        }
        parts.push('');
      }

      // AST 概况
      if (astInfo.overview) {
        parts.push('### 代码规模');
        parts.push(
          `${tl}: ${astInfo.overview.totalClasses || 0}, ${il}: ${astInfo.overview.totalProtocols || 0}, 方法: ${astInfo.overview.totalMethods || 0}`
        );
        parts.push('');
      }

      // 可用的其他文档（用于导航链接）
      const otherTopics = (topic._allTopics || []).filter((t: WikiTopic) => t.type !== 'overview');
      if (otherTopics.length > 0) {
        parts.push('### 需要包含的导航链接');
        for (const t of otherTopics) {
          parts.push(`- [${t.title}](${t.path})`);
        }
        parts.push('');
      }

      parts.push('要求: 撰写完整的项目概述文档。');
      parts.push(
        '包含: 项目简介(解释项目做什么)、模块总览(表格形式)、技术栈分析、核心数据指标、文档导航索引。'
      );
      parts.push('不要只列数据 — 要解释项目的定位、各模块的职责和协作关系。');
      break;
    }

    case 'architecture': {
      parts.push('## 任务: 撰写架构分析文档');
      parts.push('');

      if (moduleInfo.targets.length > 0) {
        parts.push('### 模块及依赖关系');
        for (const t of moduleInfo.targets) {
          const deps = (t.dependencies || t.info?.dependencies || []).map(
            (d: string | WikiDependency) => (typeof d === 'string' ? d : d.name)
          );
          parts.push(
            `- ${t.name} (${t.type || 'target'})${deps.length > 0 ? ` → 依赖: ${deps.join(', ')}` : ''}`
          );
        }
        parts.push('');
      }

      if (astInfo.overview?.topLevelModules && astInfo.overview.topLevelModules.length > 0) {
        parts.push(`### 顶层模块: ${astInfo.overview.topLevelModules.join(', ')}`);
        const cpm = astInfo.overview.classesPerModule || {};
        for (const mod of astInfo.overview.topLevelModules) {
          parts.push(`  ${mod}: ${cpm[mod] || 0} 个类`);
        }
        parts.push('');
      }

      if (astInfo.overview?.entryPoints && astInfo.overview.entryPoints.length > 0) {
        parts.push(`### 入口点: ${astInfo.overview.entryPoints.join(', ')}`);
        parts.push('');
      }

      const roots = getInheritanceRoots(codeEntityGraph);
      if (roots.length > 0) {
        parts.push('### 核心继承关系');
        for (const r of roots.slice(0, 10)) {
          parts.push(`- ${r.name} → ${(r.children || []).slice(0, 5).join(', ')}`);
        }
        parts.push('');
      }

      parts.push('要求: 撰写架构分析文档。');
      parts.push(
        '包含: 模块依赖图(使用 Mermaid graph TD 语法)、分层架构分析(解释每层的职责)、模块间协作关系、架构设计决策阐述。'
      );
      parts.push('用 Mermaid 绘制依赖关系图和继承层次图。分析为什么采用这种架构。');
      break;
    }

    case 'module': {
      const md = topic._moduleData as unknown as WikiModuleData;
      const target = md.target;
      const moduleFiles = md.moduleFiles;
      const moduleClasses = astInfo.classNamesByModule?.[target.name] || [];
      const moduleProtocols = astInfo.protocolNamesByModule?.[target.name] || [];
      const deps = target.dependencies || target.info?.dependencies || [];

      parts.push(`## 任务: 撰写 "${target.name}" 模块的深度文档`);
      parts.push('');
      parts.push('### 模块基本信息');
      parts.push(`- 类型: ${target.type || 'target'}`);
      const tPath = target.path || target.info?.path;
      if (tPath) {
        parts.push(`- 路径: ${tPath}`);
      }
      if (target.packageName) {
        parts.push(`- 所属包: ${target.packageName}`);
      }
      parts.push(`- 源文件: ${moduleFiles.length} 个`);
      parts.push(`- ${tl}: ${moduleClasses.length} 个`);
      parts.push(`- ${il}: ${moduleProtocols.length} 个`);
      parts.push('');

      if (deps.length > 0) {
        parts.push(
          `### 依赖: ${deps.map((d: string | WikiDependency) => (typeof d === 'string' ? d : d.name)).join(', ')}`
        );
        parts.push('');
      }

      if (moduleClasses.length > 0) {
        parts.push(`### 类型列表: ${moduleClasses.slice(0, 30).join(', ')}`);
        parts.push('');
      }

      if (moduleProtocols.length > 0) {
        parts.push(`### ${il}列表: ${moduleProtocols.slice(0, 20).join(', ')}`);
        parts.push('');
      }

      // 关键源文件名（帮助 AI 推断模块功能）
      if (moduleFiles.length > 0) {
        const keyFiles = moduleFiles.slice(0, 25).map((f: string) => path.basename(f));
        parts.push(`### 关键源文件: ${keyFiles.join(', ')}`);
        parts.push('');
      }

      // 相关 recipes
      const related = knowledgeInfo.recipes.filter((r: WikiRecipe) => {
        const json = r.toJSON ? r.toJSON() : r;
        return (
          json.moduleName === target.name ||
          json.tags?.includes(target.name) ||
          json.title?.includes(target.name)
        );
      });
      if (related.length > 0) {
        parts.push(`### 相关知识条目 (${related.length})`);
        for (const r of related.slice(0, 10)) {
          const json = r.toJSON ? r.toJSON() : r;
          parts.push(`- ${json.title}: ${json.description || ''}`);
          if (json.reasoning?.whyStandard) {
            parts.push(`  为什么: ${json.reasoning.whyStandard}`);
          }
        }
        parts.push('');
      }

      parts.push('要求: 撰写模块深度分析文档。');
      parts.push(
        '包含: 模块职责说明(从文件名和类名推断功能意图)、核心类型分析(不是简单罗列而是解释每个类的角色)、依赖关系分析、设计模式识别。'
      );
      parts.push('如果能推断出数据流或协作关系，请用 Mermaid 图表展示。');
      break;
    }

    case 'getting-started': {
      parts.push('## 任务: 撰写快速上手指南');
      parts.push('');

      // 列出检测到的构建系统
      const bs = projectInfo.buildSystems || [];
      if (bs.length > 0) {
        parts.push(`构建系统: ${bs.map((b: WikiBuildSystem) => b.buildTool).join(', ')}`);
      } else {
        // 兼容旧数据
        if (projectInfo.hasPackageSwift) {
          parts.push('构建系统: Swift Package Manager');
        }
        if (projectInfo.hasPodfile) {
          parts.push('构建系统: CocoaPods');
        }
        if (projectInfo.hasXcodeproj) {
          parts.push('构建系统: Xcode Project');
        }
      }
      parts.push('');

      if (moduleInfo.targets.length > 0) {
        const mainTargets = moduleInfo.targets.filter((t: WikiTarget) => t.type !== 'test');
        const testTargets = moduleInfo.targets.filter((t: WikiTarget) => t.type === 'test');
        if (mainTargets.length > 0) {
          parts.push(`主要 Target: ${mainTargets.map((t: WikiTarget) => t.name).join(', ')}`);
        }
        if (testTargets.length > 0) {
          parts.push(`测试 Target: ${testTargets.map((t: WikiTarget) => t.name).join(', ')}`);
        }
        parts.push('');
      }

      if (astInfo.overview?.entryPoints && astInfo.overview.entryPoints.length > 0) {
        parts.push(`入口点: ${astInfo.overview.entryPoints.join(', ')}`);
        parts.push('');
      }

      parts.push('要求: 撰写开发者快速上手指南。');
      parts.push(
        '包含: 环境要求、项目获取、依赖安装、构建步骤(具体命令)、运行测试、项目目录结构说明。'
      );
      parts.push('语句清晰，步骤明确，适合新人阅读。');
      break;
    }

    case 'patterns': {
      parts.push('## 任务: 撰写代码模式与最佳实践文档');
      parts.push('');

      const groups: Record<string, WikiRecipeJson[]> = {};
      for (const r of knowledgeInfo.recipes) {
        const json = r.toJSON ? r.toJSON() : r;
        const cat = json.category || 'Other';
        if (!groups[cat]) {
          groups[cat] = [];
        }
        groups[cat].push(json);
      }

      for (const [cat, items] of Object.entries(groups).sort()) {
        parts.push(`### ${cat} (${items.length} 条)`);
        for (const item of items.slice(0, 8)) {
          parts.push(`- ${item.title}: ${item.description || 'N/A'}`);
          if (item.doClause) {
            parts.push(`  应当: ${item.doClause}`);
          }
          if (item.dontClause) {
            parts.push(`  避免: ${item.dontClause}`);
          }
          if (item.content?.pattern) {
            parts.push(`  代码片段: ${item.content.pattern.slice(0, 200)}`);
          }
        }
        parts.push('');
      }

      parts.push('要求: 撰写代码模式文档。对每个分类进行总结分析，解释模式的意义和应用场景。');
      parts.push(
        '不要只列出条目 — 为每个分类写一段总结，解释该类模式的整体意图。附带代码示例(从数据中取)。'
      );
      break;
    }

    case 'pattern-category': {
      const pd = topic._patternData as unknown as WikiPatternData;
      parts.push(`## 任务: 撰写 "${pd.category}" 分类的代码模式文档`);
      parts.push('');

      for (const item of pd.recipes) {
        parts.push(`### ${item.title}`);
        if (item.description) {
          parts.push(`描述: ${item.description}`);
        }
        if (item.doClause) {
          parts.push(`应当: ${item.doClause}`);
        }
        if (item.dontClause) {
          parts.push(`避免: ${item.dontClause}`);
        }
        if (item.reasoning?.whyStandard) {
          parts.push(`原因: ${item.reasoning.whyStandard}`);
        }
        if (item.content?.pattern) {
          parts.push('代码:');
          parts.push('```');
          parts.push(item.content.pattern.slice(0, 500));
          parts.push('```');
        }
        parts.push('');
      }

      parts.push('要求: 撰写该分类的详细代码模式文档。');
      parts.push(
        '先写一段总结性概述，然后对每个模式做分析，解释为什么要遵循，给出正确和错误的对比示例。'
      );
      break;
    }

    case 'reference': {
      parts.push(`## 任务: 撰写${il}参考文档`);
      parts.push('');

      const protoByModule: Record<string, string[]> = astInfo.protocolNamesByModule || {};
      for (const [mod, protos] of Object.entries(protoByModule).sort()) {
        if (protos.length > 0) {
          parts.push(`### ${mod} 模块: ${protos.join(', ')}`);
        }
      }
      parts.push('');
      parts.push(`总计: ${astInfo.protocols.length} 个${il}, ${astInfo.classes.length} 个${tl}`);
      parts.push('');
      parts.push(
        `要求: 撰写${il}参考文档。按模块分组，分析每个${il}的用途和意义，描述${il}之间的关系和设计意图。`
      );
      break;
    }

    case 'folder-overview': {
      const profiles = (topic._folderProfiles || []) as unknown as WikiFolderProfile[];
      parts.push('## 任务: 撰写项目文件夹结构分析文档');
      parts.push('');
      parts.push('注意: 本项目的代码实体（类/函数/协议等）无法通过 AST 自动提取，');
      parts.push('因此以「文件夹画像」方式进行结构分析。');
      parts.push('');
      parts.push(`### 发现 ${profiles.length} 个重要文件夹`);
      parts.push('');
      for (const fp of profiles) {
        parts.push(`#### ${fp.relPath}`);
        parts.push(`- 源文件: ${fp.fileCount} 个, 总大小: ${(fp.totalSize / 1024).toFixed(1)}KB`);
        parts.push(
          `- 语言分布: ${Object.entries(fp.langBreakdown)
            .map(([l, c]) => `${l}(${c})`)
            .join(', ')}`
        );
        if (fp.entryPoints.length > 0) {
          parts.push(`- 入口文件: ${fp.entryPoints.join(', ')}`);
        }
        if (fp.namingPatterns.length > 0) {
          parts.push(`- 命名约定: ${fp.namingPatterns.join(', ')}`);
        }
        if (fp.imports.length > 0) {
          parts.push(`- 依赖引用: ${fp.imports.join(', ')}`);
        }
        if (fp.purpose) {
          parts.push(`- 推断功能: ${fp.purpose.zh || fp.purpose.en || '-'}`);
        }
        if (fp.readme) {
          parts.push(`- README 摘要: ${fp.readme.slice(0, 200)}`);
        }
        if (fp.headerComments.length > 0) {
          parts.push(`- 代码注释: ${fp.headerComments.join('; ')}`);
        }
        parts.push('');
      }
      parts.push('要求: 撰写项目结构分析文档。');
      parts.push('重点分析:');
      parts.push('1. 项目整体架构分层 — 从文件夹结构推断项目架构（MVC/分层/微服务等）');
      parts.push('2. 各文件夹的职责与协作关系 — 从文件命名和 import 关系推断');
      parts.push('3. 用 Mermaid graph TD 画出文件夹之间的依赖关系图');
      parts.push('4. 从命名约定分析团队编码规范');
      parts.push('5. 对照文件夹的文件分布特征，评估项目的工程化程度');
      break;
    }

    case 'folder-profile': {
      const fp = topic._folderProfile as unknown as WikiFolderProfile;
      parts.push(`## 任务: 撰写 "${fp.name}" 目录的深度分析文档`);
      parts.push('');
      parts.push('注意: 本项目的代码实体无法通过 AST 提取，以下分析基于文件夹画像。');
      parts.push('');
      parts.push('### 目录信息');
      parts.push(`- 路径: ${fp.relPath}`);
      parts.push(`- 源文件: ${fp.fileCount} 个`);
      parts.push(`- 总大小: ${(fp.totalSize / 1024).toFixed(1)}KB`);
      parts.push(
        `- 语言分布: ${Object.entries(fp.langBreakdown)
          .map(([l, c]) => `${l}(${c})`)
          .join(', ')}`
      );
      parts.push('');

      if (fp.entryPoints.length > 0) {
        parts.push(`### 入口文件: ${fp.entryPoints.join(', ')}`);
        parts.push('');
      }

      if (fp.readme) {
        parts.push('### 目录 README');
        parts.push(fp.readme.slice(0, 500));
        parts.push('');
      }

      if (fp.fileNames.length > 0) {
        parts.push(`### 文件列表 (${fp.fileNames.length} 个)`);
        parts.push(fp.fileNames.slice(0, 40).join(', '));
        parts.push('');
      }

      if (fp.namingPatterns.length > 0) {
        parts.push(`### 命名约定: ${fp.namingPatterns.join(', ')}`);
        parts.push('');
      }

      if (fp.imports.length > 0) {
        parts.push(`### 依赖引用: ${fp.imports.join(', ')}`);
        parts.push('');
      }

      if (fp.headerComments.length > 0) {
        parts.push('### 关键文件注释');
        for (const hc of fp.headerComments) {
          parts.push(`- ${hc}`);
        }
        parts.push('');
      }

      parts.push('要求: 撰写该目录的深度分析文档。');
      parts.push('包含: 目录职责推断(从文件名和注释推断)、文件组织分析、命名规范评估、');
      parts.push('依赖关系分析(从 import 推断)、关键文件说明。');
      parts.push('从文件命名模式推断出这个目录承担的功能角色和设计意图。');
      break;
    }
  }

  return parts.join('\n');
}

/**
 * 构建非 AI 降级的丰富模板内容
 * 即使没有 AI，也要产出有意义的内容 (不是只有列表罗列)
 *
 * @param data { projectInfo, astInfo, moduleInfo, knowledgeInfo }
 */
export function buildFallbackArticle(
  topic: WikiTopic,
  data: WikiData,
  isZh: boolean,
  codeEntityGraph: WikiCodeEntityGraph | null
) {
  const { projectInfo, astInfo, moduleInfo, knowledgeInfo } = data;

  switch (topic.type) {
    case 'overview':
      return renderIndex(
        projectInfo,
        astInfo,
        moduleInfo,
        knowledgeInfo,
        isZh,
        topic._allTopics || []
      );
    case 'architecture':
      return renderArchitecture(projectInfo, astInfo, moduleInfo, isZh, codeEntityGraph);
    case 'getting-started':
      return renderGettingStarted(projectInfo, moduleInfo, astInfo, isZh);
    case 'module':
      return renderModule(
        (topic._moduleData as unknown as WikiModuleData).target,
        astInfo,
        knowledgeInfo,
        isZh,
        projectInfo
      );
    case 'patterns':
      return renderPatterns(knowledgeInfo, isZh);
    case 'pattern-category':
      return renderPatternCategory(topic._patternData as unknown as WikiPatternData, isZh);
    case 'reference':
      return renderProtocolReference(astInfo, isZh, projectInfo);
    case 'folder-overview':
      return renderFolderOverview(
        topic._folderProfiles as unknown as WikiFolderProfile[],
        projectInfo,
        isZh
      );
    case 'folder-profile':
      return renderFolderProfile(
        topic._folderProfile as unknown as WikiFolderProfile,
        projectInfo,
        isZh
      );
    default:
      return '';
  }
}

// ═══ Markdown 渲染器 ═══════════════════════════════════════

/** 渲染项目概述页 (index.md) */
export function renderIndex(
  project: WikiProjectInfo,
  ast: WikiAstInfo,
  modules: WikiModuleInfo,
  knowledge: WikiKnowledgeInfo,
  isZh: boolean,
  allTopics: WikiTopic[]
) {
  const title = isZh ? '项目概述' : 'Project Overview';
  const langTerms = getLangTerms(project.primaryLanguage || 'unknown');
  const tl = isZh ? langTerms.typeLabel.zh : langTerms.typeLabel.en;
  const il = isZh ? langTerms.interfaceLabel.zh : langTerms.interfaceLabel.en;

  const lines = [
    `# ${project.name} — ${title}`,
    '',
    `> ${isZh ? '本文档由 AutoSnippet Repo Wiki 自动生成' : 'Auto-generated by AutoSnippet Repo Wiki'}`,
    `> ${isZh ? '生成时间' : 'Generated at'}: ${new Date().toISOString()}`,
    '',
  ];

  // ── 项目简介 ──
  lines.push(`## ${isZh ? '简介' : 'Introduction'}`);
  lines.push('');

  // 从 buildSystems 或 legacy 字段推断项目类型标签
  const types: string[] = [];
  if (project.buildSystems && project.buildSystems.length > 0) {
    for (const bs of project.buildSystems) {
      types.push(bs.buildTool);
    }
  } else {
    if (project.hasPackageSwift) {
      types.push('SPM');
    }
    if (project.hasPodfile) {
      types.push('CocoaPods');
    }
    if (project.hasXcodeproj) {
      types.push('Xcode Project');
    }
  }
  const projectTypeLabel =
    types.join(' + ') ||
    (project.primaryLanguage ? LanguageService.displayName(project.primaryLanguage) : 'Software');

  const overview = ast.overview || {};
  const mainTargets = modules.targets.filter((t: WikiTarget) => t.type !== 'test');
  const testTargets = modules.targets.filter((t: WikiTarget) => t.type === 'test');

  if (isZh) {
    lines.push(
      `**${project.name}** 是一个 ${projectTypeLabel} 项目，` +
        `包含 ${project.sourceFiles.length} 个源文件` +
        (overview.totalClasses ? `、${overview.totalClasses} 个${tl}` : '') +
        (overview.totalProtocols ? `、${overview.totalProtocols} 个${il}` : '') +
        `。`
    );
    if (mainTargets.length > 0) {
      lines.push(
        `项目由 ${mainTargets.length} 个功能模块组成` +
          (testTargets.length > 0 ? `，配备 ${testTargets.length} 个测试模块` : '') +
          `。`
      );
    }
  } else {
    lines.push(
      `**${project.name}** is a ${projectTypeLabel} project ` +
        `containing ${project.sourceFiles.length} source files` +
        (overview.totalClasses ? `, ${overview.totalClasses} ${tl}` : '') +
        (overview.totalProtocols ? `, ${overview.totalProtocols} ${il}` : '') +
        `.`
    );
    if (mainTargets.length > 0) {
      lines.push(
        `The project consists of ${mainTargets.length} functional modules` +
          (testTargets.length > 0 ? ` with ${testTargets.length} test modules` : '') +
          `.`
      );
    }
  }
  lines.push('');

  // ── 模块总览 ──
  if (modules.targets.length > 0) {
    lines.push(`## ${isZh ? '模块总览' : 'Module Overview'}`);
    lines.push('');
    lines.push(
      `| ${isZh ? '模块' : 'Module'} | ${isZh ? '类型' : 'Type'} | ${isZh ? '源文件' : 'Files'} | ${tl} | ${il} |`
    );
    lines.push('|--------|------|--------|--------|----------|');
    for (const t of modules.targets) {
      const moduleFiles = getModuleSourceFiles(t, project);
      const classCount = ast.classNamesByModule?.[t.name]?.length || 0;
      const protoCount = ast.protocolNamesByModule?.[t.name]?.length || 0;
      const hasDoc = allTopics?.some(
        (tp: WikiTopic) =>
          tp.type === 'module' &&
          (tp._moduleData as WikiModuleData | undefined)?.target.name === t.name
      );
      const nameCol = hasDoc ? `[${t.name}](modules/${slug(t.name)}.md)` : t.name;
      lines.push(
        `| ${nameCol} | ${t.type || 'target'} | ${moduleFiles.length || '-'} | ${classCount || '-'} | ${protoCount || '-'} |`
      );
    }
    lines.push('');
  } else if (project.sourceFilesByModule && Object.keys(project.sourceFilesByModule).length >= 2) {
    // 无 moduleService targets → 使用 sourceFilesByModule 推断的模块
    const sfm: Record<string, string[]> = project.sourceFilesByModule;
    const sorted = Object.entries(sfm).sort((a, b) => b[1].length - a[1].length);
    lines.push(`## ${isZh ? '模块总览' : 'Module Overview'}`);
    lines.push('');
    lines.push(
      isZh
        ? `项目代码按目录结构可划分为 ${sorted.length} 个模块:`
        : `The project code is organized into ${sorted.length} modules:`
    );
    lines.push('');
    lines.push(
      `| ${isZh ? '模块' : 'Module'} | ${isZh ? '源文件' : 'Files'} | ${isZh ? '说明' : 'Description'} |`
    );
    lines.push('|--------|--------|------|');
    for (const [modName, modFiles] of sorted.slice(0, 15)) {
      const hasDoc = allTopics?.some(
        (tp: WikiTopic) => tp.type === 'module' && tp.title === modName
      );
      const nameCol = hasDoc ? `[${modName}](modules/${slug(modName)}.md)` : modName;
      const purpose = inferModulePurpose(modName, [], [], modFiles);
      const desc = purpose ? (isZh ? purpose.zh : purpose.en) : '-';
      lines.push(`| ${nameCol} | ${modFiles.length} | ${desc} |`);
    }
    lines.push('');
  }

  // ── 技术栈 ──
  lines.push(`## ${isZh ? '技术栈' : 'Tech Stack'}`);
  lines.push('');
  if (project.languages && Object.keys(project.languages).length > 0) {
    lines.push(
      `| ${isZh ? '语言' : 'Language'} | ${isZh ? '文件数' : 'Files'} | ${isZh ? '占比' : 'Share'} |`
    );
    lines.push('|--------|-------|------|');
    const langMap: Record<string, number> = project.languages;
    const total = Object.values(langMap).reduce((a, b) => a + b, 0);
    for (const [lang, count] of Object.entries(langMap).sort((a, b) => b[1] - a[1])) {
      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
      lines.push(`| ${lang} | ${count} | ${pct}% |`);
    }
    lines.push('');
  }

  // ── 核心数据 ──
  lines.push(`## ${isZh ? '核心数据' : 'Key Metrics'}`);
  lines.push('');
  lines.push(`| ${isZh ? '指标' : 'Metric'} | ${isZh ? '数量' : 'Count'} |`);
  lines.push('|--------|-------|');
  lines.push(`| ${isZh ? '源文件数' : 'Source Files'} | ${project.sourceFiles.length} |`);
  if (overview.totalClasses) {
    lines.push(`| ${tl} | ${overview.totalClasses} |`);
  }
  if (overview.totalProtocols) {
    lines.push(`| ${il} | ${overview.totalProtocols} |`);
  }
  if (overview.totalMethods) {
    lines.push(`| ${isZh ? '方法总数' : 'Methods'} | ${overview.totalMethods} |`);
  }
  if (modules.targets.length > 0) {
    lines.push(`| ${isZh ? '模块数' : 'Modules'} | ${modules.targets.length} |`);
  }
  if (knowledge.recipes.length > 0) {
    lines.push(`| ${isZh ? '知识库条目' : 'KB Recipes'} | ${knowledge.recipes.length} |`);
  }
  lines.push('');

  // ── 文档导航 (动态，基于实际生成的主题) ──
  const navTopics = (allTopics || []).filter((t: WikiTopic) => t.type !== 'overview');
  if (navTopics.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(`## ${isZh ? '📖 文档导航' : '📖 Documentation'}`);
    lines.push('');
    for (const t of navTopics) {
      lines.push(`- [${t.title}](${t.path})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** 渲染架构总览文档 (architecture.md) */
export function renderArchitecture(
  project: WikiProjectInfo,
  ast: WikiAstInfo,
  modules: WikiModuleInfo,
  isZh: boolean,
  codeEntityGraph: WikiCodeEntityGraph | null
) {
  const lines = [
    `# ${isZh ? '架构总览' : 'Architecture Overview'}`,
    '',
    `> ${isZh ? '本文档由 AutoSnippet Repo Wiki 自动生成' : 'Auto-generated by AutoSnippet Repo Wiki'}`,
    '',
  ];

  // 依赖图 (Mermaid)
  if (modules.targets.length > 0) {
    lines.push(`## ${isZh ? '模块依赖图' : 'Module Dependency Graph'}`);
    lines.push('');
    lines.push('```mermaid');
    lines.push('graph TD');

    // 渲染 target 节点和依赖边
    const rendered = new Set();
    for (const target of modules.targets) {
      const sid = mermaidId(target.name);
      if (!rendered.has(sid)) {
        const shape =
          target.type === 'test' ? `${sid}[["${target.name} (Test)"]]` : `${sid}["${target.name}"]`;
        lines.push(`    ${shape}`);
        rendered.add(sid);
      }
    }

    // 如果有依赖图数据，渲染边
    if (modules.depGraph) {
      const edges = modules.depGraph.edges || [];
      for (const edge of Array.isArray(edges) ? edges : []) {
        if (edge.from && edge.to) {
          const fromId = mermaidId(edge.from.split('::').pop() || edge.from);
          const toId = mermaidId(edge.to.split('::').pop() || edge.to);
          lines.push(`    ${fromId} --> ${toId}`);
        }
      }
    }

    lines.push('```');
    lines.push('');
  } else if (project.sourceFilesByModule && Object.keys(project.sourceFilesByModule).length >= 2) {
    // 无 moduleService → 从 sourceFilesByModule 推断模块结构图
    const sfm: Record<string, string[]> = project.sourceFilesByModule;
    // 只显示有实质内容的模块（>= 2 个文件），避免单文件噪声
    const sorted = Object.entries(sfm)
      .filter(([, files]) => files.length >= 2)
      .sort((a, b) => b[1].length - a[1].length);
    const topModules = sorted.slice(0, 15);

    lines.push(`## ${isZh ? '模块结构图' : 'Module Structure'}`);
    lines.push('');
    lines.push('```mermaid');
    lines.push('graph TD');
    lines.push(`    Root["${project.name}"]`);
    for (const [modName] of topModules) {
      const sid = mermaidId(modName);
      lines.push(`    ${sid}["${modName}"]`);
      lines.push(`    Root --> ${sid}`);
    }
    lines.push('```');
    lines.push('');

    // 模块详情表
    lines.push(`## ${isZh ? '模块详情' : 'Module Details'}`);
    lines.push('');
    lines.push(
      `| ${isZh ? '模块' : 'Module'} | ${isZh ? '源文件数' : 'Files'} | ${isZh ? '说明' : 'Description'} |`
    );
    lines.push('|--------|-------|------|');
    for (const [modName, modFiles] of topModules) {
      const purpose = inferModulePurpose(modName, [], [], modFiles);
      const desc = purpose ? (isZh ? purpose.zh : purpose.en) : '-';
      lines.push(`| ${modName} | ${modFiles.length} | ${desc} |`);
    }
    lines.push('');
  }

  // 分层架构
  if (ast.overview) {
    const modules = ast.overview.topLevelModules || [];
    if (modules.length > 0) {
      lines.push(`## ${isZh ? '顶层模块' : 'Top-Level Modules'}`);
      lines.push('');
      lines.push(`| ${isZh ? '模块' : 'Module'} | ${isZh ? '类数量' : 'Classes'} |`);
      lines.push('|--------|---------|');
      const cpm = ast.overview.classesPerModule || {};
      for (const mod of modules) {
        lines.push(`| ${mod} | ${cpm[mod] || 0} |`);
      }
      lines.push('');
    }

    // 入口点
    if (ast.overview?.entryPoints && ast.overview.entryPoints.length > 0) {
      lines.push(`## ${isZh ? '入口点' : 'Entry Points'}`);
      lines.push('');
      for (const ep of ast.overview.entryPoints) {
        lines.push(`- \`${ep}\``);
      }
      lines.push('');
    }
  }

  // 继承层次 (from CodeEntityGraph)
  if (codeEntityGraph) {
    try {
      const topClasses = getInheritanceRoots(codeEntityGraph);
      if (topClasses.length > 0) {
        lines.push(`## ${isZh ? '核心继承层次' : 'Key Inheritance Hierarchy'}`);
        lines.push('');
        lines.push('```mermaid');
        lines.push('classDiagram');
        for (const root of topClasses.slice(0, 20)) {
          lines.push(`    class ${mermaidId(root.name)}`);
          for (const child of root.children || []) {
            lines.push(`    ${mermaidId(root.name)} <|-- ${mermaidId(child)}`);
          }
        }
        lines.push('```');
        lines.push('');
      }
    } catch {
      /* non-critical */
    }
  }

  lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](index.md)`);
  lines.push('');
  return lines.join('\n');
}

/** 渲染模块详情文档 (modules/{name}.md) */
export function renderModule(
  target: WikiTarget,
  ast: WikiAstInfo,
  knowledge: WikiKnowledgeInfo,
  isZh: boolean,
  projectInfo: WikiProjectInfo
) {
  const langTerms = getLangTerms(projectInfo?.primaryLanguage || 'unknown');
  const tl = isZh ? langTerms.typeLabel.zh : langTerms.typeLabel.en;
  const il = isZh ? langTerms.interfaceLabel.zh : langTerms.interfaceLabel.en;
  const lines = [
    `# ${target.name}`,
    '',
    `> ${isZh ? '模块文档 — 由 AutoSnippet Repo Wiki 自动生成' : 'Module doc — Auto-generated by AutoSnippet Repo Wiki'}`,
    '',
  ];

  // 收集模块数据
  const moduleFiles = projectInfo ? getModuleSourceFiles(target, projectInfo) : [];
  const moduleClasses = ast.classNamesByModule?.[target.name] || [];
  const moduleProtocols = ast.protocolNamesByModule?.[target.name] || [];
  const deps = target.dependencies || target.info?.dependencies || [];

  // ── 模块概述 ──
  lines.push(`## ${isZh ? '概述' : 'Overview'}`);
  lines.push('');

  // 推断模块功能 (基于名称和内容)
  const purpose = inferModulePurpose(target.name, moduleClasses, moduleProtocols, moduleFiles);
  if (purpose) {
    lines.push(
      isZh
        ? `**${target.name}** ${purpose.zh}，包含 ${moduleFiles.length} 个源文件、${moduleClasses.length} 个${tl}${moduleProtocols.length > 0 ? `、${moduleProtocols.length} 个${il}` : ''}。`
        : `**${target.name}** ${purpose.en}, containing ${moduleFiles.length} source files, ${moduleClasses.length} ${tl}${moduleProtocols.length > 0 ? `, ${moduleProtocols.length} ${il}` : ''}.`
    );
  } else {
    lines.push(
      isZh
        ? `**${target.name}** 是项目中的一个 ${target.type || 'target'} 模块，包含 ${moduleFiles.length} 个源文件、${moduleClasses.length} 个${tl}。`
        : `**${target.name}** is a ${target.type || 'target'} module in the project, containing ${moduleFiles.length} source files and ${moduleClasses.length} ${tl}.`
    );
  }
  lines.push('');

  // ── 模块信息表 ──
  lines.push(`| ${isZh ? '属性' : 'Property'} | ${isZh ? '值' : 'Value'} |`);
  lines.push('|--------|------|');
  lines.push(`| ${isZh ? '类型' : 'Type'} | ${target.type || 'target'} |`);
  if (target.packageName) {
    lines.push(`| ${isZh ? '所属包' : 'Package'} | ${target.packageName} |`);
  }
  if (target.path || target.info?.path) {
    lines.push(`| ${isZh ? '路径' : 'Path'} | \`${target.path || target.info?.path}\` |`);
  }
  if (moduleFiles.length > 0) {
    lines.push(`| ${isZh ? '源文件数' : 'Source Files'} | ${moduleFiles.length} |`);
  }
  if (moduleClasses.length > 0) {
    lines.push(`| ${tl} | ${moduleClasses.length} |`);
  }
  if (moduleProtocols.length > 0) {
    lines.push(`| ${il} | ${moduleProtocols.length} |`);
  }
  if (deps.length > 0) {
    lines.push(`| ${isZh ? '依赖数' : 'Dependencies'} | ${deps.length} |`);
  }
  lines.push('');

  // ── 依赖 ──
  if (deps.length > 0) {
    lines.push(`## ${isZh ? '依赖关系' : 'Dependencies'}`);
    lines.push('');
    lines.push(
      isZh
        ? `${target.name} 依赖以下 ${deps.length} 个模块:`
        : `${target.name} depends on ${deps.length} module(s):`
    );
    lines.push('');
    for (const dep of deps) {
      const depName = typeof dep === 'string' ? dep : dep.name || String(dep);
      lines.push(`- \`${depName}\``);
    }
    lines.push('');
  }

  // ── 核心类型分析 ──
  if (moduleClasses.length > 0 || moduleProtocols.length > 0) {
    lines.push(`## ${isZh ? '核心类型' : 'Core Types'}`);
    lines.push('');

    if (moduleProtocols.length > 0) {
      lines.push(`### ${il} (${moduleProtocols.length})`);
      lines.push('');
      lines.push(
        isZh
          ? `${target.name} 定义了 ${moduleProtocols.length} 个${il}，用于规范模块的接口边界:`
          : `${target.name} defines ${moduleProtocols.length} ${il} establishing the module's interface contracts:`
      );
      lines.push('');
      const sorted = [...moduleProtocols].sort();
      for (const p of sorted.slice(0, 20)) {
        lines.push(`- \`${p}\``);
      }
      if (sorted.length > 20) {
        lines.push(
          `- ... ${isZh ? `还有 ${sorted.length - 20} 个` : `and ${sorted.length - 20} more`}`
        );
      }
      lines.push('');
    }

    if (moduleClasses.length > 0) {
      lines.push(`### ${tl} (${moduleClasses.length})`);
      lines.push('');
      const sorted = [...moduleClasses].sort();
      for (const c of sorted.slice(0, 30)) {
        lines.push(`- \`${c}\``);
      }
      if (sorted.length > 30) {
        lines.push(
          `- ... ${isZh ? `还有 ${sorted.length - 30} 个` : `and ${sorted.length - 30} more`}`
        );
      }
      lines.push('');
    }
  }

  // ── 源文件分布 ──
  if (moduleFiles.length > 0) {
    lines.push(`## ${isZh ? '源文件分布' : 'Source File Distribution'}`);
    lines.push('');

    // 按语言统计
    const langCount: Record<string, number> = {};
    for (const f of moduleFiles) {
      const ext = path.extname(f);
      const lang = LanguageService.displayNameFromExt(ext);
      langCount[lang] = (langCount[lang] || 0) + 1;
    }

    lines.push(`| ${isZh ? '语言' : 'Language'} | ${isZh ? '文件数' : 'Files'} |`);
    lines.push('|--------|-------|');
    for (const [lang, count] of Object.entries(langCount).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${lang} | ${count} |`);
    }
    lines.push('');
  }

  // ── 该模块相关的 Recipes ──
  if (knowledge.recipes.length > 0) {
    const related = knowledge.recipes.filter((r: WikiRecipe) => {
      const json = r.toJSON ? r.toJSON() : r;
      return (
        json.moduleName === target.name ||
        json.tags?.includes(target.name) ||
        json.title?.includes(target.name)
      );
    });
    if (related.length > 0) {
      lines.push(`## ${isZh ? '相关知识条目' : 'Related Recipes'}`);
      lines.push('');
      lines.push(
        isZh
          ? `团队知识库中有 ${related.length} 条与 ${target.name} 相关的条目:`
          : `The team knowledge base contains ${related.length} entries related to ${target.name}:`
      );
      lines.push('');
      for (const r of related) {
        const json = r.toJSON ? r.toJSON() : r;
        lines.push(`### ${json.title}`);
        lines.push('');
        if (json.description) {
          lines.push(json.description);
        }
        if (json.doClause) {
          lines.push(`\n**${isZh ? '✅ 应当' : '✅ Do'}**: ${json.doClause}`);
        }
        if (json.dontClause) {
          lines.push(`**${isZh ? '❌ 避免' : "❌ Don't"}**: ${json.dontClause}`);
        }
        lines.push('');
      }
    }
  }

  lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](../index.md)`);
  lines.push('');
  return lines.join('\n');
}

/** 渲染代码模式文档 (patterns.md) */
export function renderPatterns(knowledge: WikiKnowledgeInfo, isZh: boolean) {
  const lines = [
    `# ${isZh ? '代码模式与最佳实践' : 'Code Patterns & Best Practices'}`,
    '',
    `> ${isZh ? '团队沉淀的代码模式与最佳实践（来自 AutoSnippet 知识库）' : 'Code patterns and best practices from AutoSnippet knowledge base'}`,
    '',
  ];

  // 按 category 分组
  const groups: Record<string, WikiRecipeJson[]> = {};
  for (const r of knowledge.recipes) {
    const json = r.toJSON ? r.toJSON() : r;
    const cat = json.category || 'Other';
    if (!groups[cat]) {
      groups[cat] = [];
    }
    groups[cat].push(json);
  }

  // 总结
  const totalRecipes = knowledge.recipes.length;
  const catCount = Object.keys(groups).length;
  lines.push(
    isZh
      ? `本项目团队在 ${catCount} 个分类下共沉淀了 **${totalRecipes}** 条代码模式和最佳实践。以下按分类进行展示和分析。`
      : `The team has accumulated **${totalRecipes}** code patterns across ${catCount} categories. Below they are organized and analyzed by category.`
  );
  lines.push('');

  for (const [cat, items] of Object.entries(groups).sort()) {
    lines.push(`## ${cat} (${items.length})`);
    lines.push('');

    // 分类概述
    lines.push(
      isZh
        ? `${cat} 分类包含 ${items.length} 条规则，覆盖了该领域的核心规范。`
        : `The ${cat} category contains ${items.length} rules covering core conventions in this area.`
    );
    lines.push('');

    for (const item of items) {
      lines.push(`### ${item.title}`);
      lines.push('');
      if (item.description) {
        lines.push(item.description);
        lines.push('');
      }
      if (item.content?.pattern) {
        lines.push(`\`\`\`${item.language || 'text'}`);
        lines.push(item.content.pattern);
        lines.push('```');
        lines.push('');
      }
      if (item.doClause) {
        lines.push(`**${isZh ? '✅ 应当' : '✅ Do'}**: ${item.doClause}`);
        lines.push('');
      }
      if (item.dontClause) {
        lines.push(`**${isZh ? '❌ 避免' : "❌ Don't"}**: ${item.dontClause}`);
        lines.push('');
      }
      if (item.reasoning?.whyStandard) {
        lines.push(`> ${isZh ? '💡 原因' : '💡 Rationale'}: ${item.reasoning.whyStandard}`);
        lines.push('');
      }
    }
  }

  lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](index.md)`);
  lines.push('');
  return lines.join('\n');
}

// ═══ V3 新增渲染器 ════════════════════════════════════════

/** 快速上手指南 (非 AI 降级模板) */
export function renderGettingStarted(
  project: WikiProjectInfo,
  modules: WikiModuleInfo,
  ast: WikiAstInfo,
  isZh: boolean
) {
  const lines = [
    `# ${isZh ? '快速上手' : 'Getting Started'}`,
    '',
    `> ${isZh ? '本文档由 AutoSnippet Repo Wiki 自动生成' : 'Auto-generated by AutoSnippet Repo Wiki'}`,
    '',
  ];

  // 从 buildSystems 或 legacy 字段推断
  const bs = project.buildSystems || [];
  const ecoSet = new Set(bs.map((b: WikiBuildSystem) => b.eco));

  // ── 环境要求 (按检测到的生态系统动态生成) ──
  lines.push(`## ${isZh ? '环境要求' : 'Prerequisites'}`);
  lines.push('');
  if (ecoSet.has('spm') || project.hasPackageSwift) {
    lines.push(isZh ? '- Swift 5.5+ (推荐 Swift 5.9+)' : '- Swift 5.5+ (Swift 5.9+ recommended)');
    lines.push(isZh ? '- Xcode 14+' : '- Xcode 14+');
    const hasCocoaPods = bs.some((b: WikiBuildSystem) => b.buildTool === 'CocoaPods');
    if (hasCocoaPods || project.hasPodfile) {
      lines.push(isZh ? '- CocoaPods 1.10+' : '- CocoaPods 1.10+');
    }
  }
  if (project.hasXcodeproj) {
    lines.push(isZh ? '- Xcode (最新稳定版)' : '- Xcode (latest stable version)');
    // Xcode 项目额外环境提示
    if (!ecoSet.has('spm') && !project.hasPackageSwift && !project.hasPodfile) {
      lines.push(isZh ? '- macOS (建议最新版本)' : '- macOS (latest version recommended)');
      lines.push(
        isZh
          ? '- Apple Developer Account (如需真机调试)'
          : '- Apple Developer Account (for device testing)'
      );
    }
  }
  if (ecoSet.has('node')) {
    lines.push(isZh ? '- Node.js 18+ (推荐 20 LTS)' : '- Node.js 18+ (20 LTS recommended)');
    const hasYarn = bs.some((b: WikiBuildSystem) => b.buildTool === 'Yarn');
    const hasPnpm = bs.some((b: WikiBuildSystem) => b.buildTool === 'pnpm');
    lines.push(hasYarn ? '- Yarn' : hasPnpm ? '- pnpm' : '- npm');
  }
  if (ecoSet.has('python')) {
    lines.push(isZh ? '- Python 3.8+' : '- Python 3.8+');
    const hasPipenv = bs.some((b: WikiBuildSystem) => b.buildTool === 'Pipenv');
    const hasPoetry = bs.some((b: WikiBuildSystem) => b.buildTool === 'Poetry');
    if (hasPipenv) {
      lines.push('- Pipenv');
    } else if (hasPoetry) {
      lines.push('- Poetry');
    }
  }
  if (ecoSet.has('go')) {
    lines.push(isZh ? '- Go 1.21+' : '- Go 1.21+');
  }
  if (ecoSet.has('rust')) {
    lines.push(isZh ? '- Rust (最新 stable)' : '- Rust (latest stable)');
    lines.push('- Cargo');
  }
  if (ecoSet.has('jvm')) {
    const hasGradle = bs.some((b: WikiBuildSystem) => b.buildTool?.startsWith('Gradle'));
    lines.push(isZh ? '- JDK 17+' : '- JDK 17+');
    lines.push(hasGradle ? '- Gradle' : '- Maven');
  }
  if (ecoSet.has('dart')) {
    lines.push(isZh ? '- Flutter / Dart SDK' : '- Flutter / Dart SDK');
  }
  if (ecoSet.has('dotnet')) {
    lines.push(isZh ? '- .NET 6+ SDK' : '- .NET 6+ SDK');
  }
  if (ecoSet.has('ruby')) {
    lines.push(isZh ? '- Ruby 3.0+' : '- Ruby 3.0+');
    lines.push('- Bundler');
  }
  lines.push('');

  // ── 项目目录结构 ──
  lines.push(`## ${isZh ? '项目结构' : 'Project Structure'}`);
  lines.push('');
  lines.push('```');
  lines.push(`${project.name}/`);
  if (modules.targets.length > 0) {
    const mainTargets = modules.targets.filter((t: WikiTarget) => t.type !== 'test');
    const testTargets = modules.targets.filter((t: WikiTarget) => t.type === 'test');
    if (mainTargets.length > 0) {
      const srcDir = ecoSet.has('spm') || project.hasPackageSwift ? 'Sources' : 'src';
      lines.push(`├── ${srcDir}/`);
      for (let i = 0; i < mainTargets.length; i++) {
        const prefix =
          i === mainTargets.length - 1 && testTargets.length === 0 ? '│   └──' : '│   ├──';
        lines.push(`${prefix} ${mainTargets[i].name}/`);
      }
    }
    if (testTargets.length > 0) {
      const testDir = ecoSet.has('spm') || project.hasPackageSwift ? 'Tests' : 'test';
      lines.push(`├── ${testDir}/`);
      for (let i = 0; i < testTargets.length; i++) {
        const prefix = i === testTargets.length - 1 ? '│   └──' : '│   ├──';
        lines.push(`${prefix} ${testTargets[i].name}/`);
      }
    }
  }
  // 显示构建配置文件
  for (const b of bs) {
    const marker = BUILD_SYSTEM_FILES[b.buildTool];
    if (marker) {
      lines.push(`├── ${marker}`);
    }
  }
  // legacy 兜底
  if (bs.length === 0) {
    if (project.hasPackageSwift) {
      lines.push('├── Package.swift');
    }
    if (project.hasPodfile) {
      lines.push('├── Podfile');
    }
  }
  lines.push('```');
  lines.push('');

  // ── 构建步骤 (按检测到的生态系统动态生成) ──
  lines.push(`## ${isZh ? '构建与运行' : 'Build & Run'}`);
  lines.push('');

  for (const b of bs) {
    _pushBuildSteps(lines, b, project.name, isZh);
  }

  // legacy 兜底 — 如果没有检测到 buildSystems
  if (bs.length === 0) {
    if (project.hasPackageSwift) {
      _pushBuildSteps(lines, { eco: 'spm', buildTool: 'SPM' }, project.name, isZh);
    }
    if (project.hasPodfile) {
      _pushBuildSteps(lines, { eco: 'spm', buildTool: 'CocoaPods' }, project.name, isZh);
    }
    // Xcode 项目兜底 (无 SPM / CocoaPods)
    if (!project.hasPackageSwift && !project.hasPodfile && project.hasXcodeproj) {
      _pushBuildSteps(lines, { eco: 'xcode', buildTool: 'Xcode' }, project.name, isZh);
    }
  }

  // ── 源文件统计 (增强无 moduleService 场景) ──
  if (modules.targets.length === 0 && project.sourceFilesByModule) {
    const sfm: Record<string, string[]> = project.sourceFilesByModule;
    const modEntries = Object.entries(sfm).sort((a, b) => b[1].length - a[1].length);
    if (modEntries.length > 0) {
      lines.push(`## ${isZh ? '项目模块概览' : 'Module Overview'}`);
      lines.push('');
      lines.push(
        `| ${isZh ? '模块' : 'Module'} | ${isZh ? '源文件数' : 'Files'} | ${isZh ? '说明' : 'Description'} |`
      );
      lines.push('|--------|-------|------|');
      for (const [modName, modFiles] of modEntries.slice(0, 15)) {
        const purpose = inferModulePurpose(modName, [], [], modFiles);
        const desc = purpose ? (isZh ? purpose.zh : purpose.en) : '-';
        lines.push(`| ${modName} | ${modFiles.length} | ${desc} |`);
      }
      lines.push('');
    }
  }

  // ── 模块说明 ──
  if (modules.targets.length > 0) {
    const mainTargets = modules.targets.filter((t: WikiTarget) => t.type !== 'test');
    if (mainTargets.length > 0) {
      lines.push(`## ${isZh ? '核心模块' : 'Core Modules'}`);
      lines.push('');
      lines.push(
        `| ${isZh ? '模块' : 'Module'} | ${isZh ? '类型' : 'Type'} | ${isZh ? '类型数' : 'Types'} | ${isZh ? '说明' : 'Description'} |`
      );
      lines.push('|--------|------|--------|------|');
      for (const t of mainTargets) {
        const cls = (ast.classNamesByModule?.[t.name] || []).length;
        const purpose = inferModulePurpose(
          t.name,
          ast.classNamesByModule?.[t.name] || [],
          ast.protocolNamesByModule?.[t.name] || [],
          []
        );
        const desc = purpose ? (isZh ? purpose.zh : purpose.en) : '-';
        lines.push(`| ${t.name} | ${t.type || 'library'} | ${cls} | ${desc} |`);
      }
      lines.push('');
    }
  }

  lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](index.md)`);
  lines.push('');
  return lines.join('\n');
}

/* 构建配置文件名映射 (用于目录树显示) — 从 LanguageService.buildSystemMarkers 动态派生 */
const BUILD_SYSTEM_FILES = Object.fromEntries(
  LanguageService.buildSystemMarkers.map((m) => [m.buildTool, m.file])
);

/**
 * 按生态系统输出构建步骤
 * @private
 */
function _pushBuildSteps(
  lines: string[],
  buildSys: WikiBuildSystem,
  projectName: string,
  isZh: boolean
) {
  const { eco, buildTool } = buildSys;

  lines.push(`### ${isZh ? `使用 ${buildTool}` : `Using ${buildTool}`}`);
  lines.push('');
  lines.push('```bash');
  lines.push(isZh ? '# 获取项目' : '# Clone the project');
  lines.push(`git clone <repository-url>`);
  lines.push(`cd ${projectName}`);
  lines.push('');

  switch (eco) {
    case 'spm':
      if (buildTool === 'CocoaPods') {
        lines.push('pod install');
        lines.push('open *.xcworkspace');
      } else {
        lines.push(isZh ? '# 解析依赖' : '# Resolve dependencies');
        lines.push('swift package resolve');
        lines.push('');
        lines.push(isZh ? '# 构建' : '# Build');
        lines.push('swift build');
        lines.push('');
        lines.push(isZh ? '# 运行测试' : '# Run tests');
        lines.push('swift test');
      }
      break;
    case 'node':
      if (buildTool === 'Yarn') {
        lines.push('yarn install');
        lines.push('yarn build');
        lines.push('yarn test');
      } else if (buildTool === 'pnpm') {
        lines.push('pnpm install');
        lines.push('pnpm build');
        lines.push('pnpm test');
      } else {
        lines.push('npm install');
        lines.push('npm run build');
        lines.push('npm test');
      }
      break;
    case 'python':
      if (buildTool === 'Poetry') {
        lines.push('poetry install');
        lines.push('poetry run pytest');
      } else if (buildTool === 'Pipenv') {
        lines.push('pipenv install');
        lines.push('pipenv run pytest');
      } else {
        lines.push('pip install -r requirements.txt');
        lines.push('pytest');
      }
      break;
    case 'go':
      lines.push('go mod download');
      lines.push('go build ./...');
      lines.push('go test ./...');
      break;
    case 'rust':
      lines.push('cargo build');
      lines.push('cargo test');
      break;
    case 'jvm':
      if (buildTool?.startsWith('Gradle')) {
        lines.push('./gradlew build');
        lines.push('./gradlew test');
      } else {
        lines.push('mvn install');
        lines.push('mvn test');
      }
      break;
    case 'dart':
      lines.push('flutter pub get');
      lines.push('flutter run');
      lines.push('flutter test');
      break;
    case 'dotnet':
      lines.push('dotnet restore');
      lines.push('dotnet build');
      lines.push('dotnet test');
      break;
    case 'ruby':
      lines.push('bundle install');
      break;
    case 'xcode':
      lines.push(isZh ? '# 使用 Xcode 打开项目' : '# Open with Xcode');
      lines.push(`open *.xcodeproj 2>/dev/null || open *.xcworkspace`);
      lines.push('');
      lines.push(isZh ? '# 或通过命令行构建' : '# Or build via command line');
      lines.push(`xcodebuild -project *.xcodeproj -scheme ${projectName} build`);
      break;
    default:
      lines.push(isZh ? '# 请查阅项目 README' : '# Please refer to the project README');
      break;
  }

  lines.push('```');
  lines.push('');
}

/** 按分类拆分的代码模式文档 */
export function renderPatternCategory(
  patternData: { category: string; recipes: WikiRecipeJson[] },
  isZh: boolean
) {
  const { category, recipes } = patternData;
  const lines = [
    `# ${category}`,
    '',
    `> ${isZh ? `${category} 分类下的 ${recipes.length} 条代码模式（来自 AutoSnippet 知识库）` : `${recipes.length} code patterns in ${category} category (from AutoSnippet KB)`}`,
    '',
  ];

  // 分类概述
  lines.push(
    isZh
      ? `本文档收录了 ${category} 分类下的 ${recipes.length} 条代码模式和规范，这些规则由团队在开发实践中总结沉淀。`
      : `This document covers ${recipes.length} code patterns and conventions in the ${category} category, distilled from team development practices.`
  );
  lines.push('');

  for (const item of recipes) {
    lines.push(`## ${item.title}`);
    lines.push('');
    if (item.description) {
      lines.push(item.description);
      lines.push('');
    }
    if (item.doClause) {
      lines.push(`**${isZh ? '✅ 应当' : '✅ Do'}**: ${item.doClause}`);
      lines.push('');
    }
    if (item.dontClause) {
      lines.push(`**${isZh ? '❌ 避免' : "❌ Don't"}**: ${item.dontClause}`);
      lines.push('');
    }
    if (item.content?.pattern) {
      lines.push(`\`\`\`${item.language || 'text'}`);
      lines.push(item.content.pattern);
      lines.push('```');
      lines.push('');
    }
    if (item.reasoning?.whyStandard) {
      lines.push(`> ${isZh ? '💡 原因' : '💡 Rationale'}: ${item.reasoning.whyStandard}`);
      lines.push('');
    }
  }

  lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](../index.md)`);
  lines.push('');
  return lines.join('\n');
}

/** 协议参考文档 */
export function renderProtocolReference(
  ast: WikiAstInfo,
  isZh: boolean,
  projectInfo: WikiProjectInfo
) {
  const langTerms = getLangTerms(projectInfo?.primaryLanguage || 'unknown');
  const il = isZh ? langTerms.interfaceLabel.zh : langTerms.interfaceLabel.en;

  const lines = [
    `# ${isZh ? `${il}参考` : `${il} Reference`}`,
    '',
    `> ${isZh ? `项目中定义的 ${ast.protocols.length} 个${il}` : `${ast.protocols.length} ${il} defined in the project`}`,
    '',
  ];

  lines.push(
    isZh
      ? `${il}定义了类型需要遵循的接口契约。本项目共定义了 ${ast.protocols.length} 个${il}，以下按模块分组展示。`
      : `${il} define interface contracts that types must conform to. This project defines ${ast.protocols.length} ${il}, organized by module below.`
  );
  lines.push('');

  // 按模块分组
  const protoByModule: Record<string, string[]> = ast.protocolNamesByModule || {};
  const grouped = new Set();

  for (const [mod, protos] of Object.entries(protoByModule).sort()) {
    if (protos.length === 0) {
      continue;
    }
    lines.push(`## ${mod}`);
    lines.push('');
    lines.push(
      isZh
        ? `${mod} 模块定义了 ${protos.length} 个${il}:`
        : `${mod} module defines ${protos.length} ${il}:`
    );
    lines.push('');
    for (const p of protos.sort()) {
      lines.push(`- \`${p}\``);
      grouped.add(p);
    }
    lines.push('');
  }

  // 未分组的接口类型
  const ungrouped = ast.protocols.filter((p: string) => !grouped.has(p));
  if (ungrouped.length > 0) {
    lines.push(`## ${isZh ? `其他${il}` : `Other ${il}`}`);
    lines.push('');
    for (const p of ungrouped.sort()) {
      lines.push(`- \`${p}\``);
    }
    lines.push('');
  }

  lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](index.md)`);
  lines.push('');
  return lines.join('\n');
}

// ═══ Folder Profile 渲染器 (AST 不可用时的降级策略) ═══════

/** 渲染文件夹结构总览 (folder-structure.md) */
export function renderFolderOverview(
  profiles: WikiFolderProfile[],
  projectInfo: WikiProjectInfo,
  isZh: boolean
) {
  const lines = [
    `# ${isZh ? '项目结构分析' : 'Project Structure Analysis'}`,
    '',
    `> ${isZh ? '本文档由 AutoSnippet Repo Wiki 自动生成（基于文件夹画像分析）' : 'Auto-generated by AutoSnippet Repo Wiki (folder profiling mode)'}`,
    '',
  ];

  // 说明为什么是文件夹分析模式
  lines.push(
    isZh
      ? `> 💡 本项目的主要语言 (${LanguageService.displayName(projectInfo.primaryLanguage!)}) 暂不支持深度 AST 解析，因此使用文件夹画像分析来代替。`
      : `> 💡 The project's primary language (${LanguageService.displayName(projectInfo.primaryLanguage!)}) does not support deep AST analysis yet, so folder profiling is used instead.`
  );
  lines.push('');

  // ── 结构鸟瞰 (Mermaid) ──
  lines.push(`## ${isZh ? '结构鸟瞰' : 'Structure Overview'}`);
  lines.push('');
  lines.push('```mermaid');
  lines.push('graph TD');
  lines.push(`    Root["${projectInfo.name}"]`);

  // 只显示深度 = 1 的顶层文件夹
  const topLevel = profiles.filter((fp: WikiFolderProfile) => fp.depth === 1);

  for (const fp of topLevel) {
    const sid = mermaidId(fp.name);
    lines.push(`    ${sid}["${fp.name} (${fp.fileCount})"]`);
    lines.push(`    Root --> ${sid}`);
  }

  // 画 import 关系边
  const folderNames = new Set(profiles.map((fp: WikiFolderProfile) => fp.name));
  for (const fp of profiles) {
    const fromId = mermaidId(fp.name);
    for (const imp of fp.imports) {
      if (folderNames.has(imp) && imp !== fp.name) {
        lines.push(`    ${fromId} -.-> ${mermaidId(imp)}`);
      }
    }
  }

  lines.push('```');
  lines.push('');

  // ── 文件夹总览表 ──
  lines.push(`## ${isZh ? '文件夹总览' : 'Folder Overview'}`);
  lines.push('');
  lines.push(
    `| ${isZh ? '文件夹' : 'Folder'} | ${isZh ? '路径' : 'Path'} | ${isZh ? '文件数' : 'Files'} | ${isZh ? '大小' : 'Size'} | ${isZh ? '语言' : 'Languages'} | ${isZh ? '说明' : 'Description'} |`
  );
  lines.push('|--------|------|-------|------|------|------|');

  for (const fp of profiles) {
    const hasDoc = fp.fileCount >= 5;
    const folderDocSlug = slug(fp.relPath.replaceAll('/', '-'));
    const nameCol = hasDoc ? `[${fp.relPath}](folders/${folderDocSlug}.md)` : fp.relPath;
    const sizeStr =
      fp.totalSize > 1024 * 1024
        ? `${(fp.totalSize / 1024 / 1024).toFixed(1)}MB`
        : `${(fp.totalSize / 1024).toFixed(1)}KB`;
    const langs = (Object.entries(fp.langBreakdown) as [string, number][])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([l]) => l)
      .join(', ');
    const desc = fp.purpose ? (isZh ? fp.purpose.zh : fp.purpose.en) : '-';
    lines.push(
      `| ${nameCol} | \`${fp.relPath}\` | ${fp.fileCount} | ${sizeStr} | ${langs} | ${desc} |`
    );
  }
  lines.push('');

  // ── 命名约定总结 ──
  const allPatterns: Record<string, number> = {};
  for (const fp of profiles) {
    for (const p of fp.namingPatterns) {
      allPatterns[p] = (allPatterns[p] || 0) + 1;
    }
  }
  const commonPatterns = Object.entries(allPatterns)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1]);

  if (commonPatterns.length > 0) {
    lines.push(`## ${isZh ? '命名约定' : 'Naming Conventions'}`);
    lines.push('');
    lines.push(
      isZh
        ? '通过分析文件命名模式，检测到以下在多个文件夹中出现的约定:'
        : 'The following naming conventions were detected across multiple folders:'
    );
    lines.push('');
    for (const [pattern, count] of commonPatterns) {
      lines.push(
        `- **${pattern}** — ${isZh ? `出现在 ${count} 个文件夹` : `found in ${count} folders`}`
      );
    }
    lines.push('');
  }

  // ── 依赖关系 ──
  const allImports: { from: string; to: string }[] = [];
  for (const fp of profiles) {
    for (const imp of fp.imports) {
      if (folderNames.has(imp) && imp !== fp.name) {
        allImports.push({ from: fp.name, to: imp });
      }
    }
  }

  if (allImports.length > 0) {
    lines.push(`## ${isZh ? '文件夹间依赖' : 'Inter-Folder Dependencies'}`);
    lines.push('');
    lines.push(
      isZh
        ? '通过分析 import/require 语句推断的文件夹间引用关系:'
        : 'Dependencies between folders inferred from import/require statements:'
    );
    lines.push('');
    for (const dep of allImports) {
      lines.push(`- \`${dep.from}\` → \`${dep.to}\``);
    }
    lines.push('');
  }

  lines.push(`[← ${isZh ? '返回概述' : 'Back to Overview'}](index.md)`);
  lines.push('');
  return lines.join('\n');
}

/** 渲染单个文件夹的深度画像文档 (folders/{name}.md) */
export function renderFolderProfile(
  fp: WikiFolderProfile,
  projectInfo: WikiProjectInfo,
  isZh: boolean
) {
  const lines = [
    `# ${fp.name}`,
    '',
    `> ${isZh ? '文件夹画像文档 — 由 AutoSnippet Repo Wiki 自动生成' : 'Folder profile doc — Auto-generated by AutoSnippet Repo Wiki'}`,
    '',
  ];

  // ── 概述 ──
  lines.push(`## ${isZh ? '概述' : 'Overview'}`);
  lines.push('');

  const purposeStr = fp.purpose
    ? isZh
      ? fp.purpose.zh
      : fp.purpose.en
    : isZh
      ? '通过文件夹画像分析推断其功能'
      : 'functionality inferred from folder profiling';

  if (isZh) {
    lines.push(
      `**${fp.name}** 位于 \`${fp.relPath}\`，${purposeStr}。` +
        `包含 ${fp.fileCount} 个源文件，总大小 ${(fp.totalSize / 1024).toFixed(1)}KB。`
    );
  } else {
    lines.push(
      `**${fp.name}** is located at \`${fp.relPath}\`, ${purposeStr}. ` +
        `Contains ${fp.fileCount} source files totaling ${(fp.totalSize / 1024).toFixed(1)}KB.`
    );
  }
  lines.push('');

  // ── 信息表 ──
  lines.push(`| ${isZh ? '属性' : 'Property'} | ${isZh ? '值' : 'Value'} |`);
  lines.push('|--------|------|');
  lines.push(`| ${isZh ? '路径' : 'Path'} | \`${fp.relPath}\` |`);
  lines.push(`| ${isZh ? '源文件数' : 'Source Files'} | ${fp.fileCount} |`);
  const sizeStr =
    fp.totalSize > 1024 * 1024
      ? `${(fp.totalSize / 1024 / 1024).toFixed(1)}MB`
      : `${(fp.totalSize / 1024).toFixed(1)}KB`;
  lines.push(`| ${isZh ? '总大小' : 'Total Size'} | ${sizeStr} |`);
  if (fp.entryPoints.length > 0) {
    lines.push(`| ${isZh ? '入口文件' : 'Entry Points'} | ${fp.entryPoints.join(', ')} |`);
  }
  lines.push('');

  // ── README (如果有) ──
  if (fp.readme) {
    lines.push(`## ${isZh ? '目录说明' : 'Directory README'}`);
    lines.push('');
    lines.push(
      `> ${fp.readme
        .split('\n')
        .filter((l: string) => l.trim())
        .slice(0, 5)
        .join('\n> ')}`
    );
    lines.push('');
  }

  // ── 语言分布 ──
  lines.push(`## ${isZh ? '语言分布' : 'Language Distribution'}`);
  lines.push('');
  lines.push(
    `| ${isZh ? '语言' : 'Language'} | ${isZh ? '文件数' : 'Files'} | ${isZh ? '占比' : 'Share'} |`
  );
  lines.push('|--------|-------|------|');
  const langBreakdown: Record<string, number> = fp.langBreakdown;
  const total = Object.values(langBreakdown).reduce((a, b) => a + b, 0);
  for (const [lang, count] of Object.entries(langBreakdown).sort((a, b) => b[1] - a[1])) {
    const pct = total > 0 ? ((count / total) * 100).toFixed(0) : 0;
    lines.push(`| ${lang} | ${count} | ${pct}% |`);
  }
  lines.push('');

  // ── 文件列表 (分类展示) ──
  lines.push(`## ${isZh ? '文件列表' : 'File Listing'}`);
  lines.push('');

  // 按类别分: 入口文件 / 大文件 / 普通文件
  if (fp.entryPoints.length > 0) {
    lines.push(`### ${isZh ? '🎯 入口文件' : '🎯 Entry Points'}`);
    lines.push('');
    for (const ep of fp.entryPoints) {
      lines.push(`- \`${ep}\``);
    }
    lines.push('');
  }

  if (fp.keyFiles.length > 0) {
    lines.push(`### ${isZh ? '📌 关键文件' : '📌 Key Files'}`);
    lines.push('');
    lines.push(
      isZh
        ? '以下文件体积最大或作为入口文件，可能包含核心逻辑:'
        : 'These files are the largest or serve as entry points, likely containing core logic:'
    );
    lines.push('');
    for (const kf of fp.keyFiles) {
      lines.push(`- \`${path.basename(kf)}\``);
    }
    lines.push('');
  }

  // 所有文件列表 (截断)
  const maxDisplay = 50;
  lines.push(`### ${isZh ? '全部文件' : 'All Files'} (${fp.fileNames.length})`);
  lines.push('');
  for (const fn of fp.fileNames.slice(0, maxDisplay)) {
    lines.push(`- \`${fn}\``);
  }
  if (fp.fileNames.length > maxDisplay) {
    lines.push(
      `- ... ${isZh ? `还有 ${fp.fileNames.length - maxDisplay} 个文件` : `and ${fp.fileNames.length - maxDisplay} more files`}`
    );
  }
  lines.push('');

  // ── 命名约定 ──
  if (fp.namingPatterns.length > 0) {
    lines.push(`## ${isZh ? '命名约定' : 'Naming Conventions'}`);
    lines.push('');
    lines.push(
      isZh
        ? '通过分析文件命名模式，检测到以下约定:'
        : 'Detected naming conventions from file name analysis:'
    );
    lines.push('');
    for (const p of fp.namingPatterns) {
      lines.push(`- **${p}**`);
    }
    lines.push('');
  }

  // ── 依赖关系 ──
  if (fp.imports.length > 0) {
    lines.push(`## ${isZh ? '依赖引用' : 'Dependencies'}`);
    lines.push('');
    lines.push(
      isZh
        ? `通过分析 import/require 语句，\`${fp.name}\` 引用了以下模块/目录:`
        : `From import/require analysis, \`${fp.name}\` references the following modules/directories:`
    );
    lines.push('');
    for (const imp of fp.imports) {
      lines.push(`- \`${imp}\``);
    }
    lines.push('');
  }

  // ── 代码注释摘要 ──
  if (fp.headerComments.length > 0) {
    lines.push(`## ${isZh ? '代码注释摘要' : 'Code Comments Summary'}`);
    lines.push('');
    lines.push(
      isZh ? '从关键文件头部提取的注释信息:' : 'Comments extracted from key file headers:'
    );
    lines.push('');
    for (const hc of fp.headerComments) {
      lines.push(`- ${hc}`);
    }
    lines.push('');
  }

  lines.push(
    `[← ${isZh ? '返回结构分析' : 'Back to Structure Analysis'}](../folder-structure.md) | [← ${isZh ? '返回概述' : 'Back to Overview'}](../index.md)`
  );
  lines.push('');
  return lines.join('\n');
}

// ═══ V3 AI 系统 Prompt ═══════════════════════════════════

/** 构建 AI 系统 Prompt (V3 — 撰写完整文章，非润色骨架) */
export function buildAiSystemPrompt(isZh: boolean) {
  if (isZh) {
    return [
      '你是 AutoSnippet Repo Wiki 文档撰写专家。',
      '',
      '任务: 基于代码分析数据，撰写高质量、有深度的项目文档。',
      '',
      '写作原则:',
      '1. 所有类名、文件名、数字必须来自提供的数据，严禁编造',
      '2. 不要简单罗列数据 — 要分析和解释，描述"为什么这样设计"、"模块的职责是什么"',
      '3. 从文件名和类名推断功能意图，给出有见地的分析',
      '4. 用自然语言连贯行文，包含过渡段落和总结性描述',
      '5. 合理使用 Mermaid 图表（graph TD / classDiagram）、表格、代码块来辅助说明',
      '6. 用中文撰写',
      '7. 输出纯 Markdown，不要包裹在代码块中',
      '8. 每篇文章以一级标题 (#) 开始，结构清晰',
      '9. 篇幅适中：300-2000 字（根据主题复杂度调整）',
      '10. 文末包含返回链接: [← 返回概述](index.md) 或 [← 返回概述](../index.md)',
    ].join('\n');
  }
  return [
    'You are the AutoSnippet Repo Wiki documentation expert.',
    '',
    'Task: Write high-quality, insightful project documentation based on code analysis data.',
    '',
    'Writing principles:',
    '1. All class names, file names, and numbers must come from the provided data — never fabricate',
    '2. Do not simply list data — analyze and explain: describe design rationale, module responsibilities',
    '3. Infer functional intent from file names and class names, provide insightful analysis',
    '4. Write coherent prose with transition paragraphs and summaries',
    '5. Use Mermaid diagrams (graph TD / classDiagram), tables, and code blocks judiciously',
    '6. Write in English',
    '7. Output pure Markdown — do not wrap in code blocks',
    '8. Start each article with a level-1 heading (#), maintain clear structure',
    '9. Appropriate length: 300-2000 words (adjust by topic complexity)',
    '10. End with a back link: [← Back to Overview](index.md) or [← Back to Overview](../index.md)',
  ].join('\n');
}
