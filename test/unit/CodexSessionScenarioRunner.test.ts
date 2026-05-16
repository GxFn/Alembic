import { describe, expect, test } from 'vitest';
import {
  loadCodexSessionScenarios,
  runCodexSessionScenario,
} from '../support/codex-session/index.js';

const scenarios = loadCodexSessionScenarios({
  filter: process.env.CODEX_SESSION_SCENARIO_FILTER,
});
const scenarioTimeoutMs = Number(process.env.CODEX_SESSION_TEST_TIMEOUT_MS || 20_000);

describe('Codex session scenario runner', () => {
  test('loads at least one scenario', () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of scenarios) {
    test(scenario.id, async () => {
      const result = await runCodexSessionScenario(scenario);
      expect(
        result.errors,
        `summary: ${result.summaryPath}\ntranscript: ${result.transcriptPath}`
      ).toEqual([]);
    }, scenarioTimeoutMs);
  }
});
