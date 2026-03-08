import path from 'node:path';
import Constitution from '../../lib/core/constitution/Constitution.js';
import PermissionManager from '../../lib/core/permission/PermissionManager.js';
import { PermissionDenied } from '../../lib/shared/errors/BaseError.js';

const __dirname = import.meta.dirname;

describe('PermissionManager', () => {
  let constitution;
  let permissionManager;

  beforeAll(() => {
    const configPath = path.join(__dirname, '../../config/constitution.yaml');
    constitution = new Constitution(configPath);
    permissionManager = new PermissionManager(constitution);
  });

  describe('check - 3-tuple: (actor, action, resource)', () => {
    test('developer should have all permissions', () => {
      const result = permissionManager.check('developer', 'create', '/candidates');
      expect(result.allowed).toBe(true);
    });

    test('external_agent should be able to read recipes', () => {
      const result = permissionManager.check('external_agent', 'read', '/recipes');
      expect(result.allowed).toBe(true);
    });

    test('external_agent should be able to create candidates', () => {
      const result = permissionManager.check('external_agent', 'create', '/candidates');
      expect(result.allowed).toBe(true);
    });

    test('external_agent should NOT be able to create recipes', () => {
      const result = permissionManager.check('external_agent', 'create', '/recipes');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Missing permission');
    });

    test('external_agent should NOT be able to update recipes', () => {
      const result = permissionManager.check('external_agent', 'update', '/recipes');
      expect(result.allowed).toBe(false);
    });

    test('external_agent should NOT be able to delete', () => {
      const result = permissionManager.check('external_agent', 'delete', '/candidates');
      expect(result.allowed).toBe(false);
    });

    test('unknown role should be denied', () => {
      const result = permissionManager.check('unknown_role', 'read', '/recipes');
      expect(result.allowed).toBe(false);
    });

    test('unknown role (guard_engine removed) should be denied', () => {
      const result = permissionManager.check('guard_engine', 'read', '/candidates');
      expect(result.allowed).toBe(false);
    });
  });

  describe('resource type extraction', () => {
    test('should extract resource type from path', () => {
      expect(permissionManager.getResourceType('/recipes/123')).toBe('recipes');
      expect(permissionManager.getResourceType('/candidates/456')).toBe('candidates');
    });

    test('should extract resource type from object', () => {
      const resource = { type: 'recipes', id: '123' };
      expect(permissionManager.getResourceType(resource)).toBe('recipes');
    });

    test('should handle unknown resource', () => {
      expect(permissionManager.getResourceType('unknown')).toBe('unknown');
    });
  });

  describe('enforce', () => {
    test('should return true for allowed permission', () => {
      const result = permissionManager.enforce('developer', 'create', '/recipes');
      expect(result).toBe(true);
    });

    test('should throw PermissionDenied error for denied permission', () => {
      expect(() => {
        permissionManager.enforce('external_agent', 'create', '/recipes');
      }).toThrow(PermissionDenied);
    });

    test('should include detailed error message', () => {
      try {
        permissionManager.enforce('external_agent', 'delete', '/candidates');
      } catch (error) {
        expect(error.message).toContain('Permission denied');
        expect(error.statusCode).toBe(403);
      }
    });
  });

  describe('getRolePermissions', () => {
    test('should return permissions for external_agent', () => {
      const permissions = permissionManager.getRolePermissions('external_agent');
      expect(Array.isArray(permissions)).toBe(true);
      expect(permissions.length).toBeGreaterThan(0);
    });

    test('should return empty array for unknown role', () => {
      const permissions = permissionManager.getRolePermissions('unknown_role');
      expect(permissions).toEqual([]);
    });
  });

  describe('getRoleConstraints', () => {
    test('should return constraints for external_agent', () => {
      const constraints = permissionManager.getRoleConstraints('external_agent');
      expect(Array.isArray(constraints)).toBe(true);
    });
  });

  describe('checkMultiple', () => {
    test('should check multiple permissions at once', () => {
      const checks = [
        { actor: 'developer', action: 'create', resource: '/recipes' },
        { actor: 'external_agent', action: 'read', resource: '/recipes' },
        { actor: 'external_agent', action: 'create', resource: '/recipes' },
      ];

      const results = permissionManager.checkMultiple(checks);
      expect(results).toHaveLength(3);
      expect(results[0].result.allowed).toBe(true);
      expect(results[1].result.allowed).toBe(true);
      expect(results[2].result.allowed).toBe(false);
    });
  });

  describe('wildcard matching', () => {
    test('developer should match wildcard permission', () => {
      const result = permissionManager.check('developer', 'any_action', '/any_resource');
      expect(result.allowed).toBe(true);
    });

    test('should match action:* pattern', () => {
      // 如果权限包含 action:*
      const adminPerms = permissionManager.getRolePermissions('developer');
      expect(adminPerms).toContain('*');
    });
  });
});
