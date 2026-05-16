/**
 * 流式聊天事件处理器 — 提取自 AiChatView / GlobalChatDrawer 的公共逻辑
 *
 * 将 SSE 事件流驱动的状态机封装为可复用的回调工厂，避免两个聊天界面维护重复代码。
 *
 * @module hooks/useChatStream
 */

import type { SSEEvent } from '../api';

/** i18n t 函数签名（与 useI18n().t 一致） */
type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** 将工具名转为人类可读标签（通过 i18n），未知工具保留原名 */
function toolLabel(t: TFn, name: string): string {
  const key = `chatStream.tools.${name}`;
  const label = t(key);
  // t() 对未知 key 会原样返回，检测到时 fallback 到原始工具名
  return label === key ? name : label;
}

/**
 * 从 tool:start 的 args 中提取简短上下文摘要
 * 例: read_project_file({filePath:"src/App.tsx"}) → "App.tsx"
 */
function toolContext(t: TFn, tool: string, args: Record<string, any> | undefined): string {
  if (!args) return '';
  switch (tool) {
    case 'read_project_file': {
      // 支持单文件 filePath 和批量 filePaths
      const p = args.filePath || (Array.isArray(args.filePaths) ? args.filePaths[0] : '');
      if (!p) return '';
      const name = String(p).split('/').pop() || p;
      const extra = Array.isArray(args.filePaths) && args.filePaths.length > 1
        ? t('chatStream.andNFiles', { n: args.filePaths.length })
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
    default:
      return '';
  }
}

/** 组合标签 + 上下文为一行摘要 */
function toolSummary(t: TFn, tool: string, args?: Record<string, any>): string {
  const label = toolLabel(t, tool);
  const ctx = toolContext(t, tool, args);
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
  t: TFn,
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
        const stepLine = t('chatStream.stepProgress', { step: evt.step, maxSteps: evt.maxSteps }) + phaseLabel + '...';
        const statusText = toolLogs.length > 0
          ? toolLogs.join('\n') + '\n\n' + stepLine
          : stepLine;
        updateContent(statusText);
        break;
      }
      case 'tool:start': {
        toolLogs.push(`🔧 ${toolSummary(t, evt.tool, evt.args)}...`);
        toolMeta.push({ tool: evt.tool, args: evt.args });
        updateContent(toolLogs.join('\n'));
        break;
      }
      case 'tool:end': {
        const lastIdx = toolLogs.length - 1;
        if (lastIdx >= 0) {
          const meta = toolMeta[lastIdx] || { tool: evt.tool };
          const summary = toolSummary(t, meta.tool, meta.args);
          if (evt.status === 'error' || evt.error) {
            toolLogs[lastIdx] = `❌ ${summary} ${t('chatStream.toolFailed')} (${evt.duration}ms)`;
          } else {
            const sizeStr = evt.resultSize > 1000
              ? `${(evt.resultSize / 1024).toFixed(1)}KB`
              : t('chatStream.toolResultChars', { size: evt.resultSize });
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
