import {
  assessContentImpact,
  extractApiTokens,
  tokenizeIdentifiers,
  tokenPresenceRate,
} from '../../lib/service/evolution/ContentImpactAnalyzer.js';

describe('ContentImpactAnalyzer', () => {
  /* ─── tokenizeIdentifiers ─── */

  describe('tokenizeIdentifiers', () => {
    test('提取标识符并跳过注释和字符串', () => {
      const code = `
        // This is a comment
        const foo = "hello world";
        function bar(baz) { return baz; }
      `;
      const tokens = tokenizeIdentifiers(code);
      expect(tokens).toContain('foo');
      expect(tokens).toContain('bar');
      expect(tokens).toContain('baz');
      // 字符串内容不应出现
      expect(tokens).not.toContain('hello');
      expect(tokens).not.toContain('world');
    });

    test('空代码返回空数组', () => {
      expect(tokenizeIdentifiers('')).toEqual([]);
    });

    test('跳过块注释', () => {
      const code = `/* MyClass */ const RealClass = 1;`;
      const tokens = tokenizeIdentifiers(code);
      expect(tokens).toContain('RealClass');
      // MyClass 在块注释内，应被跳过
      expect(tokens).not.toContain('MyClass');
    });
  });

  /* ─── extractApiTokens ─── */

  describe('extractApiTokens', () => {
    test('过滤占位符前缀（My*, Example*）', () => {
      const code = 'class MyService { ServiceRegistry.shared.resolve(MyProtocol.self) }';
      const tokens = extractApiTokens(code);
      expect(tokens).toContain('ServiceRegistry');
      expect(tokens).toContain('shared');
      expect(tokens).toContain('resolve');
      expect(tokens).not.toContain('MyService');
      expect(tokens).not.toContain('MyProtocol');
    });

    test('过滤语言关键字', () => {
      const code = 'func register(_ type: ServiceType.Type, scope: Scope) { return instance }';
      const tokens = extractApiTokens(code);
      expect(tokens).not.toContain('func');
      expect(tokens).not.toContain('return');
      expect(tokens).toContain('register');
      expect(tokens).toContain('ServiceType');
      expect(tokens).toContain('Scope');
      expect(tokens).toContain('instance');
    });

    test('过滤短标识符（< 4 字符）', () => {
      const code = 'let a = foo.bar(x, y)';
      const tokens = extractApiTokens(code);
      expect(tokens).not.toContain('let');
      expect(tokens).not.toContain('a');
      expect(tokens).not.toContain('x');
      expect(tokens).not.toContain('y');
      expect(tokens).not.toContain('foo');
      expect(tokens).not.toContain('bar');
    });

    test('去重', () => {
      const code = 'ServiceRegistry.shared.register(); ServiceRegistry.shared.resolve()';
      const tokens = extractApiTokens(code);
      const registryCount = tokens.filter((t) => t === 'ServiceRegistry').length;
      expect(registryCount).toBe(1);
    });
  });

  /* ─── tokenPresenceRate ─── */

  describe('tokenPresenceRate', () => {
    test('所有 token 都在 → 1.0', () => {
      const rate = tokenPresenceRate(
        ['ServiceRegistry', 'shared', 'register'],
        'class ServiceRegistry { static let shared = ServiceRegistry(); func register() {} }'
      );
      expect(rate).toBe(1.0);
    });

    test('无 token 匹配 → 0.0', () => {
      const rate = tokenPresenceRate(
        ['ServiceRegistry', 'resolve'],
        'class NetworkManager { func request() {} }'
      );
      expect(rate).toBe(0.0);
    });

    test('部分匹配 → 正确比率', () => {
      const rate = tokenPresenceRate(
        ['ServiceRegistry', 'shared', 'resolve', 'register'],
        'class ServiceRegistry { static let shared = ServiceRegistry() }'
      );
      // ServiceRegistry + shared = 2/4 = 0.5
      expect(rate).toBe(0.5);
    });

    test('空 sourceTokens → 0', () => {
      expect(tokenPresenceRate([], 'anything')).toBe(0);
    });
  });

  /* ─── assessContentImpact ─── */

  describe('assessContentImpact', () => {
    test('文件为 null → reference', () => {
      expect(assessContentImpact(null, 'some coreCode here long enough')).toBe('reference');
    });

    test('coreCode 为空 → reference', () => {
      expect(assessContentImpact('file content', '')).toBe('reference');
    });

    test('coreCode 太短 → reference', () => {
      expect(assessContentImpact('file content', 'short')).toBe('reference');
    });

    test('coreCode 全是占位符 → reference（无有效 token）', () => {
      const coreCode = 'class MyService { MyProtocol.resolve() }';
      expect(assessContentImpact('any file content', coreCode)).toBe('reference');
    });

    test('高存在率 → pattern', () => {
      const coreCode = `
        ServiceRegistry.shared.register(Protocol.self, scope: .singleton) {
            Implementation()
        }
      `;
      const fileContent = `
        import Foundation
        class ServiceRegistry {
          static let shared = ServiceRegistry()
          func register<T>(_ type: T.Type, scope: Scope, factory: () -> T) {}
          func resolve<T>(_ type: T.Type) -> T { fatalError() }
          var services: [String: Any] = [:]
        }
        enum Scope { case singleton, transient }
      `;
      expect(assessContentImpact(fileContent, coreCode)).toBe('pattern');
    });

    test('低存在率（coreCode 与文件无关）→ reference', () => {
      const coreCode = `
        NetworkManager.shared.request(endpoint: .userProfile) { result in
            switch result { case .success(let data): handleData(data) }
        }
      `;
      const fileContent = `
        class ServiceRegistry {
          static let shared = ServiceRegistry()
          func register<T>(_ type: T.Type) {}
          func resolve<T>(_ type: T.Type) -> T { fatalError() }
        }
      `;
      expect(assessContentImpact(fileContent, coreCode)).toBe('reference');
    });

    test('modified 事件从不返回 direct', () => {
      // 即使文件内容完全不包含 coreCode 的任何标识符，也只返回 reference
      const coreCode = 'class UniqueClassName1234 { func uniqueMethod5678() {} }';
      const fileContent = 'class TotallyDifferent { func nothingInCommon() {} }';
      const result = assessContentImpact(fileContent, coreCode);
      expect(result).not.toBe('direct');
    });
  });
});
