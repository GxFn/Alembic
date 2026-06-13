import path from 'node:path';
import { PermissionDenied } from '@alembic/core/shared';
import Constitution from '../../lib/governance/constitution/Constitution.js';
import PermissionManager from '../../lib/governance/permission/PermissionManager.js';

const __dirname = import.meta.dirname;

describe('PermissionManager legacy compatibility module', () => {
  let permissionManager: PermissionManager;

  beforeAll(() => {
    const configPath = path.join(__dirname, '../../config/constitution.yaml');
    const constitution = new Constitution(configPath);
    permissionManager = new PermissionManager(constitution);
  });

  describe('check - no runtime roles in mainline policy', () => {
    test('denies source labels because the active policy defines no roles', () => {
      const result = permissionManager.check('http-request', 'create', '/candidates');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Unknown role');
    });

    test('denies external actor labels because role permissions are not mainline authority', () => {
      const result = permissionManager.check('external_agent', 'read', '/recipes');
      expect(result.allowed).toBe(false);
    });
  });

  describe('resource type extraction', () => {
    test('extracts resource type from path', () => {
      expect(permissionManager.getResourceType('/recipes/123')).toBe('recipes');
      expect(permissionManager.getResourceType('/candidates/456')).toBe('candidates');
    });

    test('extracts resource type from object', () => {
      const resource = { type: 'recipes', id: '123' };
      expect(permissionManager.getResourceType(resource)).toBe('recipes');
    });

    test('handles unknown resource', () => {
      expect(permissionManager.getResourceType('unknown')).toBe('unknown');
    });
  });

  describe('enforce', () => {
    test('throws PermissionDenied for any role-like actor under mainline policy', () => {
      expect(() => {
        permissionManager.enforce('http-request', 'create', '/recipes');
      }).toThrow(PermissionDenied);
    });
  });

  describe('role projections', () => {
    test('returns empty permissions and constraints for source labels', () => {
      expect(permissionManager.getRolePermissions('http-request')).toEqual([]);
      expect(permissionManager.getRoleConstraints('http-request')).toEqual([]);
    });
  });

  describe('checkMultiple', () => {
    test('checks multiple requests without creating implicit roles', () => {
      const checks = [
        { actor: 'http-request', action: 'create', resource: '/recipes' },
        { actor: 'external_agent', action: 'read', resource: '/recipes' },
      ];

      const results = permissionManager.checkMultiple(checks);
      expect(results).toHaveLength(2);
      expect(results.every((item) => item.result.allowed === false)).toBe(true);
    });
  });
});
