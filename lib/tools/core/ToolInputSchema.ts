export interface ToolParameterSchema {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  enum?: unknown[];
  items?: unknown;
}

export interface ToolInputNormalizationResult {
  args: Record<string, unknown>;
  changed: boolean;
  unmatchedKeys: string[];
}

const PARAM_ALIASES: Record<string, string> = {
  file: 'filePath',
  filename: 'filePath',
  file_name: 'filePath',
  filepath: 'filePath',
  file_path: 'filePath',
  path: 'filePath',
  query: 'pattern',
  search: 'pattern',
  keyword: 'pattern',
  search_query: 'pattern',
  search_text: 'pattern',
  regex: 'pattern',
  is_regex: 'isRegex',
  file_filter: 'fileFilter',
  context_lines: 'contextLines',
  max_results: 'maxResults',
  start_line: 'startLine',
  end_line: 'endLine',
  max_lines: 'maxLines',
  candidate_id: 'candidateId',
  recipe_id: 'recipeId',
  skill_name: 'skillName',
};

export function normalizeToolInput(
  args: Record<string, unknown>,
  schema: ToolParameterSchema
): ToolInputNormalizationResult {
  if (!args || typeof args !== 'object') {
    return { args: {}, changed: true, unmatchedKeys: [] };
  }

  const properties = schema?.properties || {};
  const schemaKeys = new Set(Object.keys(properties));
  if (schemaKeys.size === 0) {
    return { args, changed: false, unmatchedKeys: [] };
  }

  const normalized: Record<string, unknown> = {};
  const unmatchedKeys: string[] = [];
  let changed = false;

  for (const [key, value] of Object.entries(args)) {
    if (schemaKeys.has(key)) {
      normalized[key] = value;
      continue;
    }

    const camelKey = key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
    if (schemaKeys.has(camelKey)) {
      normalized[camelKey] = value;
      changed = true;
      continue;
    }

    const aliased = PARAM_ALIASES[key];
    if (aliased && schemaKeys.has(aliased)) {
      normalized[aliased] = value;
      changed = true;
      continue;
    }

    normalized[key] = value;
    unmatchedKeys.push(key);
  }

  return { args: normalized, changed, unmatchedKeys };
}

/** @deprecated Use `validateToolInputV2` from `SchemaValidator.ts` (ajv-based, full JSON Schema). */
export function validateToolInput(
  args: Record<string, unknown>,
  schema: ToolParameterSchema
): string[] {
  const errors: string[] = [];
  const properties = schema?.properties || {};

  for (const key of schema?.required || []) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      errors.push(`缺少必填参数 "${key}"`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key] as ToolParameterSchema | undefined;
    if (!propSchema) {
      continue;
    }
    errors.push(...validateValue(value, propSchema, key));
  }

  return errors;
}

function validateValue(value: unknown, schema: ToolParameterSchema, fieldPath: string): string[] {
  const errors: string[] = [];
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

  if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(value, type))) {
    errors.push(`参数 "${fieldPath}" 类型应为 ${allowedTypes.join('|')}`);
    return errors;
  }

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`参数 "${fieldPath}" 必须是: ${schema.enum.map(String).join(', ')}`);
  }

  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    for (const key of schema.required || []) {
      if (!(key in objectValue) || objectValue[key] === undefined || objectValue[key] === null) {
        errors.push(`缺少必填参数 "${fieldPath}.${key}"`);
      }
    }
    for (const [key, childValue] of Object.entries(objectValue)) {
      const childSchema = schema.properties[key] as ToolParameterSchema | undefined;
      if (childSchema) {
        errors.push(...validateValue(childValue, childSchema, `${fieldPath}.${key}`));
      }
    }
  }

  if (schema.items && Array.isArray(value)) {
    const itemSchema = schema.items as ToolParameterSchema;
    value.forEach((item, index) => {
      errors.push(...validateValue(item, itemSchema, `${fieldPath}[${index}]`));
    });
  }

  return errors;
}

function matchesType(value: unknown, type: string) {
  if (type === 'array') {
    return Array.isArray(value);
  }
  if (type === 'object') {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
  if (type === 'integer') {
    return Number.isInteger(value);
  }
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (type === 'null') {
    return value === null;
  }
  return typeof value === type;
}
