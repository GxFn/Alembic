import type { ScanTask } from '../../prompts/scan-prompts.js';
import { SCAN_TASK_CONFIGS } from '../../prompts/scan-prompts.js';
import type { FileCacheEntry } from '../../runtime/AgentRuntimeTypes.js';
import type { AgentRunInput, AgentRunSource } from '../../service/AgentRunContracts.js';
import type { AgentService } from '../../service/AgentService.js';
import type { SystemRunContextFactory } from '../../service/SystemRunContextFactory.js';
import { projectScanRunResult, type ScanKnowledgeProjection } from './ScanRunProjection.js';

interface ScanTaskConfig {
  fallback: (label: string) => Record<string, unknown>;
}

export interface ScanAgentFileInput {
  name?: string;
  relativePath?: string;
  content?: string;
  language?: string;
}

export interface RunScanAgentTaskOptions {
  agentService: AgentService;
  systemRunContextFactory: SystemRunContextFactory;
  label?: string;
  files?: ScanAgentFileInput[] | null;
  task?: ScanTask;
  lang?: string | null;
  comprehensive?: boolean;
  source?: AgentRunSource;
  onParseError?: (err: unknown) => void;
}

export async function runScanAgentTask({
  agentService,
  systemRunContextFactory,
  label,
  files,
  task = 'extract',
  lang,
  comprehensive = false,
  source = 'system-workflow',
  onParseError,
}: RunScanAgentTaskOptions): Promise<ScanKnowledgeProjection> {
  const taskConfig = (SCAN_TASK_CONFIGS as Record<string, ScanTaskConfig>)[task];
  if (!taskConfig) {
    throw new Error(
      `Unknown scan task: "${task}". Available: ${Object.keys(SCAN_TASK_CONFIGS).join(', ')}`
    );
  }

  const runLabel = label || 'code';
  const fileCache = toScanFileCache(files);
  const analyzeMaxIter = task === 'summarize' ? 12 : task === 'deep-scan' ? 36 : 24;
  const systemCtx = systemRunContextFactory.createSystemContext({
    budget: { maxIterations: analyzeMaxIter },
    trackerStrategy: 'analyst',
    label: `${task}:${runLabel}`,
    lang: lang || undefined,
  });

  const runResult = await agentService.run({
    profile: { id: profileIdForTask(task) },
    params: { task, label: runLabel, comprehensive, files: fileCache },
    message: {
      role: 'internal',
      content: `分析 "${runLabel}" 的 ${fileCache?.length || 0} 个源文件。${comprehensive ? '请进行深度分析。' : ''}`,
      metadata: { label: runLabel, task },
    },
    context: {
      source,
      runtimeSource: 'system',
      lang: lang || null,
      fileCache,
      systemRunContext: systemCtx.systemRunContext as AgentRunInput['context']['systemRunContext'],
      strategyContext: systemCtx,
      promptContext: { dimensionScopeId: systemCtx.scopeId as string },
    },
    presentation: { responseShape: 'system-task-result' },
  });

  return projectScanRunResult({
    label: runLabel,
    task,
    result: runResult,
    fallback: taskConfig.fallback,
    onParseError,
  });
}

function profileIdForTask(task: ScanTask): string {
  if (task === 'summarize') {
    return 'scan-summarize';
  }
  if (task === 'deep-scan') {
    return 'deep-scan';
  }
  return 'scan-extract';
}

export function toScanFileCache(files?: ScanAgentFileInput[] | null): FileCacheEntry[] | null {
  if (!files?.length) {
    return null;
  }
  return files.map((file, index) => {
    const name = file.name || file.relativePath || `file-${index + 1}`;
    return {
      relativePath: file.relativePath || name,
      name,
      content: file.content || '',
    };
  });
}
