// Contract validation — JSON Schema registry and validation

export { ContractRegistry } from './registry.js';
export type { ContractSchema, ValidationError, ValidationResult } from './types.js';
export {
  diffSchemas,
  countBreaking,
  hasBreaking,
  renderChanges,
} from './evolution.js';
export type { BreakingDirection, SchemaChange } from './evolution.js';
export { ContractBaselineStore } from './baseline.js';
export type { ContractBaseline } from './baseline.js';
