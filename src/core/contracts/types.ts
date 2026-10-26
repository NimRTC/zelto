// Contract types — JSON Schema registry and validation results

export interface ContractSchema {
  name: string;
  path: string;
  schema: Record<string, unknown>;
  description: string;
}

export interface ValidationError {
  path: string;
  message: string;
  expected: unknown;
  actual: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}
