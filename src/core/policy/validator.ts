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

import type { ArchGuardRule, PolicyConfig, Decision } from './types.js';
import { parsePolicyYaml } from './yaml.js';

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
  /**
   * 警告 —— 「不致命但人该知道」的事。
   *
   * 为什么要有这一档：`anchors:` 段在 ADR-039 之前把策略哈希锚点写在
   * 策略自己体内（自证）。ADR-039 把锚点外部化到 `policy/lock.json`，
   * 但**没有**处置老项目里已经存在的 `anchors:` 段 ——
   * 校验器把它当「未知顶层键」直接判红，于是老项目一接管就
   * `policy validate` FAILED，接管路径整体走不通。
   *
   * 正确处置是「认它、忽略它、报出来」：它不参与任何判定
   * （锚点真源在 lock.json），但人该知道策略里还留着这么一段。
   */
  warnings?: ValidationError[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ACTIONS: readonly Decision[] = ['allow', 'deny', 'ask'];

const VALID_OPERATIONS: readonly string[] = ['read', 'write', 'execute'];

/** ADR-027: 可配的六类硬偏离（软偏离 unverifiable_dependency 不可配） */
const VALID_ARCH_KINDS: readonly string[] = [
  'missing_dependency',
  'undeclared_dependency',
  'ambiguous_module',
  'unmapped_file',
  'unknown_module',
  'cycle',
];

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

  // Validate arch (optional, ADR-027)
  if (config.arch !== undefined) {
    if (!Array.isArray(config.arch)) {
      errors.push({
        path: 'arch',
        message: '"arch" must be an array of guard rules',
        code: 'E_TYPE',
      });
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < (config.arch as unknown[]).length; i++) {
        const item = (config.arch as unknown[])[i];
        const itemErrors = validateArchGuardRule(item);
        for (const err of itemErrors) {
          errors.push({
            ...err,
            path: `arch[${i}].${err.path}`,
          });
        }
        // 去重：kind 重复即错误
        if (
          item !== null &&
          typeof item === 'object' &&
          typeof (item as Record<string, unknown>).kind === 'string'
        ) {
          const kind = (item as Record<string, unknown>).kind as string;
          if (VALID_ARCH_KINDS.includes(kind)) {
            if (seen.has(kind)) {
              errors.push({
                path: `arch[${i}].kind`,
                message: `Duplicate arch kind "${kind}"`,
                code: 'E_DUPLICATE',
              });
            } else {
              seen.add(kind);
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a single arch guard rule (ADR-027).
 * Returns errors scoped to the rule's own fields (no "arch[N]." prefix).
 */
export function validateArchGuardRule(rule: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (rule === null || rule === undefined || typeof rule !== 'object') {
    errors.push({
      path: '',
      message: 'Arch guard rule must be a non-null object',
      code: 'E_TYPE',
    });
    return errors;
  }

  const r = rule as Record<string, unknown>;

  // --- kind: required, must be one of the six hard kinds ---
  if (r.kind === undefined || r.kind === null) {
    errors.push({
      path: 'kind',
      message: 'Arch guard kind is required',
      code: 'E_REQUIRED',
    });
  } else if (typeof r.kind !== 'string' || !VALID_ARCH_KINDS.includes(r.kind)) {
    errors.push({
      path: 'kind',
      message: `Arch guard kind must be one of: ${VALID_ARCH_KINDS.join(', ')}`,
      code: 'E_ENUM',
    });
  }

  // --- action: required, valid enum ---
  if (r.action === undefined || r.action === null) {
    errors.push({
      path: 'action',
      message: 'Arch guard action is required',
      code: 'E_REQUIRED',
    });
  } else if (typeof r.action !== 'string' || !VALID_ACTIONS.includes(r.action as Decision)) {
    errors.push({
      path: 'action',
      message: `Arch guard action must be one of: ${VALID_ACTIONS.join(', ')}`,
      code: 'E_ENUM',
    });
  }

  // --- basis: required, non-empty ---
  if (r.basis === undefined || r.basis === null) {
    errors.push({
      path: 'basis',
      message: 'Arch guard basis is required',
      code: 'E_REQUIRED',
    });
  } else if (typeof r.basis !== 'string' || (r.basis as string).trim() === '') {
    errors.push({
      path: 'basis',
      message: 'Arch guard basis must be a non-empty string',
      code: 'E_TYPE',
    });
  }

  // --- guidance: optional, must be string if present ---
  if (r.guidance !== undefined && r.guidance !== null && typeof r.guidance !== 'string') {
    errors.push({
      path: 'guidance',
      message: 'Arch guard guidance must be a string',
      code: 'E_TYPE',
    });
  }

  return errors;
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
 * 1. Structural checks (top-level keys, inline match syntax)
 * 2. Parse with the single parser (core/policy/yaml.ts) and validate rules + arch
 */
export function validatePolicyYaml(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  if (typeof content !== 'string' || content.trim() === '') {
    errors.push({
      path: '',
      message: 'Policy YAML content must be a non-empty string',
      code: 'E_TYPE',
    });
    return { valid: false, errors };
  }

  // Phase 1: structural YAML parsing checks
  const structural = validateYamlStructure(content);
  errors.push(...structural.errors);
  warnings.push(...structural.warnings);

  if (structural.errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Phase 2: parse with the single parser and validate rules + arch
  const parsed = parsePolicyYaml(content);

  if (parsed.rules.length === 0 && content.trim().length > 0) {
    // Content exists but no rules parsed — likely malformed
    errors.push({
      path: '',
      message: 'Could not parse any rules from policy YAML. Check formatting.',
      code: 'E_PARSE',
    });
    return { valid: false, errors, warnings };
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

  // Validate each parsed arch guard rule (incl. duplicate kind)
  if (parsed.arch) {
    const seen = new Set<string>();
    for (let i = 0; i < parsed.arch.length; i++) {
      const itemErrors = validateArchGuardRule(parsed.arch[i]);
      for (const err of itemErrors) {
        errors.push({
          ...err,
          path: `arch[${i}].${err.path}`,
        });
      }
      const kind = (parsed.arch[i] as ArchGuardRule).kind;
      if (seen.has(kind)) {
        errors.push({
          path: `arch[${i}].kind`,
          message: `Duplicate arch kind "${kind}"`,
          code: 'E_DUPLICATE',
        });
      } else {
        seen.add(kind);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
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
 *
 * 返回 `{errors, warnings}` 两档：
 *   - **错误**：策略文件本身不合法（`validate` 退出码 1）；
 *   - **警告**：不致命但人该知道（`validate` 仍退出 0，但会报出来）。
 */
function validateYamlStructure(content: string): { errors: ValidationError[]; warnings: ValidationError[] } {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  // Check for "rules:" header
  if (!content.includes('rules:')) {
    errors.push({
      path: '',
      message: 'Policy YAML must contain a "rules:" top-level key',
      code: 'E_STRUCTURE',
    });
    return { errors, warnings };
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
        if (keyName === 'anchors') {
          // 老版本（ADR-039 之前）把策略哈希锚点写在策略自己体内。
          // 锚点已外部化到 policy/lock.json，这一段现在**不参与任何判定**。
          // 但它不该让整份策略判红 —— 否则老项目一接管就 validate FAILED，
          // 接管路径整体走不通。认它、忽略它、报出来（ADR-040 §3.3）。
          warnings.push({
            path: `line:${lineIdx + 1}`,
            message: 'Deprecated "anchors" section — the policy hash anchor now lives in policy/lock.json; this section is ignored',
            code: 'W_DEPRECATED_ANCHORS',
          });
        } else if (keyName !== 'rules' && keyName !== 'protected' && keyName !== 'arch') {
          errors.push({
            path: `line:${lineIdx + 1}`,
            message: `Unknown top-level key "${keyName}". Only "rules", "protected" and "arch" are allowed`,
            code: 'E_UNKNOWN',
          });
        }
      }
    }
  }

  return { errors, warnings };
}
