#!/usr/bin/env npx tsx
/**
 * analyze-signals.ts — JSONL Signal Analyzer
 *
 * Reads intent chain records from .asd/logs/signals/*.jsonl and produces
 * summary analytics for evaluating the Intent Pipeline effectiveness.
 *
 * Usage: npx tsx scripts/analyze-signals.ts [project-root]
 *
 * Metrics:
 *   1. Recipe coverage rate
 *   2. Scenario distribution
 *   3. Multi-query benefit (filtered count)
 *   4. Language distribution
 *   5. Drift → violation correlation
 *   6. Task completion rate
 *   7. Average intent duration
 *   8. Search → drift correlation
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ───────────────────────────────────────────

interface IntentChainRecord {
  sessionId: string;
  taskId?: string;
  outcome: 'completed' | 'failed' | 'abandoned';
  primeQuery: string;
  primeActiveFile?: string;
  primeRecipeIds: string[];
  primeAt: number;
  primeLanguage: string | null;
  primeModule: string | null;
  primeScenario: string;
  searchMeta?: {
    queries: string[];
    resultCount: number;
    filteredCount: number;
  };
  toolCalls: Array<{ tool: string; timestamp: number; args_summary: string }>;
  searchQueries: string[];
  mentionedFiles: string[];
  decisions: Array<{ id: string; title: string }>;
  driftEvents: Array<{ type: string; primeOverlap: number }>;
  driftScore: number;
  closeReason?: string;
  failReason?: string;
  guardViolations?: number;
  startedAt: number;
  endedAt: number;
  duration: number;
}

// ── Load Records ────────────────────────────────────

function loadRecords(signalDir: string): IntentChainRecord[] {
  if (!fs.existsSync(signalDir)) {
    console.error(`Signal directory not found: ${signalDir}`);
    return [];
  }

  const files = fs
    .readdirSync(signalDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();

  const records: IntentChainRecord[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(signalDir, file), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(JSON.parse(line) as IntentChainRecord);
      } catch {
        // skip malformed lines
      }
    }
  }
  return records;
}

// ── Analyze ─────────────────────────────────────────

function analyze(records: IntentChainRecord[]) {
  if (records.length === 0) {
    console.log('No records found.');
    return;
  }

  console.log(`\n📊 Intent Signal Analysis — ${records.length} records\n`);

  // 1. Recipe coverage rate
  const withRecipes = records.filter((r) => r.primeRecipeIds.length > 0).length;
  console.log(
    `1. Recipe coverage: ${withRecipes}/${records.length} (${pct(withRecipes, records.length)})`
  );

  // 2. Scenario distribution
  const scenarios = groupBy(records, (r) => r.primeScenario || 'unknown');
  console.log('2. Scenario distribution:');
  for (const [scenario, items] of Object.entries(scenarios)) {
    console.log(`   ${scenario}: ${items.length} (${pct(items.length, records.length)})`);
  }

  // 3. Multi-query benefit
  const withMeta = records.filter((r) => r.searchMeta);
  if (withMeta.length > 0) {
    const avgFiltered = avg(withMeta.map((r) => r.searchMeta!.filteredCount));
    const avgResult = avg(withMeta.map((r) => r.searchMeta!.resultCount));
    const avgQueries = avg(withMeta.map((r) => r.searchMeta!.queries.length));
    console.log(
      `3. Multi-query: avg ${avgQueries.toFixed(1)} queries → ${avgResult.toFixed(1)} results → ${avgFiltered.toFixed(1)} filtered`
    );
  } else {
    console.log('3. Multi-query: no searchMeta data');
  }

  // 4. Language distribution
  const languages = groupBy(records, (r) => r.primeLanguage || 'unknown');
  console.log('4. Language distribution:');
  for (const [lang, items] of Object.entries(languages)) {
    console.log(`   ${lang}: ${items.length}`);
  }

  // 5. Drift → violation correlation
  const withDrift = records.filter((r) => r.driftScore > 0);
  const withViolations = records.filter((r) => (r.guardViolations ?? 0) > 0);
  console.log(
    `5. Drift: ${withDrift.length} records with drift, ${withViolations.length} with violations`
  );
  if (withDrift.length > 0) {
    const avgDriftScore = avg(withDrift.map((r) => r.driftScore));
    console.log(`   avg drift score: ${avgDriftScore.toFixed(3)}`);
  }

  // 6. Task completion rate
  const withTask = records.filter((r) => r.taskId);
  const completed = records.filter((r) => r.outcome === 'completed');
  const failed = records.filter((r) => r.outcome === 'failed');
  const abandoned = records.filter((r) => r.outcome === 'abandoned');
  console.log(
    `6. Outcomes: ${completed.length} completed, ${failed.length} failed, ${abandoned.length} abandoned`
  );
  if (withTask.length > 0) {
    console.log(
      `   Task completion: ${completed.length}/${withTask.length} (${pct(completed.length, withTask.length)})`
    );
  }

  // 7. Average intent duration
  const durations = records.filter((r) => r.duration > 0).map((r) => r.duration);
  if (durations.length > 0) {
    const avgDur = avg(durations);
    const medDur = median(durations);
    console.log(`7. Duration: avg ${formatMs(avgDur)}, median ${formatMs(medDur)}`);
  }

  // 8. High-drift intents
  const highDrift = records.filter((r) => r.driftScore > 0.5);
  const highDriftWithManySearches = highDrift.filter((r) => r.searchQueries.length > 2);
  console.log(
    `8. High-drift (>0.5): ${highDrift.length}, of which ${highDriftWithManySearches.length} had >2 search queries`
  );

  console.log('');
}

// ── Helpers ─────────────────────────────────────────

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    (groups[k] ??= []).push(item);
  }
  return groups;
}

function avg(nums: number[]): number {
  if (nums.length === 0) {
    return 0;
  }
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums: number[]): number {
  if (nums.length === 0) {
    return 0;
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function pct(n: number, total: number): string {
  if (total === 0) {
    return '0%';
  }
  return `${Math.round((n / total) * 100)}%`;
}

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 60000).toFixed(1)}min`;
}

// ── Main ────────────────────────────────────────────

const projectRoot = process.argv[2] || process.env.ASD_PROJECT_DIR || process.cwd();
const signalDir = path.join(projectRoot, '.asd', 'logs', 'signals');

console.log(`Reading signals from: ${signalDir}`);
const records = loadRecords(signalDir);
analyze(records);
