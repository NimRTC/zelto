/**
 * validate-schema.ts — Lightweight JSON Schema validation for output schemas
 *
 * Provides `validateWithSchema()` which validates a value against a loaded
 * JSON Schema (draft-07 subset). Designed for simple output schemas only;
 * does NOT implement the full JSON Schema spec.
 *
 * C6: This lives in cli/ and may import from contracts/schemas/.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Schema Registry ─────────────────────────────────────────────────────────

interface SchemaDef {
  $id?: string;
  title?: string;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, PropertySchema>;
  additionalProperties?: boolean;
  items?: PropertySchema;
  format?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  pattern?: string;
}

interface PropertySchema {
  type?: string | string[];
  description?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  pattern?: string;
  properties?: Record<string, PropertySchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: PropertySchema;
}

const SCHEMA_CACHE = new Map<string, SchemaDef>();

const SCHEMAS_DIR = (() => {
  // Try to resolve relative to this file first
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // From dist/cli/ -> ../../contracts/schemas
    const distPath = join(__dirname, '..', '..', 'contracts', 'schemas');
    if (existsSync(distPath)) return distPath;
  } catch { /* fall through */ }

  // Fallback: resolve from source dir
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // From src/cli/ -> ../../contracts/schemas (for source)
    const srcPath = join(__dirname, '..', '..', 'contracts', 'schemas');
    if (existsSync(srcPath)) return srcPath;
  } catch { /* fall through */ }

  // Fallback: relative to cwd
  return join(process.cwd(), 'contracts', 'schemas');
})();

function loadSchema(name: string): SchemaDef {
  const cached = SCHEMA_CACHE.get(name);
  if (cached) return cached;

  const schemaPath = join(SCHEMAS_DIR, `${name}.json`);
  const raw = readFileSync(schemaPath, 'utf-8');
  const schema = JSON.parse(raw) as SchemaDef;
  SCHEMA_CACHE.set(name, schema);
  return schema;
}

// ─── Validation Error ────────────────────────────────────────────────────────

export class SchemaValidationError extends Error {
  public readonly schemaName: string;
  public readonly errors: string[];

  constructor(schemaName: string, errors: string[]) {
    super(`Schema validation failed for "${schemaName}": ${errors.join('; ')}`);
    this.name = 'SchemaValidationError';
    this.schemaName = schemaName;
    this.errors = errors;
  }
}

// ─── Validator ───────────────────────────────────────────────────────────────

/**
 * Validate a value against a named schema.
 *
 * @param schemaName — The schema file name (without .json extension)
 * @param value — The value to validate
 * @returns An array of error messages (empty = valid)
 */
export function validateWithSchema(schemaName: string, value: unknown): string[] {
  const schema = loadSchema(schemaName);
  const errors: string[] = [];

  validateValue(value, schema, errors, '$');

  return errors;
}

/**
 * Validate a value against a property schema.
 */
function validateValue(
  value: unknown,
  schema: PropertySchema | SchemaDef,
  errors: string[],
  path: string,
): void {
  // Type check
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    let actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

    // Map JS types to schema types
    const mappedType = actualType === 'object' && value === null ? 'null' : actualType;

    // Handle 'integer' type: JavaScript typeof returns 'number', so we check if it's an integer
    const effectiveTypes = types.map((t) => {
      if (t === 'integer') return 'number';
      return t;
    });

    // For 'integer' type, also verify the value is actually an integer
    const isIntegerType = types.includes('integer');
    if (isIntegerType && typeof value === 'number' && !Number.isInteger(value)) {
      errors.push(`${path}: expected integer, got non-integer number ${value}`);
      return;
    }

    if (!effectiveTypes.includes(mappedType)) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${mappedType}`);
      return; // No point checking further if type is wrong
    }
  }

  // Null check
  if (value === null || value === undefined) {
    if (schema.type && schema.type !== 'null' && !(Array.isArray(schema.type) && schema.type.includes('null'))) {
      errors.push(`${path}: expected ${schema.type}, got null/undefined`);
    }
    return;
  }

  // Object checks
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    // Required properties
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj) || obj[key] === undefined) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }

    // Property validation
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          validateValue(obj[key], propSchema, errors, `${path}.${key}`);
        }
      }
    }

    // additionalProperties check
    if (schema.additionalProperties === false) {
      const knownKeys = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!knownKeys.has(key)) {
          errors.push(`${path}: unexpected property "${key}"`);
        }
      }
    }

    // Nested object in property schema
    if (schema.properties && !schema.type) {
      // Already handled above
    }
  }

  // Array checks
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      validateValue(value[i], schema.items, errors, `${path}[${i}]`);
    }
  }

  // String format checks
  if (typeof value === 'string' && schema.format) {
    if (schema.format === 'date-time') {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        errors.push(`${path}: invalid date-time format "${value}"`);
      }
    }
  }

  // Minimum/maximum checks
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: value ${value} is less than minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: value ${value} is greater than maximum ${schema.maximum}`);
    }
  }

  // Enum checks
  if (schema.enum && typeof value === 'string') {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: "${value}" is not in enum [${schema.enum.join(', ')}]`);
    }
  }

  // Pattern checks
  if (schema.pattern && typeof value === 'string') {
    const regex = new RegExp(schema.pattern);
    if (!regex.test(value)) {
      errors.push(`${path}: "${value}" does not match pattern ${schema.pattern}`);
    }
  }
}

/**
 * Check if a value is valid against a named schema (boolean result).
 */
export function isValid(schemaName: string, value: unknown): boolean {
  return validateWithSchema(schemaName, value).length === 0;
}

export { loadSchema };
export type { SchemaDef, PropertySchema };
