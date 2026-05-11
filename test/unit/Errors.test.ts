import {
  BaseError,
  ConflictError,
  ConstitutionViolation,
  InternalError,
  NotFoundError,
  PermissionDenied,
  ValidationError,
} from '../../lib/shared/errors/BaseError.js';

describe('Error Classes', () => {
  describe('BaseError', () => {
    test('should create base error', () => {
      const error = new BaseError('Test error', 'TEST_CODE', 500);
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.statusCode).toBe(500);
    });

    test('should be instanceof Error', () => {
      const error = new BaseError('Test', 'TEST', 500);
      expect(error).toBeInstanceOf(Error);
    });

    test('should convert to JSON', () => {
      const error = new BaseError('Test error', 'TEST_CODE', 500);
      const json = error.toJSON();
      expect(json).toHaveProperty('message');
      expect(json).toHaveProperty('code');
      expect(json).toHaveProperty('statusCode');
    });
  });

  describe('PermissionDenied', () => {
    test('should create permission denied error', () => {
      const error = new PermissionDenied('Access denied');
      expect(error.statusCode).toBe(403);
      expect(error.code).toContain('PERMISSION_DENIED');
    });
  });

  describe('ConstitutionViolation', () => {
    test('should include violations array', () => {
      const violations = [
        { priority: 1, rule: 'Rule 1', reason: 'Reason 1' },
        { priority: 2, rule: 'Rule 2', reason: 'Reason 2' },
      ];
      const error = new ConstitutionViolation(violations);
      expect(error.violations).toEqual(violations);
      expect(error.statusCode).toBe(400);
    });
  });

  describe('ValidationError', () => {
    test('should include validation details', () => {
      const details = { field: 'email', error: 'Invalid format' };
      const error = new ValidationError('Validation failed', details);
      expect(error.details).toEqual(details);
    });
  });

  describe('NotFoundError', () => {
    test('should include resource info', () => {
      const error = new NotFoundError('Recipe not found', 'recipes/123');
      expect(error.resource).toBe('recipes/123');
      expect(error.statusCode).toBe(404);
    });
  });

  describe('ConflictError', () => {
    test('should create conflict error', () => {
      const error = new ConflictError('Resource already exists');
      expect(error.statusCode).toBe(409);
    });
  });

  describe('InternalError', () => {
    test('should create internal error', () => {
      const error = new InternalError('Something went wrong');
      expect(error.statusCode).toBe(500);
    });
  });
});
