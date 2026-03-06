/**
 * 通用 / 辅助类型声明
 */

interface WikiResult {
  totalPages: number;
  pages: { path: string; title: string }[];
  errors: string[];
  [key: string]: any;
}

interface ProjectOverview {
  name: string;
  language: string;
  targets: any[];
  dependencies: any[];
  [key: string]: any;
}

interface FieldDef {
  name: string;
  type?: string;
  required?: boolean;
  default?: any;
  description?: string;
  [key: string]: any;
}

interface OverrideInfo {
  field: string;
  oldValue: any;
  newValue: any;
  [key: string]: any;
}
