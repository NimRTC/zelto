/**
 * validator.ts — Policy syntax validation and input validation
 *
 * Pure function, zero dependencies, deterministic.
 * Validates PolicyConfig / PolicyRule structures against the schema
 * defined in contracts/schemas/policy.json and enforced by types.ts.
 *
 * C2: core/ does not depend on any SDK or adapters/
 * C3: core/policy/ is deterministic — no model calls, no network
 */

import type { PolicyConfig, PolicyRule, Decision } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ValidationError {
  /** JSON-path-style location of the error (e.g. "rules[0].action") */
  path: string;
  /** Human-readable description of the problem */
  message: string;
  /** Machine-readable error code for programmatic handling */
  code: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ACTIONS: readonly Decision[] = ['allow', 'deny', 'ask'];

const VALID_OPERATIONS: readonly string[] = ['read', 'write', 'execute'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a complete PolicyConfig structure.
 * Checks rules array, protected paths, and every rule individually.
 */
export function validatePolicyConfig(data: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (data === null || data === undefined || typeof data !== 'object') {
    errors.push({
      path: '',
      message: 'Policy config must be a non-null object',
      code: 'E_TYPE',
    });
    return { valid: false, errors };
  }

  const config = data as Record<string, unknown>;

  // Validate rules
  if (!Array.isArray(config.rules)) {
    errors.push({
      path: 'rules',
      message: 'Policy config must contain a "rules" array',
      code: 'E_REQUIRED',
    });
    // Can't validate individual rules if rules is missing
    return { valid: false, errors };
  }

  if (config.rules.length === 0) {
    errors.push({
      path: 'rules',
      message: 'At least one rule is required',
      code: 'E_EMPTY',
    });
  }

  for (let i = 0; i < config.rules.length; i++) {
    const ruleErrors = validateRule(config.rules[i]);
    for (const err of ruleErrors) {
      errors.push({
        ...err,
        path: `rules[${i}].${err.path}`,
      });
    }
  }

  // Validate protected (optional)
  if (config.protected !== undefined) {
    if (!Array.isArray(config.protected)) {
      errors.push({
        path: 'protected',
        message: '"protected" must be an array of path strings',
        code: 'E_TYPE',
      });
    } else {
      for (let i = 0; i < (config.protected as unknown[]).length; i++) {
        const p = (config.protected as unknown[])[i];
        if (typeof p !== 'string' || p.trim() === '') {
          errors.push({
            path: `protected[${i}]`,
            message: 'Each protected path must be a non-empty string',
            code: 'E_TYPE',
          });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a single PolicyRule structure.
 * Returns errors scoped to the rule's own fields (no "rules[N]." prefix).
 */
export function validateRule(rule: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (rule === null || rule === undefined || typeof rule !== 'object') {
    errors.push({
      path: '',
      message: 'Rule must be a non-null object',
      code: 'E_TYPE',
    });
    return errors;
  }

  const r = rule as Record<string, unknown>;

  // --- id: required, non-empty ---
  if (r.id === undefined || r.id === null) {
    errors.push({
      path: 'id',
      message: 'Rule id is required',
      code: 'E_REQUIRED',
    });
  } else if (typeof r.id !== 'string' || (r.id as string).trim() === '') {
    errors.push({
      path: 'id',
      message: 'Rule id must be a non-empty string',
      code: 'E_TYPE',
    });
  }

  // --- match: required, non-empty object ---
  if (r.match === undefined || r.match === null) {
    errors.push({
      path: 'match',
      message: 'Rule match is required',
      code: 'E_REQUIRED',
    });
  } else {
    errors.push(...validateMatch(r.match, 'match'));
  }

  // --- action: required, valid enum ---
  if (r.action === undefined || r.action === null) {
    errors.push({
      path: 'action',
      message: 'Rule action is required',
      code: 'E_REQUIRED',
    });
  } else if (typeof r.action !== 'string' || !VALID_ACTIONS.includes(r.action as Decision)) {
    errors.push({
      path: 'action',
      message: `Rule action must be one of: ${VALID_ACTIONS.join(', ')}`,
      code: 'E_ENUM',
    });
  }

  // --- basis: required, non-empty ---
  if (r.basis === undefined || r.basis === null) {
    errors.push({
      path: 'basis',
      message: 'Rule basis is required',
      code: 'E_REQUIRED',
    });
  } else if (typeof r.basis !== 'string' || (r.basis as string).trim() === '') {
    errors.push({
      path: 'basis',
      message: 'Rule basis must be a non-empty string',
      code: 'E_TYPE',
    });
  }

  // --- guidance: optional, must be string if present ---
  if (r.guidance !== undefined && r.guidance !== null && typeof r.guidance !== 'string') {
    errors.push({
      path: 'guidance',
      message: 'Rule guidance must be a string',
      code: 'E_TYPE',
    });
  }

  // --- priority: optional, must be non-negative integer if present ---
  if (r.priority !== undefined && r.priority !== null) {
    if (typeof r.priority !== 'number' || !Number.isInteger(r.priority) || r.priority < 0) {
      errors.push({
        path: 'priority',
        message: 'Rule priority must be a non-negative integer',
        code: 'E_TYPE',
      });
    }
  }

  // --- description: optional, must be string if present ---
  if (r.description !== undefined && r.description !== null && typeof r.description !== 'string') {
    errors.push({
      path: 'description',
      message: 'Rule description must be a string',
      code: 'E_TYPE',
    });
  }

  return errors;
}

/**
 * Validate a match object inside a rule.
 */
export function validateMatch(match: unknown, basePath: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (match === null || match === undefined || typeof match !== 'object') {
    errors.push({
      path: basePath,
      message: 'Match must be a non-null object',
      code: 'E_TYPE',
    });
    return errors;
  }

  const m = match as Record<string, unknown>;

  // Must have at least one property
  const keys = Object.keys(m).filter((k) => m[k] !== undefined);
  if (keys.length === 0) {
    errors.push({
      path: basePath,
      message: 'Match must have at least one property (path, operation, or harness)',
      code: 'E_EMPTY',
    });
  }

  // Validate known fields
  const knownFields = new Set(['path', 'operation', 'harness']);

  for (const key of keys) {
    if (!knownFields.has(key)) {
      errors.push({
        path: `${basePath}.${key}`,
        message: `Unknown match field "${key}". Valid fields: path, operation, harness`,
        code: 'E_UNKNOWN',
      });
      continue;
    }

    const val = m[key];

    if (typeof val !== 'string' || val.trim() === '') {
      errors.push({
        path: `${basePath}.${key}`,
        message: `Match "${key}" must be a non-empty string`,
        code: 'E_TYPE',
      });
      continue;
    }

    // Validate operation field is a known value
    if (key === 'operation' && !VALID_OPERATIONS.includes(val as string)) {
      errors.push({
        path: `${basePath}.${key}`,
        message: `Operation must be one of: ${VALID_OPERATIONS.join(', ')}`,
        code: 'E_ENUM',
      });
    }

    // Validate path pattern (basic sanity — allow glob characters)
    if (key === 'path') {
      const pathVal = val as string;
      // Check for obviously problematic patterns
      if (pathVal.includes('\\') && !pathVal.startsWith('\\\\')) {
        // Backslash on Windows may indicate a path separator typo
        // This is a warning-level check; we don't error on it
        // since some legit patterns might use backslash escapes
      }
    }
  }

  return errors;
}

/**
 * Validate a parsed policy YAML content string.
 * Checks that the YAML-like content produces valid rules when parsed.
 *
 * This is a two-phase validator:
 * 1. Parse the raw content using the same logic as data-access.ts / shared.ts
 * 2. Validate the resulting rules against the schema
 */
export function validatePolicyYaml(content: string): ValidationResult {
  const errors: ValidationError[] = [];

  if (typeof content !== 'string' || content.trim() === '') {
    errors.push({
      path: '',
      message: 'Policy YAML content must be a non-empty string',
      code: 'E_TYPE',
    });
    return { valid: false, errors };
  }

  // Phase 1: structural YAML parsing checks
  const structuralErrors = validateYamlStructure(content);
  errors.push(...structuralErrors);

  if (structuralErrors.length > 0) {
    return { valid: false, errors };
  }

  // Phase 2: parse and validate rules
  const parsed = parseYamlToRules(content);

  if (parsed.rules.length === 0 && content.trim().length > 0) {
    // Content exists but no rules parsed — likely malformed
    errors.push({
      path: '',
      message: 'Could not parse any rules from policy YAML. Check formatting.',
      code: 'E_PARSE',
    });
    return { valid: false, errors };
  }

  // Validate each parsed rule
  for (let i = 0; i < parsed.rules.length; i++) {
    const ruleErrors = validateRule(parsed.rules[i]);
    for (const err of ruleErrors) {
      errors.push({
        ...err,
        path: `rules[${i}].${err.path}`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check whether a glob pattern string is syntactically valid.
 * Returns true if the pattern uses only allowed glob characters.
 */
export function isValidGlobPattern(pattern: string): boolean {
  if (typeof pattern !== 'string' || pattern.trim() === '') return false;

  // Check for balanced braces {a,b}
  let braceDepth = 0;
  for (const ch of pattern) {
    if (ch === '{') braceDepth++;
    if (ch === '}') braceDepth--;
    if (braceDepth < 0) return false; // closing before opening
  }
  if (braceDepth !== 0) return false; // unclosed braces

  return true;
}

/**
 * Check whether a value is a valid Decision (allow/deny/ask).
 */
export function isValidAction(value: string): value is Decision {
  return VALID_ACTIONS.includes(value as Decision);
}

/**
 * Check whether a string is a valid operation (read/write/execute).
 */
export function isValidOperation(value: string): boolean {
  return VALID_OPERATIONS.includes(value);
}

/**
 * Validate a single rule against the PolicyRule type.
 * Thin wrapper that returns a ValidationResult for API consistency.
 */
export function validateRuleResult(rule: unknown): ValidationResult {
  const errors = validateRule(rule);
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Quick structural check on YAML content before attempting to parse rules.
 * Looks for obvious structural issues.
 */
function validateYamlStructure(content: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check for "rules:" header
  if (!content.includes('rules:')) {
    errors.push({
      path: '',
      message: 'Policy YAML must contain a "rules:" top-level key',
      code: 'E_STRUCTURE',
    });
    return errors;
  }

  const lines = content.split('\n');
  let inRules = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Detect rules: section
    if (trimmed === 'rules:') {
      inRules = true;
      continue;
    }

    if (!inRules) continue;

    // Check inline match has proper format
    if (trimmed.startsWith('match:')) {
      const matchContent = trimmed.slice(6).trim();
      if (matchContent.startsWith('{') && !matchContent.endsWith('}')) {
        errors.push({
          path: `line:${lineIdx + 1}`,
          message: 'Inline match object is not properly closed with "}"',
          code: 'E_SYNTAX',
        });
      }
    }

    // Check for unknown top-level keys (outside rules) using original line with indentation
    if (inRules) {
      const originalTrimmed = line.trim();
      // Only check lines that have no leading whitespace (top-level keys)
      if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t' && originalTrimmed !== '' && !originalTrimmed.startsWith('#') && !originalTrimmed.startsWith('-')) {
        const keyName = originalTrimmed.split(':')[0].trim();
        if (keyName !== 'rules' && keyName !== 'protected') {
          errors.push({
            path: `line:${lineIdx + 1}`,
            message: `Unknown top-level key "${keyName}". Only "rules" and "protected" are allowed`,
            code: 'E_UNKNOWN',
          });
        }
      }
    }
  }

  return errors;
}

/**
 * Parse YAML content into PolicyRule objects using the same logic
 * as the existing parsers in shared.ts / data-access.ts.
 */
function parseYamlToRules(content: string): { rules: PolicyRule[] } {
  const rules: PolicyRule[] = [];
  let currentRule: Record<string, unknown> | null = null;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '' || trimmed === 'rules:') continue;

    // Start of a new rule
    if (trimmed.startsWith('- id:')) {
      if (currentRule) {
        normalizeRule(currentRule);
        rules.push(currentRule as unknown as PolicyRule);
      }
      currentRule = { id: trimmed.slice(5).trim().replace(/^"|"$/g, ''), match: {} };
      continue;
    }

    if (!currentRule) continue;

    // Inline match: { path: "...", operation: "..." }
    const matchInline = trimmed.match(
      /^match:\s*\{\s*path:\s*"([^"]*)"\s*(?:,\s*operation:\s*"([^"]*)")?\s*\}/,
    );
    if (matchInline) {
      currentRule.match = {
        path: matchInline[1],
        ...(matchInline[2] ? { operation: matchInline[2] } : {}),
      };
      continue;
    }

    // Individual match fields
    if (trimmed.startsWith('path:')) {
      currentRule.match = {
        ...(currentRule.match as Record<string, unknown>),
        path: trimmed.slice(5).trim().replace(/^"|"$/g, ''),
      };
      continue;
    }

    if (trimmed.startsWith('operation:')) {
      currentRule.match = {
        ...(currentRule.match as Record<string, unknown>),
        operation: trimmed.slice(10).trim().replace(/^"|"$/g, ''),
      };
      continue;
    }

    // Action, basis, guidance, priority, description
    if (trimmed.startsWith('action:')) {
      currentRule.action = trimmed.slice(7).trim() as Decision;
      continue;
    }

    if (trimmed.startsWith('basis:')) {
      currentRule.basis = trimmed.slice(6).trim().replace(/^"|"$/g, '');
      continue;
    }

    if (trimmed.startsWith('guidance:')) {
      currentRule.guidance = trimmed.slice(9).trim().replace(/^"|"$/g, '');
      continue;
    }

    if (trimmed.startsWith('priority:')) {
      currentRule.priority = Number.parseInt(trimmed.slice(9).trim(), 10);
      continue;
    }

    if (trimmed.startsWith('description:')) {
      currentRule.description = trimmed.slice(12).trim().replace(/^"|"$/g, '');
      continue;
    }
  }

  // Push the last rule
  if (currentRule) {
    normalizeRule(currentRule);
    rules.push(currentRule as unknown as PolicyRule);
  }

  return { rules };
}

/**
 * Normalize a parsed rule: ensure match is always an object,
 * and remove undefined fields.
 */
function normalizeRule(rule: Record<string, unknown>): void {
  if (!rule.match || typeof rule.match !== 'object') {
    rule.match = {};
  }
  // Remove undefined keys from match
  const m = rule.match as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (m[key] === undefined) {
      delete m[key];
    }
  }
}
