// Contract registry — load and validate against JSON Schema from contracts/schemas/

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { ContractSchema, ValidationResult, ValidationError } from './types.js';

export class ContractRegistry {
  private schemasDir: string;
  private cache: Map<string, ContractSchema> = new Map();

  constructor(schemasDir: string) {
    this.schemasDir = schemasDir;
  }

  async loadAll(): Promise<ContractSchema[]> {
    if (!existsSync(this.schemasDir)) return [];

    const files = await readdir(this.schemasDir);
    const schemas: ContractSchema[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const schema = await this.load(file);
        schemas.push(schema);
      } catch {
        // skip corrupt schemas
      }
    }

    return schemas;
  }

  async load(fileName: string): Promise<ContractSchema> {
    const cached = this.cache.get(fileName);
    if (cached) return cached;

    const filePath = join(this.schemasDir, fileName);
    const raw = await readFile(filePath, 'utf-8');
    const schema = JSON.parse(raw) as Record<string, unknown>;

    const name = basename(fileName, extname(fileName));
    const description = (schema.description as string) ?? name;

    const contract: ContractSchema = {
      name,
      path: filePath,
      schema,
      description,
    };

    this.cache.set(fileName, contract);
    return contract;
  }

  async get(name: string): Promise<ContractSchema | null> {
    // Try exact filename first
    const exactFile = `${name}.json`;
    if (this.cache.has(exactFile)) {
      return this.cache.get(exactFile)!;
    }

    // Try loading from disk
    try {
      return await this.load(exactFile);
    } catch {
      // Not found
    }

    // Try matching by schema name (without extension)
    const schemas = await this.loadAll();
    return schemas.find((s) => s.name === name || (s.schema.title as string) === name) ?? null;
  }

  async list(): Promise<ContractSchema[]> {
    return this.loadAll();
  }

  invalidateCache(): void {
    this.cache.clear();
  }

  /**
   * Validate a data object against a loaded schema.
   * Implements basic JSON Schema validation (subset of draft-07).
   * Uses only Node built-ins per C2 invariant.
   */
  async validate(data: unknown, schemaName: string): Promise<ValidationResult> {
    const contract = await this.get(schemaName);
    if (!contract) {
      return {
        valid: false,
        errors: [{ path: '', message: `Schema "${schemaName}" not found`, expected: 'registered schema', actual: schemaName }],
      };
    }

    return this.validateAgainstSchema(data, contract.schema, '');
  }

  private validateAgainstSchema(
    data: unknown,
    schema: Record<string, unknown>,
    path: string,
  ): ValidationResult {
    const errors: ValidationError[] = [];

    // type check
    if (schema.type) {
      const typeStr = schema.type as string;
      const actualType = Array.isArray(data) ? 'array' : typeof data;

      if (typeStr === 'array' && !Array.isArray(data)) {
        errors.push({ path, message: `Expected array`, expected: 'array', actual: actualType });
        return { valid: false, errors };
      }

      if (typeStr !== 'array' && actualType !== typeStr) {
        errors.push({ path, message: `Expected type ${typeStr}`, expected: typeStr, actual: actualType });
      }
    }

    // required fields
    if (schema.required && typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const required = schema.required as string[];
      const obj = data as Record<string, unknown>;
      for (const field of required) {
        if (!(field in obj)) {
          errors.push({ path: `${path}.${field}`, message: `Missing required field`, expected: 'present', actual: 'undefined' });
        }
      }
    }

    // property validation
    if (schema.properties && typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const properties = schema.properties as Record<string, unknown>;
      const obj = data as Record<string, unknown>;
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in obj) {
          const propResult = this.validateAgainstSchema(
            obj[key],
            propSchema as Record<string, unknown>,
            path ? `${path}.${key}` : key,
          );
          errors.push(...propResult.errors);
        }
      }
    }

    // enum check
    if (schema.enum && Array.isArray(schema.enum)) {
      if (!schema.enum.some((e) => e === data)) {
        errors.push({ path, message: `Value not in enum`, expected: schema.enum.join(' | '), actual: String(data) });
      }
    }

    // pattern check (string)
    if (schema.pattern && typeof data === 'string') {
      const regex = new RegExp(schema.pattern as string);
      if (!regex.test(data)) {
        errors.push({ path, message: `Pattern mismatch`, expected: schema.pattern, actual: data });
      }
    }

    // minLength / maxLength
    if (typeof data === 'string') {
      if (schema.minLength != null && data.length < (schema.minLength as number)) {
        errors.push({ path, message: `Too short`, expected: `>= ${schema.minLength}`, actual: String(data.length) });
      }
      if (schema.maxLength != null && data.length > (schema.maxLength as number)) {
        errors.push({ path, message: `Too long`, expected: `<= ${schema.maxLength}`, actual: String(data.length) });
      }
    }

    // minimum / maximum (number)
    if (typeof data === 'number') {
      if (schema.minimum != null && data < (schema.minimum as number)) {
        errors.push({ path, message: `Below minimum`, expected: `>= ${schema.minimum}`, actual: String(data) });
      }
      if (schema.maximum != null && data > (schema.maximum as number)) {
        errors.push({ path, message: `Above maximum`, expected: `<= ${schema.maximum}`, actual: String(data) });
      }
    }

    // array item validation
    if (Array.isArray(data) && schema.items) {
      const itemSchema = schema.items as Record<string, unknown>;
      for (let i = 0; i < data.length; i++) {
        const itemResult = this.validateAgainstSchema(
          data[i],
          itemSchema,
          `${path}[${i}]`,
        );
        errors.push(...itemResult.errors);
      }
    }

    // additionalProperties
    if (schema.additionalProperties === false && typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const properties = schema.properties as Record<string, unknown> ?? {};
      const obj = data as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) {
          errors.push({ path: `${path}.${key}`, message: `Unexpected property`, expected: 'not present', actual: key });
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
