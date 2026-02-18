/**
 * Integration: DirectiveDetector — 文件内指令检测器
 *
 * 纯函数测试 — 无需 Bootstrap 或 DB
 * 验证所有指令类型: create, search, audit, header, alink, draft
 */

import { detectTriggers, MARKS, REGEX } from '../../lib/service/automation/DirectiveDetector.js';

describe('Integration: DirectiveDetector', () => {

  // ── ObjC 文件指令检测 ─────────────────────────────────

  describe('ObjC 文件 (.m)', () => {
    it('检测 // as:c 创建指令', () => {
      const code = `#import "ViewController.h"

@implementation ViewController
// as:c
- (void)viewDidLoad {
    [super viewDidLoad];
}
@end`;
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.createLine).not.toBeNull();
      expect(result.createOption).toBeNull();
      expect(result.isSwift).toBe(false);
    });

    it('检测 // as:create 完整指令', () => {
      const code = '// as:create\n[self doSomething];';
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.createLine).not.toBeNull();
    });

    it('检测 // as:c -c 选项（clipboard 模式）', () => {
      const code = '// as:c -c\n[self doSomething];';
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.createLine).not.toBeNull();
      expect(result.createOption).toBe('c');
    });

    it('检测 // as:c -f 选项（file 模式）', () => {
      const code = '// as:c -f\n[self doSomething];';
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.createLine).not.toBeNull();
      expect(result.createOption).toBe('f');
    });

    it('检测 // as:s 搜索指令', () => {
      const code = '// as:s URLSession\n[self request];';
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.searchLine).not.toBeNull();
    });

    it('检测 // as:search 搜索指令', () => {
      const code = '// as:search networking\nNSLog(@"test");';
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.searchLine).not.toBeNull();
    });

    it('检测 // autosnippet:search 搜索指令', () => {
      const code = '// autosnippet:search networking\nNSLog(@"test");';
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.searchLine).not.toBeNull();
    });

    it('检测 // as:a 审计指令', () => {
      const code = '// as:a\n[self doSomething];';
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.guardLine).not.toBeNull();
    });

    it('检测 // as:audit 审计指令', () => {
      const code = '// as:audit\n[self doSomething];';
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.guardLine).not.toBeNull();
    });

    it('检测 ObjC #import 语句收集', () => {
      const code = `#import <UIKit/UIKit.h>
#import <Foundation/Foundation.h>
@implementation VC
@end`;
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.importArray).toHaveLength(2);
      expect(result.importArray[0]).toContain('UIKit');
      expect(result.importArray[1]).toContain('Foundation');
    });

    it('检测 // as:include 头文件指令', () => {
      const code = '// as:include <MyModule/Header.h>';
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.headerLine).not.toBeNull();
    });

    it('检测 // autosnippet:include 头文件指令', () => {
      const code = '// autosnippet:include <MyModule/Header.h>';
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.headerLine).not.toBeNull();
    });
  });

  // ── Swift 文件指令检测 ────────────────────────────────

  describe('Swift 文件 (.swift)', () => {
    it('检测 // as:c 创建指令', () => {
      const code = '// as:c\nfunc viewDidLoad() { }';
      const result = detectTriggers(code, 'ViewController.swift');
      expect(result.createLine).not.toBeNull();
      expect(result.isSwift).toBe(true);
    });

    it('检测 Swift import 语句收集', () => {
      const code = 'import UIKit\nimport Foundation\nclass VC: UIViewController { }';
      const result = detectTriggers(code, 'ViewController.swift');
      expect(result.importArray).toHaveLength(2);
    });

    it('检测 // as:import 指令', () => {
      const code = '// as:import MyModule';
      const result = detectTriggers(code, 'ViewController.swift');
      expect(result.headerLine).not.toBeNull();
    });

    it('检测 // autosnippet:import 指令', () => {
      const code = '// autosnippet:import MyModule';
      const result = detectTriggers(code, 'ViewController.swift');
      expect(result.headerLine).not.toBeNull();
    });
  });

  // ── 无指令文件 ────────────────────────────────────────

  describe('无指令的正常代码', () => {
    it('ObjC 普通代码不检出任何指令', () => {
      const code = `
#import "ViewController.h"
@implementation ViewController
- (void)viewDidLoad {
    [super viewDidLoad];
}
@end`;
      const result = detectTriggers(code, 'ViewController.m');
      expect(result.createLine).toBeNull();
      expect(result.searchLine).toBeNull();
      expect(result.guardLine).toBeNull();
      expect(result.headerLine).toBeNull();
      expect(result.alinkLine).toBeNull();
    });

    it('Swift 普通代码不检出任何指令', () => {
      const code = `
import UIKit
class VC: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
    }
}`;
      const result = detectTriggers(code, 'ViewController.swift');
      expect(result.createLine).toBeNull();
      expect(result.searchLine).toBeNull();
      expect(result.guardLine).toBeNull();
      // headerLine 也应为 null（import UIKit 是普通 import，不是 as:import）
      expect(result.headerLine).toBeNull();
    });
  });

  // ── REGEX 正则表达式 ──────────────────────────────────

  describe('REGEX 常量正确性', () => {
    it('CREATE_LINE 匹配基本指令', () => {
      expect(REGEX.CREATE_LINE.test('// as:c')).toBe(true);
      expect(REGEX.CREATE_LINE.test('// as:create')).toBe(true);
      expect(REGEX.CREATE_LINE.test('// as:c -c')).toBe(true);
      expect(REGEX.CREATE_LINE.test('// as:c -f')).toBe(true);
    });

    it('CREATE_LINE 不匹配无关内容', () => {
      expect(REGEX.CREATE_LINE.test('// as:search')).toBe(false);
      expect(REGEX.CREATE_LINE.test('// create something')).toBe(false);
      expect(REGEX.CREATE_LINE.test('as:c')).toBe(false);
    });

    it('SEARCH_MARK 匹配搜索指令', () => {
      expect(REGEX.SEARCH_MARK.test('// as:s keyword')).toBe(true);
      expect(REGEX.SEARCH_MARK.test('// as:search keyword')).toBe(true);
      expect(REGEX.SEARCH_MARK.test('// autosnippet:search keyword')).toBe(true);
    });

    it('DRAFT_FILE 匹配草稿文件', () => {
      expect(REGEX.DRAFT_FILE.test('_draft_networking.md')).toBe(true);
      expect(REGEX.DRAFT_FILE.test('_draft_UI.md')).toBe(true);
      expect(REGEX.DRAFT_FILE.test('_DRAFT_test.md')).toBe(true);
      expect(REGEX.DRAFT_FILE.test('draft.md')).toBe(false);
      expect(REGEX.DRAFT_FILE.test('_draft_test.txt')).toBe(false);
    });

    it('HEADER_OBJC 匹配 ObjC 头文件指令', () => {
      expect(REGEX.HEADER_OBJC.test('// as:include <MyModule/Header.h>')).toBe(true);
      expect(REGEX.HEADER_OBJC.test('// autosnippet:include <MyModule/Header.h>')).toBe(true);
      expect(REGEX.HEADER_OBJC.test('// as:include "Header.h"')).toBe(true);
    });

    it('HEADER_SWIFT 匹配 Swift import 指令', () => {
      expect(REGEX.HEADER_SWIFT.test('// as:import MyModule')).toBe(true);
      expect(REGEX.HEADER_SWIFT.test('// autosnippet:import MyModule')).toBe(true);
    });
  });

  // ── MARKS 常量 ────────────────────────────────────────

  describe('MARKS 常量完整性', () => {
    it('应包含所有指令标记', () => {
      expect(MARKS.HEADER_INCLUDE).toBeDefined();
      expect(MARKS.HEADER_IMPORT).toBeDefined();
      expect(MARKS.HEADER_INCLUDE_SHORT).toBeDefined();
      expect(MARKS.HEADER_IMPORT_SHORT).toBeDefined();
      expect(MARKS.CREATE_SHORT).toBeDefined();
      expect(MARKS.CREATE_ALIAS).toBeDefined();
      expect(MARKS.AUDIT_SHORT).toBeDefined();
      expect(MARKS.AUDIT_ALIAS).toBeDefined();
      expect(MARKS.SEARCH_SHORT).toBeDefined();
      expect(MARKS.SEARCH_LONG).toBeDefined();
      expect(MARKS.SEARCH_ALIAS).toBeDefined();
      expect(MARKS.ALINK).toBeDefined();
    });
  });

  // ── 多指令共存 ────────────────────────────────────────

  describe('多指令共存', () => {
    it('同文件可同时包含 create 和 search 指令', () => {
      const code = `
// as:c
func createSomething() { }
// as:s networking
`;
      const result = detectTriggers(code, 'Test.swift');
      expect(result.createLine).not.toBeNull();
      expect(result.searchLine).not.toBeNull();
    });

    it('同文件可同时包含 audit 和 header 指令', () => {
      const code = `
// as:a
// as:import MyModule
import UIKit
`;
      const result = detectTriggers(code, 'Test.swift');
      expect(result.guardLine).not.toBeNull();
      expect(result.headerLine).not.toBeNull();
    });
  });

  // ── 边界情况 ──────────────────────────────────────────

  describe('边界情况', () => {
    it('空文件内容', () => {
      const result = detectTriggers('', 'Empty.swift');
      expect(result.createLine).toBeNull();
      expect(result.searchLine).toBeNull();
      expect(result.guardLine).toBeNull();
      expect(result.headerLine).toBeNull();
      expect(result.importArray).toHaveLength(0);
    });

    it('指令前后有空格', () => {
      const code = '  // as:c  ';
      const result = detectTriggers(code, 'Test.m');
      // 前后有空格时 trim 后应仍能检测
      expect(result.createLine).not.toBeNull();
    });

    it('// as:audit 后跟空格或行尾', () => {
      // // as:a 后允许空格
      const code1 = '// as:a ';
      const r1 = detectTriggers(code1, 'Test.m');
      expect(r1.guardLine).not.toBeNull();

      // // as:a 后直接行尾
      const code2 = '// as:a';
      const r2 = detectTriggers(code2, 'Test.m');
      expect(r2.guardLine).not.toBeNull();
    });
  });
});
