/**
 * UncertaintyCollector 单元测试
 */
import { describe, expect, it } from 'vitest';
import { UncertaintyCollector } from '../../lib/service/guard/UncertaintyCollector.js';

describe('UncertaintyCollector', () => {
  it('should start with empty state', () => {
    const collector = new UncertaintyCollector();
    expect(collector.uncertainCount).toBe(0);
    expect(collector.skippedCount).toBe(0);
    const report = collector.buildReport();
    expect(report.checkCoverage).toBe(100);
    expect(report.uncertainResults).toHaveLength(0);
    expect(report.skippedChecks).toHaveLength(0);
    expect(report.boundaries).toHaveLength(0);
  });

  it('should record skipped checks', () => {
    const collector = new UncertaintyCollector();
    collector.recordSkip('regex', 'invalid_regex', 'Pattern failed', { ruleId: 'r1' });
    collector.recordSkip('ast', 'ast_unavailable', 'Tree-sitter down', { ruleId: 'r2' });

    expect(collector.skippedCount).toBe(2);
    const report = collector.buildReport();
    expect(report.skippedChecks).toHaveLength(2);
    expect(report.skippedChecks[0].layer).toBe('regex');
    expect(report.skippedChecks[1].layer).toBe('ast');
  });

  it('should record uncertain results', () => {
    const collector = new UncertaintyCollector();
    collector.addUncertain('rule-1', 'Test message', 'ast', 'ast_unavailable', 'No tree-sitter');
    collector.addUncertain('rule-2', 'Another msg', 'regex', 'invalid_regex', 'Bad pattern');

    expect(collector.uncertainCount).toBe(2);
    const report = collector.buildReport();
    expect(report.uncertainResults).toHaveLength(2);
    expect(report.uncertainResults[0].ruleId).toBe('rule-1');
  });

  it('should calculate check coverage correctly', () => {
    const collector = new UncertaintyCollector();
    collector.recordLayerStats('regex', 10, 8);
    collector.recordLayerStats('ast', 5, 0);
    collector.recordLayerStats('code_level', 3, 3);

    const report = collector.buildReport();
    // 11 executed out of 18 total = ~61%
    expect(report.checkCoverage).toBe(61);
    expect(report.executedChecks.regex.total).toBe(10);
    expect(report.executedChecks.regex.executed).toBe(8);
    expect(report.executedChecks.ast.total).toBe(5);
    expect(report.executedChecks.ast.executed).toBe(0);
  });

  it('should detect boundaries from skipped checks', () => {
    const collector = new UncertaintyCollector();
    collector.recordSkip('ast', 'ast_unavailable', 'No TS for swift', { ruleId: 'r1' });
    collector.recordSkip('ast', 'ast_unavailable', 'No TS for swift', { ruleId: 'r2' });

    const report = collector.buildReport();
    expect(report.boundaries).toHaveLength(1);
    expect(report.boundaries[0].type).toBe('ast_language_gap');
    expect(report.boundaries[0].affectedRules).toContain('r1');
    expect(report.boundaries[0].affectedRules).toContain('r2');
  });

  it('should detect cross_file_incomplete boundary', () => {
    const collector = new UncertaintyCollector();
    collector.recordSkip('cross_file', 'file_missing', 'Related file not found');

    const report = collector.buildReport();
    expect(report.boundaries).toHaveLength(1);
    expect(report.boundaries[0].type).toBe('cross_file_incomplete');
  });

  it('should detect invalid_regex boundary', () => {
    const collector = new UncertaintyCollector();
    collector.recordSkip('regex', 'invalid_regex', 'Bad regex', { ruleId: 'r1' });

    const report = collector.buildReport();
    expect(report.boundaries).toHaveLength(1);
    expect(report.boundaries[0].type).toBe('rule_regex_invalid');
  });

  it('should infer correct impact levels', () => {
    const collector = new UncertaintyCollector();
    collector.recordSkip('ast', 'ast_unavailable', 'No TS');
    collector.recordSkip('cross_file', 'file_missing', 'Missing');
    collector.recordSkip('regex', 'invalid_regex', 'Bad');
    collector.recordSkip('regex', 'lang_unsupported', 'Unknown lang');

    const report = collector.buildReport();
    expect(report.skippedChecks[0].impact).toBe('high'); // ast+unavailable
    expect(report.skippedChecks[1].impact).toBe('medium'); // cross_file+missing
    expect(report.skippedChecks[2].impact).toBe('medium'); // regex+invalid
    expect(report.skippedChecks[3].impact).toBe('low'); // regex+lang_unsupported
  });

  it('should reset state correctly', () => {
    const collector = new UncertaintyCollector();
    collector.recordSkip('ast', 'ast_unavailable', 'Skipped');
    collector.addUncertain('r1', 'msg', 'ast', 'ast_unavailable', 'detail');
    collector.recordLayerStats('ast', 5, 0);

    expect(collector.skippedCount).toBe(1);
    expect(collector.uncertainCount).toBe(1);

    collector.reset();
    expect(collector.skippedCount).toBe(0);
    expect(collector.uncertainCount).toBe(0);

    const report = collector.buildReport();
    expect(report.checkCoverage).toBe(100);
  });

  it('should handle layer_conflict boundary', () => {
    const collector = new UncertaintyCollector();
    collector.recordSkip('regex', 'layer_conflict', 'L1 vs L3 conflict', { ruleId: 'r1' });

    const report = collector.buildReport();
    expect(report.skippedChecks[0].impact).toBe('high');
    expect(report.boundaries).toHaveLength(1);
    expect(report.boundaries[0].type).toBe('scope_unchecked');
  });
});
