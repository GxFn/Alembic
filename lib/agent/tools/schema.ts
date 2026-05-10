import type { ToolSchema } from "./types.js";

export interface ToolSchemaValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export function validateToolInputSchema(
  schema: ToolSchema,
  input: unknown,
): ToolSchemaValidationResult {
  const errors: string[] = [];
  validateValue(schema, normalizeTopLevelInput(schema, input), "$", errors);
  return { ok: errors.length === 0, errors };
}

function normalizeTopLevelInput(schema: ToolSchema, input: unknown): unknown {
  if (input === undefined && allowsType(schema, "object")) {
    return {};
  }
  return input;
}

function validateValue(schema: ToolSchema, value: unknown, path: string, errors: string[]): void {
  if (!matchesType(schema, value)) {
    errors.push(`${path} expected ${formatTypes(schema.type)}`);
    return;
  }

  if (value === undefined || value === null) {
    return;
  }

  if (schema.enum && typeof value === "string" && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
    return;
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.items) {
      for (const [index, item] of value.entries()) {
        validateValue(schema.items as ToolSchema, item, `${path}[${index}]`, errors);
      }
    }
    return;
  }

  if (isRecord(value)) {
    validateObject(schema, value, path, errors);
  }
}

function validateObject(
  schema: ToolSchema,
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const properties = schema.properties ?? {};
  for (const required of schema.required ?? []) {
    if (value[required] === undefined) {
      errors.push(`${path}.${required} is required`);
    }
  }

  for (const [key, nested] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (!propertySchema) {
      if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      }
      continue;
    }
    validateValue(propertySchema, nested, `${path}.${key}`, errors);
  }
}

function matchesType(schema: ToolSchema, value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return normalizeTypes(schema.type).some((type) => matchesPrimitiveType(type, value));
}

function matchesPrimitiveType(type: string, value: unknown): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function allowsType(schema: ToolSchema, type: string): boolean {
  return normalizeTypes(schema.type).includes(type);
}

function normalizeTypes(type: ToolSchema["type"]): readonly string[] {
  return Array.isArray(type) ? [...type] : [type as string];
}

function formatTypes(type: ToolSchema["type"]): string {
  return normalizeTypes(type).join("|");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
