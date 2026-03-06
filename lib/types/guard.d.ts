/**
 * Guard / Compliance 类型声明
 */

interface ComplianceReport {
  total: number;
  passed: number;
  failed: number;
  violations: any[];
  timestamp: number;
  [key: string]: any;
}
