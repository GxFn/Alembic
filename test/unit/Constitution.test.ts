import path from 'node:path';
import Constitution from '../../lib/core/constitution/Constitution.js';

const __dirname = import.meta.dirname;

describe('Constitution', () => {
  let constitution;

  beforeAll(() => {
    const configPath = path.join(__dirname, '../../config/constitution.yaml');
    constitution = new Constitution(configPath);
  });

  describe('load config', () => {
    test('should load constitution from YAML file', () => {
      expect(constitution.config).toBeDefined();
      expect(constitution.config.version).toBe('3.0');
    });

    test('should have 4 rules', () => {
      const rules = constitution.getRules();
      expect(rules).toHaveLength(4);
      expect(rules[0].id).toBe('destructive_confirm');
    });

    test('should have 3 roles', () => {
      const roles = constitution.getAllRoles();
      expect(roles).toHaveLength(3);
      const roleIds = roles.map((r) => r.id);
      expect(roleIds).toContain('external_agent');
      expect(roleIds).toContain('developer');
    });
  });

  describe('get rule', () => {
    test('should return rules array', () => {
      const rules = constitution.getRules();
      expect(rules.length).toBeGreaterThan(0);
      expect(rules[0]).toHaveProperty('id');
      expect(rules[0]).toHaveProperty('check');
    });
  });

  describe('get role', () => {
    test('should return role by id', () => {
      const role = constitution.getRole('external_agent');
      expect(role).toBeDefined();
      expect(role.name).toBe('External Agent');
    });

    test('should return null for non-existent role', () => {
      const role = constitution.getRole('non_existent_role');
      expect(role).toBeUndefined();
    });
  });

  describe('get role permissions', () => {
    test('should return permissions for external_agent', () => {
      const permissions = constitution.getRolePermissions('external_agent');
      expect(Array.isArray(permissions)).toBe(true);
      expect(permissions.length).toBeGreaterThan(0);
      expect(permissions).toContain('create:candidates');
    });

    test('should return empty array for non-existent role', () => {
      const permissions = constitution.getRolePermissions('non_existent');
      expect(permissions).toEqual([]);
    });
  });

  describe('get role constraints', () => {
    test('should return constraints for external_agent', () => {
      const constraints = constitution.getRoleConstraints('external_agent');
      expect(Array.isArray(constraints)).toBe(true);
      expect(constraints.length).toBeGreaterThan(0);
    });
  });

  describe('has role', () => {
    test('should return true for existing role', () => {
      expect(constitution.hasRole('external_agent')).toBe(true);
    });

    test('should return false for non-existent role', () => {
      expect(constitution.hasRole('non_existent')).toBe(false);
    });
  });

  describe('toJSON', () => {
    test('should export summary in JSON format', () => {
      const json = constitution.toJSON();
      expect(json).toHaveProperty('version');
      expect(json).toHaveProperty('effectiveDate');
      expect(json).toHaveProperty('rules');
      expect(json).toHaveProperty('roles');
      expect(json.rules).toHaveLength(4);
      expect(json.roles).toHaveLength(3);
    });
  });

  describe('reload', () => {
    test('should reload constitution from file', () => {
      const originalVersion = constitution.config.version;
      constitution.reload();
      expect(constitution.config.version).toBe(originalVersion);
    });
  });
});
