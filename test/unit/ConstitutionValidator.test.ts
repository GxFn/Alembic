import path from 'node:path';
import Constitution from '../../lib/core/constitution/Constitution.js';
import ConstitutionValidator from '../../lib/core/constitution/ConstitutionValidator.js';

const __dirname = import.meta.dirname;

describe('ConstitutionValidator', () => {
  let constitution;
  let validator;

  beforeAll(() => {
    const configPath = path.join(__dirname, '../../config/constitution.yaml');
    constitution = new Constitution(configPath);
    validator = new ConstitutionValidator(constitution);
  });

  describe('validate - destructive_confirm rule', () => {
    test('should require confirmation for delete operations', async () => {
      const request = {
        actor: 'developer',
        action: 'delete',
        resource: '/candidates/123',
        data: {},
      };

      const result = await validator.validate(request);
      expect(result.violations.some((v) => v.rule === 'destructive_confirm')).toBe(true);
    });

    test('should allow delete with confirmation', async () => {
      const request = {
        actor: 'developer',
        action: 'delete',
        resource: '/candidates/123',
        data: { confirmed: true },
      };

      const result = await validator.validate(request);
      expect(result.violations.some((v) => v.rule === 'destructive_confirm')).toBe(false);
    });
  });

  describe('validate - content_required rule', () => {
    test('should detect missing code in candidate creation', async () => {
      const request = {
        actor: 'external_agent',
        action: 'create',
        resource: '/candidates',
        data: { name: 'Test' }, // 缺少 code
      };

      const result = await validator.validate(request);
      expect(result.compliant).toBe(false);
      expect(result.violations.some((v) => v.rule === 'content_required')).toBe(true);
    });

    test('should allow candidate creation with code', async () => {
      const request = {
        actor: 'external_agent',
        action: 'create',
        resource: '/candidates',
        data: {
          name: 'Test',
          code: 'function test() {}',
        },
      };

      const result = await validator.validate(request);
      expect(result.violations.some((v) => v.rule === 'content_required')).toBe(false);
    });
  });

  describe('validate - ai_no_direct_recipe rule', () => {
    test('should prevent AI from creating recipes', async () => {
      const request = {
        actor: 'external_agent', // AI actor
        action: 'create',
        resource: '/recipes',
        data: { name: 'Test Recipe', code: 'xxx' },
      };

      const result = await validator.validate(request);
      expect(result.violations.some((v) => v.rule === 'ai_no_direct_recipe')).toBe(true);
    });

    test('should allow developer to create recipes', async () => {
      const request = {
        actor: 'developer',
        action: 'create',
        resource: '/recipes',
        data: { name: 'Test Recipe', code: 'xxx' },
      };

      const result = await validator.validate(request);
      expect(result.violations.some((v) => v.rule === 'ai_no_direct_recipe')).toBe(false);
    });
  });

  describe('validate - batch_authorized rule', () => {
    test('should require authorization for batch operations', async () => {
      const request = {
        actor: 'developer',
        action: 'batch_update',
        resource: '/candidates',
        data: {},
      };

      const result = await validator.validate(request);
      expect(result.violations.some((v) => v.rule === 'batch_authorized')).toBe(true);
    });

    test('should allow batch operations with authorization', async () => {
      const request = {
        actor: 'developer',
        action: 'batch_update',
        resource: '/candidates',
        data: { authorized: true },
      };

      const result = await validator.validate(request);
      expect(result.violations.some((v) => v.rule === 'batch_authorized')).toBe(false);
    });
  });

  describe('enforce', () => {
    test('should throw error on non-compliant request', async () => {
      const request = {
        actor: 'external_agent',
        action: 'create',
        resource: '/candidates',
        data: { name: 'Test' },
      };

      await expect(validator.enforce(request)).rejects.toThrow();
    });

    test('should return result on compliant request', async () => {
      const request = {
        actor: 'developer',
        action: 'read',
        resource: '/recipes',
        data: {},
      };

      const result = await validator.enforce(request);
      expect(result.compliant).toBe(true);
    });
  });
});
