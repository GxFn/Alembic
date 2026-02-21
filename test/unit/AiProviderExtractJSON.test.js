/**
 * AiProvider.extractJSON / _repairTruncatedArray 单元测试
 * 验证截断 JSON 回收能力 — 特别是代码字段含未转义引号的场景
 */
import AiProvider from '../../lib/external/ai/AiProvider.js';

// 构建一个最小实例（不需要真正的 chat 能力）
function makeProvider() {
  return new AiProvider({ name: 'test', apiKey: 'x' });
}

describe('AiProvider.extractJSON', () => {
  let provider;
  beforeAll(() => {
    provider = makeProvider();
  });

  test('正常完整 JSON 数组', () => {
    const json = '[{"title":"foo","code":"bar"},{"title":"baz","code":"qux"}]';
    const result = provider.extractJSON(json, '[', ']');
    expect(result).toEqual([
      { title: 'foo', code: 'bar' },
      { title: 'baz', code: 'qux' },
    ]);
  });

  test('包含 markdown 代码块包裹', () => {
    const json = '```json\n[{"title":"foo"}]\n```';
    const result = provider.extractJSON(json, '[', ']');
    expect(result).toEqual([{ title: 'foo' }]);
  });

  test('尾部截断 — 基本场景', () => {
    const json = '[{"title":"A","code":"x"},{"title":"B","code":"y"},{"title":"C","co';
    const result = provider.extractJSON(json, '[', ']');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    expect(result[0].title).toBe('A');
    expect(result[1].title).toBe('B');
  });

  test('尾部截断 — 在字符串中间断裂', () => {
    const json = '[{"title":"Complete","summary":"good item"},{"title":"Incom';
    const result = provider.extractJSON(json, '[', ']');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].title).toBe('Complete');
  });

  test('尾部截断 — 代码字段含花括号', () => {
    const json =
      '[{"title":"ViewSetup","code":"func viewDidLoad() {\\n    super.viewDidLoad()\\n    setupUI()\\n}"},{"title":"Truncated","code":"func x() {';
    const result = provider.extractJSON(json, '[', ']');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].title).toBe('ViewSetup');
  });

  test('尾部截断 — 嵌套数组 (headers/tags)', () => {
    const json =
      '[{"title":"A","headers":["#import <UIKit/UIKit.h>"],"tags":["ios","ui"]},{"title":"B","headers":["#import <Found';
    const result = provider.extractJSON(json, '[', ']');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].title).toBe('A');
    expect(result[0].headers).toEqual(['#import <UIKit/UIKit.h>']);
  });

  test('尾部截断 — 代码含未转义引号（回退路径）', () => {
    // 模拟 AI 返回的代码里出现未转义的双引号（恢复路径应通过 regex fallback）
    const obj1 = '{"title":"GoodItem","code":"let x = 1"}';
    // obj2 的 code 值里有一个未转义的 " — 破坏了字符串边界追踪
    const obj2start = '{"title":"BadItem","code":"let s = "hello"';
    const json = `[${obj1},${obj2start}`;
    const result = provider.extractJSON(json, '[', ']');
    // 至少字符级路径或正则回退应该回收 obj1
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].title).toBe('GoodItem');
  });

  test('尾部截断 — 多个完整 + 最后一个不完整', () => {
    const items = [];
    for (let i = 0; i < 5; i++) {
      items.push(
        `{"title":"Item${i}","summary":"desc${i}","code":"func f${i}() {\\n    return ${i}\\n}"}`
      );
    }
    const complete = `[${items.join(',')},{"title":"Item5","summary":"de`;
    const result = provider.extractJSON(complete, '[', ']');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(5);
    expect(result[4].title).toBe('Item4');
  });

  test('完全截断 — 无任何完整对象', () => {
    const json = '[{"title":"Incomp';
    const result = provider.extractJSON(json, '[', ']');
    expect(result).toBeNull();
  });

  test('空数组', () => {
    const json = '[]';
    const result = provider.extractJSON(json, '[', ']');
    expect(result).toEqual([]);
  });

  test('尾逗号修复', () => {
    const json = '[{"title":"A",},{"title":"B",},]';
    const result = provider.extractJSON(json, '[', ']');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
  });

  test('混合截断 — 模拟真实 VideoPlayerViews 案例', () => {
    // 模拟：多个完整对象 + 最后一个在 title 值中间被截断
    const recipe1 = JSON.stringify({
      title: 'BDBilibiliVideoPlayerView Init',
      description: '视频播放器初始化',
      code: '- (instancetype)initWithFrame:(CGRect)frame {\n    self = [super initWithFrame:frame];\n    if (self) {\n        [self setupUI];\n    }\n    return self;\n}',
      headers: ['#import <UIKit/UIKit.h>', '#import "BDBilibiliVideoPlayerView.h"'],
      tags: ['init', 'video'],
    });

    const recipe2 = JSON.stringify({
      title: 'GestureRecognizerDelegate',
      description: '手势识别器代理方法',
      usageGuide: '用于处理 UP 主名称和视频区域的点击事件。',
      code: '- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldReceiveTouch:(UITouch *)touch {\n    return YES;\n}',
    });

    const truncated = `[${recipe1},${recipe2},{"title":"BDBilibiliVideoCell {`;

    const result = provider.extractJSON(truncated, '[', ']');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    expect(result[0].title).toBe('BDBilibiliVideoPlayerView Init');
    expect(result[1].title).toBe('GestureRecognizerDelegate');
  });
});
