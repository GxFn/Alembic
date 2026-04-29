import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowReport } from '#workflows/capabilities/persistence/reports/WorkflowReportTypes.js';

export function getReportSessionId(report: WorkflowReport) {
  const session = report.session as { id?: unknown } | undefined;
  return typeof session?.id === 'string' && session.id ? session.id : null;
}

export function buildWorkflowReportSummary(report: WorkflowReport) {
  const terminal = report.terminal as { enabled?: boolean; successRate?: number } | undefined;
  const totals = report.totals || {};
  const duration = report.duration || {};
  const session = report.session as Record<string, unknown> | undefined;
  return {
    sessionId: getReportSessionId(report),
    timestamp: report.timestamp,
    project: report.project,
    mode: session?.mode || null,
    terminalToolset: session?.terminalToolset || 'baseline',
    durationMs: duration.totalMs || 0,
    candidates: totals.candidates || 0,
    toolCalls: totals.toolCalls || 0,
    terminalEnabled: terminal?.enabled === true,
    terminalSuccessRate: terminal?.successRate || 0,
  };
}

export async function writeWorkflowReportHistoryWithWriteZone(
  writeZone: import('#infra/io/WriteZone.js').WriteZone,
  report: WorkflowReport
) {
  const sessionId = getReportSessionId(report);
  if (!sessionId) {
    return;
  }
  await writeZone.writeFileAsync(
    writeZone.runtime(path.join('bootstrap-reports', `${sessionId}.json`)),
    JSON.stringify(report, null, 2)
  );
  const indexPath = writeZone.runtime(path.join('bootstrap-reports', 'index.json'));
  const existing = await readJsonFile<{ reports?: Array<Record<string, unknown>> }>(
    indexPath.absolute
  );
  const reports = sanitizeReportSummaries(existing?.reports || []).filter(
    (entry) => entry.sessionId !== sessionId
  );
  reports.unshift(buildWorkflowReportSummary(report));
  await writeZone.writeFileAsync(
    indexPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), reports: reports.slice(0, 100) }, null, 2)
  );
}

export async function writeWorkflowReportHistory(reportDir: string, report: WorkflowReport) {
  const sessionId = getReportSessionId(report);
  if (!sessionId) {
    return;
  }
  const historyDir = path.join(reportDir, 'bootstrap-reports');
  await fs.mkdir(historyDir, { recursive: true });
  await fs.writeFile(path.join(historyDir, `${sessionId}.json`), JSON.stringify(report, null, 2));

  const indexPath = path.join(historyDir, 'index.json');
  const existing = await readJsonFile<{ reports?: Array<Record<string, unknown>> }>(indexPath);
  const reports = sanitizeReportSummaries(existing?.reports || []).filter(
    (entry) => entry.sessionId !== sessionId
  );
  reports.unshift(buildWorkflowReportSummary(report));
  await fs.writeFile(
    indexPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), reports: reports.slice(0, 100) }, null, 2)
  );
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function sanitizeReportSummaries(reports: Array<Record<string, unknown>>) {
  return reports.filter(
    (entry) => typeof entry.sessionId === 'string' && entry.sessionId.trim().length > 0
  );
}
