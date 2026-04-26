import type { AgentService } from '../../service/AgentService.js';

export interface TranslationJsonResult {
  summaryEn: string;
  usageGuideEn: string;
  error?: string;
}

export async function runTranslationJson({
  agentService,
  summary,
  usageGuide,
  onParseError,
}: {
  agentService: AgentService;
  summary?: string | null;
  usageGuide?: string | null;
  onParseError?: (err: unknown) => void;
}): Promise<TranslationJsonResult> {
  if (!summary && !usageGuide) {
    return { summaryEn: '', usageGuideEn: '' };
  }

  const result = await agentService.run({
    profile: { id: 'translation-json' },
    params: { summary: summary || '', usageGuide: usageGuide || '' },
    message: {
      role: 'internal',
      content: `翻译以下内容为英文，输出纯 JSON：\nsummary: ${summary || '(空)'}\nusageGuide: ${usageGuide || '(空)'}`,
      metadata: { task: 'translation-json' },
    },
    context: {
      source: 'system-workflow',
      runtimeSource: 'system',
      lang: 'en',
    },
    presentation: { responseShape: 'system-task-result' },
  });

  if (result.status !== 'success') {
    return {
      summaryEn: summary || '',
      usageGuideEn: usageGuide || '',
      error: result.reply || `Translation failed with status: ${result.status}`,
    };
  }

  return parseTranslationJson(
    result.reply,
    {
      summaryEn: summary || '',
      usageGuideEn: usageGuide || '',
    },
    onParseError
  );
}

function parseTranslationJson(
  text: string | null | undefined,
  fallback: TranslationJsonResult,
  onParseError?: (err: unknown) => void
): TranslationJsonResult {
  if (!text) {
    return fallback;
  }
  try {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return normalizeTranslation(JSON.parse(codeBlockMatch[1].trim()), fallback);
    }
    const objMatch = text.match(/(\{[\s\S]*\})/);
    if (objMatch) {
      return normalizeTranslation(JSON.parse(objMatch[1].trim()), fallback);
    }
    return normalizeTranslation(JSON.parse(text.trim()), fallback);
  } catch (err: unknown) {
    onParseError?.(err);
    return fallback;
  }
}

function normalizeTranslation(
  value: unknown,
  fallback: TranslationJsonResult
): TranslationJsonResult {
  if (!value || typeof value !== 'object') {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  return {
    summaryEn: typeof record.summaryEn === 'string' ? record.summaryEn : fallback.summaryEn,
    usageGuideEn:
      typeof record.usageGuideEn === 'string' ? record.usageGuideEn : fallback.usageGuideEn,
  };
}
