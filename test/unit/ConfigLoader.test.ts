import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ConfigLoader from '../../lib/infrastructure/config/ConfigLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('ConfigLoader', () => {
  beforeAll(() => {
    // 清空静态实例
    ConfigLoader.config = null;
  });

  test('should load configuration', () => {
    ConfigLoader.load('development');
    expect(ConfigLoader.config).toBeDefined();
    expect(ConfigLoader.config).toHaveProperty('database');
    expect(ConfigLoader.config).toHaveProperty('logging');
  });

  test('should get config value by key', () => {
    ConfigLoader.load('development');
    const database = ConfigLoader.get('database');
    expect(database).toBeDefined();
  });

  test('should get nested config with dot notation', () => {
    ConfigLoader.load('development');
    const path = ConfigLoader.get('database.path');
    expect(typeof path).toBe('string');
  });

  test('should return false for missing key', () => {
    ConfigLoader.load('development');
    expect(ConfigLoader.has('nonexistent')).toBe(false);
  });

  test('should return true for existing key', () => {
    ConfigLoader.load('development');
    expect(ConfigLoader.has('database')).toBe(true);
  });

  test('should set config value', () => {
    ConfigLoader.load('development');
    ConfigLoader.set('test.key', 'test_value');
    expect(ConfigLoader.get('test.key')).toBe('test_value');
  });

  test('should throw on missing key with get', () => {
    ConfigLoader.load('development');
    expect(() => {
      ConfigLoader.get('this.does.not.exist');
    }).toThrow();
  });
});
