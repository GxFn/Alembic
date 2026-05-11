/**
 * GuardCheckEngine — scope-based rule filtering
 * Ensures 'universal' dimension rules are NOT filtered out under any scope.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { GuardCheckEngine } from '../../lib/service/guard/GuardCheckEngine.js';

function createMinimalDB() {
  const db = new Database(':memory:');
  // Create minimal schema for GuardCheckEngine
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      language TEXT,
      scope TEXT,
      constraints TEXT,
      lifecycle TEXT DEFAULT 'active',
      kind TEXT DEFAULT 'rule',
      knowledgeType TEXT
    );
  `);
  return db;
}

describe('GuardCheckEngine scope filtering', () => {
  it('should include universal-dimension rules when scope=project', () => {
    const db = createMinimalDB();

    // Insert a rule with scope=universal (like BiliDili knowledge_entries)
    db.prepare(`
      INSERT INTO knowledge_entries (id, title, description, language, scope, constraints, lifecycle, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-universal-rule',
      'No force unwrap',
      'Avoid force unwrap in Swift',
      'swift',
      'universal',
      JSON.stringify({
        guards: [
          {
            id: 'test-universal-rule',
            pattern: '\\w+!\\.',
            severity: 'error',
            message: 'Avoid force unwrap',
          },
        ],
      }),
      'active',
      'rule'
    );

    const engine = new GuardCheckEngine(db as any);

    // Swift code with a force unwrap violation
    const code = 'let x = foo!.bar';

    // scope=project should still find the rule (universal is allowed)
    const resultWithScope = engine.auditFile('test.swift', code, { scope: 'project' });

    // No scope should also find the rule
    const resultNoScope = engine.auditFile('test.swift', code, {});

    expect(resultNoScope.violations.length).toBeGreaterThan(0);
    expect(resultWithScope.violations.length).toBeGreaterThan(0);
    expect(resultWithScope.violations.length).toBe(resultNoScope.violations.length);

    db.close();
  });

  it('should include universal-dimension rules when scope=file', () => {
    const db = createMinimalDB();

    db.prepare(`
      INSERT INTO knowledge_entries (id, title, description, language, scope, constraints, lifecycle, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-universal-rule-2',
      'No print',
      'Avoid print() in Swift',
      'swift',
      'universal',
      JSON.stringify({
        guards: [
          {
            id: 'test-universal-rule-2',
            pattern: '\\bprint\\s*\\(',
            severity: 'warning',
            message: 'Use Logger instead of print()',
          },
        ],
      }),
      'active',
      'rule'
    );

    const engine = new GuardCheckEngine(db as any);
    const code = 'print("hello")';

    const result = engine.auditFile('test.swift', code, { scope: 'file' });
    expect(result.violations.some((v) => v.ruleId === 'test-universal-rule-2')).toBe(true);

    db.close();
  });

  it('should still filter non-matching dimensions under scope', () => {
    const db = createMinimalDB();

    // Insert a 'project'-dimension rule
    db.prepare(`
      INSERT INTO knowledge_entries (id, title, description, language, scope, constraints, lifecycle, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-project-rule',
      'Project-only check',
      'Only in project scope',
      'swift',
      'project',
      JSON.stringify({
        guards: [
          {
            id: 'test-project-rule',
            pattern: '\\bTODO\\b',
            severity: 'info',
            message: 'TODO found',
          },
        ],
      }),
      'active',
      'rule'
    );

    const engine = new GuardCheckEngine(db as any);
    const code = '// TODO: fix this';

    // scope=file should NOT include project-dimension rules
    const resultFile = engine.auditFile('test.swift', code, { scope: 'file' });
    const projectRuleFound = resultFile.violations.some((v) => v.ruleId === 'test-project-rule');
    expect(projectRuleFound).toBe(false);

    // scope=project SHOULD include project-dimension rules
    const resultProject = engine.auditFile('test.swift', code, { scope: 'project' });
    const projectRuleFoundInProject = resultProject.violations.some(
      (v) => v.ruleId === 'test-project-rule'
    );
    expect(projectRuleFoundInProject).toBe(true);

    db.close();
  });
});
