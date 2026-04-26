import { describe, expect, it } from 'vitest';

import { ToolRequirementAnalyzer } from '../../lib/agent/forge/ToolRequirementAnalyzer.js';

/* ────────── Mock capability directory ────────── */

function createMockDirectory(names: string[]) {
  const nameSet = new Set(names);
  return {
    has: (name: string) => nameSet.has(name),
    list: () => names,
  };
}

describe('ToolRequirementAnalyzer', () => {
  describe('analyze — reuse mode', () => {
    it('should exact-match action_target name', () => {
      const directory = createMockDirectory(['read_file', 'search_knowledge', 'write_config']);
      const analyzer = new ToolRequirementAnalyzer(directory);

      const result = analyzer.analyze({
        intent: 'read the file',
        action: 'read',
        target: 'file',
      });

      expect(result.mode).toBe('reuse');
      expect(result.confidence).toBe(1.0);
      expect(result.matchedTool).toBe('read_file');
    });

    it('should fuzzy-match tool name containing action + target', () => {
      const directory = createMockDirectory(['alembic_search_knowledge', 'list_files']);
      const analyzer = new ToolRequirementAnalyzer(directory);

      const result = analyzer.analyze({
        intent: 'search knowledge base',
        action: 'search',
        target: 'knowledge',
      });

      expect(result.mode).toBe('reuse');
      expect(result.confidence).toBe(0.85);
      expect(result.matchedTool).toBe('alembic_search_knowledge');
    });

    it('should hint-match using ACTION_TOOL_HINTS', () => {
      const directory = createMockDirectory(['get_config', 'list_files']);
      const analyzer = new ToolRequirementAnalyzer(directory);

      // 'read' action has hints: ['read', 'get', 'fetch', 'load', 'file']
      const result = analyzer.analyze({
        intent: 'read the config',
        action: 'read',
        target: 'config',
      });

      expect(result.mode).toBe('reuse');
      expect(result.confidence).toBe(0.7);
      expect(result.matchedTool).toBe('get_config');
    });
  });

  describe('analyze — compose mode', () => {
    it('should suggest compose when multiple related tools found', () => {
      const directory = createMockDirectory([
        'read_data',
        'transform_data',
        'validate_schema',
        'export_csv',
      ]);
      const analyzer = new ToolRequirementAnalyzer(directory);

      const result = analyzer.analyze({
        intent: 'validate and transform data',
        action: 'validate',
        target: 'data',
      });

      expect(result.mode).toBe('compose');
      expect(result.confidence).toBe(0.65);
      expect(result.composableTools).toBeDefined();
      expect(result.composableTools?.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('analyze — generate mode', () => {
    it('should fallback to generate when nothing matches', () => {
      const directory = createMockDirectory(['read_file', 'search_knowledge']);
      const analyzer = new ToolRequirementAnalyzer(directory);

      const result = analyzer.analyze({
        intent: 'generate thumbnail',
        action: 'generate',
        target: 'thumbnail',
      });

      expect(result.mode).toBe('generate');
      expect(result.confidence).toBe(0.5);
      expect(result.reasoning).toContain('No existing tool');
    });
  });

  describe('analyze — priority order', () => {
    it('should prefer reuse over compose', () => {
      const directory = createMockDirectory(['search_file', 'find_pattern', 'search_results']);
      const analyzer = new ToolRequirementAnalyzer(directory);

      const result = analyzer.analyze({
        intent: 'search file',
        action: 'search',
        target: 'file',
      });

      // 精确匹配 search_file 应优先
      expect(result.mode).toBe('reuse');
      expect(result.matchedTool).toBe('search_file');
    });
  });
});
