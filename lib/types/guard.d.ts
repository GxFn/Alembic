/**
 * Guard / Compliance 类型声明
 */

interface ComplianceReport {
  total: number;
  passed: number;
  failed: number;
  violations: unknown[];
  timestamp: number;
  [key: string]: unknown;
}
