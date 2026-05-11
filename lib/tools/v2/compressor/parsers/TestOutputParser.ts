/**
 * @module tools/v2/compressor/parsers/TestOutputParser
 * 解析 vitest/jest/mocha/pytest 测试输出为紧凑结构化格式。
 */

interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  failures: FailureInfo[];
}

interface FailureInfo {
  name: string;
  message: string;
}

const VITEST_SUMMARY_RE =
  /Tests\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed\s*(?:\|\s*(\d+)\s+skipped\s*)?\(\s*(\d+)\s*\)/;
const VITEST_SUMMARY_PASS_RE =
  /Tests\s+(\d+)\s+passed\s*(?:\|\s*(\d+)\s+skipped\s*)?\(\s*(\d+)\s*\)/;

const JEST_SUMMARY_RE =
  /Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(?:(\d+)\s+passed,?\s*)?(\d+)\s+total/;

const PYTEST_SUMMARY_RE =
  /=+\s+(?:(\d+)\s+passed)?(?:,?\s*(\d+)\s+failed)?(?:,?\s*(\d+)\s+skipped)?(?:,?\s*(\d+)\s+error)?/;

const MOCHA_PASSING_RE = /(\d+)\s+passing/;
const MOCHA_FAILING_RE = /(\d+)\s+failing/;

const FAIL_BLOCK_RE =
  /(?:FAIL|✕|✗|×|FAILED)\s+(.+?)(?:\n|\r\n)([\s\S]*?)(?=\n(?:FAIL|✕|✗|×|FAILED|Tests:|Test Suites:|$))/g;

const VITEST_FAIL_RE = /(?:❌|×|✕)\s+(.+?)(?:\n|\r\n)([\s\S]*?)(?=\n(?:❌|×|✕|Tests\s|$))/g;

function extractFailures(raw: string): FailureInfo[] {
  const failures: FailureInfo[] = [];
  const seen = new Set<string>();

  for (const re of [FAIL_BLOCK_RE, VITEST_FAIL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const name = m[1].trim();
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const detail = m[2]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, 3)
        .join(' | ');
      failures.push({ name, message: detail || 'unknown error' });
    }
  }

  return failures;
}

function tryVitest(raw: string): TestResult | null {
  let m = VITEST_SUMMARY_RE.exec(raw);
  if (m) {
    return {
      failed: parseInt(m[1], 10),
      passed: parseInt(m[2], 10),
      skipped: m[3] ? parseInt(m[3], 10) : 0,
      total: parseInt(m[4], 10),
      failures: extractFailures(raw),
    };
  }

  m = VITEST_SUMMARY_PASS_RE.exec(raw);
  if (m) {
    return {
      passed: parseInt(m[1], 10),
      failed: 0,
      skipped: m[2] ? parseInt(m[2], 10) : 0,
      total: parseInt(m[3], 10),
      failures: [],
    };
  }

  return null;
}

function tryJest(raw: string): TestResult | null {
  const m = JEST_SUMMARY_RE.exec(raw);
  if (!m) {
    return null;
  }

  const failed = m[1] ? parseInt(m[1], 10) : 0;
  const skipped = m[2] ? parseInt(m[2], 10) : 0;
  const passed = m[3] ? parseInt(m[3], 10) : 0;
  const total = parseInt(m[4], 10);

  return { passed, failed, skipped, total, failures: extractFailures(raw) };
}

function tryPytest(raw: string): TestResult | null {
  const m = PYTEST_SUMMARY_RE.exec(raw);
  if (!m) {
    return null;
  }

  const passed = m[1] ? parseInt(m[1], 10) : 0;
  const failed = m[2] ? parseInt(m[2], 10) : 0;
  const skipped = m[3] ? parseInt(m[3], 10) : 0;
  const errors = m[4] ? parseInt(m[4], 10) : 0;

  return {
    passed,
    failed: failed + errors,
    skipped,
    total: passed + failed + skipped + errors,
    failures: extractFailures(raw),
  };
}

function tryMocha(raw: string): TestResult | null {
  const passingMatch = MOCHA_PASSING_RE.exec(raw);
  if (!passingMatch) {
    return null;
  }

  const passed = parseInt(passingMatch[1], 10);
  const failingMatch = MOCHA_FAILING_RE.exec(raw);
  const failed = failingMatch ? parseInt(failingMatch[1], 10) : 0;

  return {
    passed,
    failed,
    skipped: 0,
    total: passed + failed,
    failures: extractFailures(raw),
  };
}

function formatResult(result: TestResult): string {
  const parts: string[] = [
    `Tests: ${result.passed} passed, ${result.failed} failed, ${result.total} total`,
  ];

  if (result.failures.length > 0) {
    parts.push('');
    parts.push('[failures]');
    for (const f of result.failures) {
      parts.push(`FAIL ${f.name}: ${f.message}`);
    }
  }

  return parts.join('\n');
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  try {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    const result = tryVitest(raw) ?? tryJest(raw) ?? tryPytest(raw) ?? tryMocha(raw);

    if (!result) {
      return null;
    }
    return formatResult(result);
  } catch {
    return null;
  }
}
