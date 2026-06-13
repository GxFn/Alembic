import path from 'node:path';
import Constitution from '../../lib/governance/constitution/Constitution.js';

const __dirname = import.meta.dirname;

describe('Constitution compatibility policy loader', () => {
  let constitution: Constitution;

  beforeAll(() => {
    const configPath = path.join(__dirname, '../../config/constitution.yaml');
    constitution = new Constitution(configPath);
  });

  describe('load config', () => {
    test('loads entrypoint safety policy from YAML file', () => {
      expect(constitution.config).toBeDefined();
      expect(constitution.config.version).toBe('4.0');
    });

    test('has operation-safety rules but no runtime roles', () => {
      const rules = constitution.getRules();
      expect(rules).toHaveLength(4);
      expect(rules[0].id).toBe('destructive_confirm');
      expect(constitution.getAllRoles()).toEqual([]);
      expect(constitution.getCapabilities()).toEqual({});
    });
  });

  describe('get rule', () => {
    test('returns rules array', () => {
      const rules = constitution.getRules();
      expect(rules.length).toBeGreaterThan(0);
      expect(rules[0]).toHaveProperty('id');
      expect(rules[0]).toHaveProperty('check');
    });
  });

  describe('roles are absent in mainline policy', () => {
    test('returns undefined for role lookup', () => {
      expect(constitution.getRole('external_agent')).toBeUndefined();
    });

    test('returns empty permissions for any role id', () => {
      expect(constitution.getRolePermissions('external_agent')).toEqual([]);
    });

    test('returns empty constraints for any role id', () => {
      expect(constitution.getRoleConstraints('external_agent')).toEqual([]);
    });

    test('hasRole is false for runtime actor labels', () => {
      expect(constitution.hasRole('external_agent')).toBe(false);
      expect(constitution.hasRole('http-request')).toBe(false);
    });
  });

  describe('toJSON', () => {
    test('exports summary without roles', () => {
      const json = constitution.toJSON();
      expect(json).toHaveProperty('version');
      expect(json).toHaveProperty('effectiveDate');
      expect(json).toHaveProperty('rules');
      expect(json).toHaveProperty('roles');
      expect(json.rules).toHaveLength(4);
      expect(json.roles).toHaveLength(0);
    });
  });

  describe('reload', () => {
    test('reloads policy from file', () => {
      const originalVersion = constitution.config.version;
      constitution.reload();
      expect(constitution.config.version).toBe(originalVersion);
    });
  });
});
