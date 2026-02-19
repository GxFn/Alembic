/**
 * 流式聊天事件处理器 — 提取自 AiChatView / GlobalChatDrawer 的公共逻辑
 *
 * 将 SSE 事件流驱动的状态机封装为可复用的回调工厂，避免两个聊天界面维护重复代码。
 *
 * @module hooks/useChatStream
 */

import type { SSEEvent } from '../api';

/** 工具名 → 人类可读标签 */
const TOOL_LABELS: Record<string, string> = {
  // ── 项目探索 ──
  get_project_overview:    '获取项目概况',
  list_project_structure:  '浏览目录结构',
  read_project_file:       '读取文件内容',
  search_project_code:     '搜索代码',
  get_file_summary:        '获取文件摘要',
  semantic_search_code:    '语义搜索代码',
  // ── AST 结构分析 ──
  get_class_hierarchy:     '分析类继承关系',
  get_class_info:          '获取类详情',
  get_protocol_info:       '获取协议信息',
  get_method_overrides:    '分析方法重写',
  get_category_map:        '获取分类扩展',
  // ── 知识库 ──
  search_knowledge:        '搜索知识库',
  search_recipes:          '搜索代码片段',
  search_candidates:       '搜索候选条目',
  get_recipe_detail:       '获取片段详情',
  get_related_recipes:     '查找关联片段',
  get_project_stats:       '获取项目统计',
  knowledge_overview:      '知识库概览',
  // ── AI 处理 ──
  summarize_code:          '生成代码摘要',
  ai_translate:            '翻译文本',
  analyze_code:            '分析代码',
  extract_recipes:         '提取代码片段',
  enrich_candidate:        '丰富候选内容',
  refine_bootstrap_candidates: '润色候选批次',
  // ── 质量与管理 ──
  check_duplicate:         '查重检测',
  discover_relations:      '发现关联关系',
  add_graph_edge:          '添加知识图谱边',
  validate_candidate:      '校验候选',
  quality_score:           '质量评分',
  submit_knowledge:        '提交知识条目',
  submit_with_check:       '提交并查重',
  save_document:           '保存文档',
  // ── 生命周期 ──
  approve_candidate:       '审批候选',
  reject_candidate:        '驳回候选',
  publish_recipe:          '发布片段',
  deprecate_recipe:        '废弃片段',
  update_recipe:           '更新片段',
  record_usage:            '记录使用',
  // ── 规则与守卫 ──
  guard_check_code:        '代码规范检查',
  query_violations:        '查询违规记录',
  generate_guard_rule:     '生成守卫规则',
  list_guard_rules:        '列出守卫规则',
  // ── Agent 能力 ──
  get_recommendations:     '获取推荐',
  get_feedback_stats:      '获取反馈统计',
  graph_impact_analysis:   '影响分析',
  rebuild_index:           '重建索引',
  query_audit_log:         '查询审计日志',
  bootstrap_knowledge:     '引导知识采集',
  // ── 技能 ──
  load_skill:              '加载技能',
  create_skill:            '创建技能',
  suggest_skills:          '推荐技能',
  // ── 规划与反思 ──
  plan_task:               '规划任务',
  review_my_output:        '自检输出质量',
  get_tool_details:        '查看工具说明',
  // ── Agent Memory ──
  get_previous_analysis:   '回顾历史分析',
  note_finding:            '记录发现',
  get_previous_evidence:   '查阅已有证据',
};

/** 将工具名转为人类可读标签，未知工具保留原名 */
function toolLabel(name: string): string {
  return TOOL_LABELS[name] || name;
}

/**
 * 从 tool:start 的 args 中提取简短上下文摘要
 * 例: read_project_file({filePath:"src/App.tsx"}) → "App.tsx"
 */
