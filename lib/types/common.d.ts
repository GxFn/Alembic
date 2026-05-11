/** 通用 / 辅助类型声明 */

interface WikiResult {
  totalPages: number;
  pages: { path: string; title: string }[];
  errors: string[];
  [key: string]: unknown;
}

interface ProjectOverview {
  name: string;
  language: string;
  targets: unknown[];
  dependencies: unknown[];
  [key: string]: unknown;
}

interface FieldDef {
  name: string;
  type?: string;
  required?: boolean;
  default?: unknown;
  description?: string;
  [key: string]: unknown;
}

interface OverrideInfo {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  [key: string]: unknown;
}