function toolContext(tool: string, args: Record<string, any> | undefined): string {
  if (!args) return '';
  switch (tool) {
    case 'read_project_file': {
      // 支持单文件 filePath 和批量 filePaths
      const p = args.filePath || (Array.isArray(args.filePaths) ? args.filePaths[0] : '');
      if (!p) return '';
      const name = String(p).split('/').pop() || p;
      const extra = Array.isArray(args.filePaths) && args.filePaths.length > 1
        ? ` 等 ${args.filePaths.length} 个文件`
        : '';
      return `${name}${extra}`;
    }
    case 'list_project_structure': {
      const dir = args.directory || args.path || '';
      return dir ? String(dir) : '';
    }
    case 'search_project_code': {
      const patterns = args.patterns || args.pattern || args.query || '';
      if (Array.isArray(patterns)) return patterns.slice(0, 2).join(', ') + (patterns.length > 2 ? ' …' : '');
      return String(patterns).slice(0, 40);
    }
    case 'semantic_search_code':
    case 'search_knowledge':
    case 'search_recipes':
    case 'search_candidates': {
      const q = args.query || args.keyword || '';
      return String(q).slice(0, 40);
    }
    case 'get_class_info':
    case 'get_protocol_info': {
      return args.className || args.name || args.protocolName || '';
    }
    case 'get_file_summary': {
      const fp = args.filePath || '';
      return fp ? String(fp).split('/').pop() || '' : '';
    }
    case 'summarize_code':
    case 'analyze_code': {
      const lang = args.language || '';
      return lang ? `${lang}` : '';
    }
    case 'get_class_hierarchy': {
      return args.rootClass || '';
    }
    case 'check_duplicate': {
      return args.title || '';
    }
    default:
      return '';
  }
}

/** 组合标签 + 上下文为一行摘要 */
function toolSummary(tool: string, args?: Record<string, any>): string {
  const label = toolLabel(tool);
  const ctx = toolContext(tool, args);
  return ctx ? `${label}: ${ctx}` : label;
}

/**
 * 创建 SSE 事件状态机回调 + 局部状态容器
 *
 * 使用方式:
 * ```ts
 * const { onEvent, getState } = createStreamEventHandler(assistantId, setMessages);
 * const result = await api.chatStream(text, history, onEvent, signal);
 * // result.text / getState().answerText 均可获取最终文本
 * ```
 */
export function createStreamEventHandler(
  assistantId: string,
  setMessages: React.Dispatch<React.SetStateAction<any[]>>,
) {
  const toolLogs: string[] = [];
  /** 保留每条 log 对应的 tool+args，供 tool:end 时生成一致摘要 */
  const toolMeta: Array<{ tool: string; args?: Record<string, any> }> = [];
  let answerText = '';

  /** 更新指定 assistant 消息的内容 */
  function updateContent(content: string) {
    setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content } : m));
  }

  function onEvent(evt: SSEEvent) {
    switch (evt.type) {
      case 'step:start': {
        const phaseLabel = evt.phase === 'user' ? '' : ` [${evt.phase}]`;
        const statusText = toolLogs.length > 0
          ? toolLogs.join('\n') + `\n\n🔄 第 ${evt.step}/${evt.maxSteps} 轮推理${phaseLabel}...`
          : `🔄 第 ${evt.step}/${evt.maxSteps} 轮推理${phaseLabel}...`;
        updateContent(statusText);
        break;
      }
      case 'tool:start': {
        toolLogs.push(`🔧 ${toolSummary(evt.tool, evt.args)}...`);
        toolMeta.push({ tool: evt.tool, args: evt.args });
        updateContent(toolLogs.join('\n'));
        break;
      }
      case 'tool:end': {
        const lastIdx = toolLogs.length - 1;
        if (lastIdx >= 0) {
          const meta = toolMeta[lastIdx] || { tool: evt.tool };
          const summary = toolSummary(meta.tool, meta.args);
          if (evt.status === 'error' || evt.error) {
            toolLogs[lastIdx] = `❌ ${summary} 失败 (${evt.duration}ms)`;
          } else {
            const sizeStr = evt.resultSize > 1000 ? `${(evt.resultSize / 1024).toFixed(1)}KB` : `${evt.resultSize}字符`;
            toolLogs[lastIdx] = `✅ ${summary} → ${sizeStr} (${evt.duration}ms)`;
          }
          updateContent(toolLogs.join('\n'));
        }
        break;
      }
      case 'text:start': {
        answerText = '';
        break;
      }
      case 'text:delta': {
        answerText += evt.delta || '';
        const prefix = toolLogs.length > 0 ? toolLogs.join('\n') + '\n\n---\n\n' : '';
        updateContent(prefix + answerText);
        break;
      }
      // text:end, step:end, stream:start, stream:done — 不需要额外 UI 处理
    }
  }

  return {
    onEvent,
    /** 获取当前局部状态（answerText、toolLogs） */
    getState: () => ({ answerText, toolLogs }),
  };
}
