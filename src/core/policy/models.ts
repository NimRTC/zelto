/**
 * models.ts — Policy rule data structures and factory methods
 *
 * C2: core/ does not depend on any SDK or adapters/
 * C3: core/policy/ is deterministic — no model calls, no network
 */

// ---------------------------------------------------------------------------
// Primitive types
// ---------------------------------------------------------------------------

/** Policy effect: allow, deny, or require */
export type PolicyEffect = 'allow' | 'deny' | 'require';

/** Glob pattern string used to match tool-call targets */
export type TargetPattern = string;

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

/** A single condition that a tool call must (not) match */
export interface Condition {
  /** The field of the tool call to inspect (e.g. "target", "args.command") */
  field: string;
  /** Comparison operator (e.g. "eq", "neq", "glob", "regex", "exists") */
  operator: string;
  /** Value to compare against */
  value: unknown;
}

/** Describes which tool calls this rule applies to */
export interface PolicyTarget {
  /** Glob pattern matching tool-call targets */
  pattern: TargetPattern;
  /** Optional qualifier for the pattern language (e.g. "glob", "regex") */
  patternType?: string;
}

/** A single policy rule */
export interface PolicyRule {
  /** Unique rule identifier */
  id: string;
  /** Effect when this rule matches */
  effect: PolicyEffect;
  /** Target specification */
  target: PolicyTarget;
  /** Optional list of conditions that further narrow matching */
  conditions?: Condition[];
  /** Human-readable description */
  description?: string;
  /** Optional slice identifier this rule belongs to */
  slice?: string;
  /** Optional tags for categorization */
  tags?: string[];
  /** Arbitrary constraints metadata */
  constraints?: Record<string, unknown>;
}

/** A named anchor point referenced by policy rules */
export interface PolicyAnchor {
  /** Anchor identifier */
  id: string;
  /** Anchor type (e.g. "path", "ref") */
  type: string;
  /** Anchor value */
  value: string;
  /** Optional description */
  description?: string;
}

/** Top-level policy document */
export interface PolicyDocument {
  /** Schema version */
  version: string;
  /** Ordered list of policy rules */
  rules: PolicyRule[];
  /** Optional named anchors */
  anchors?: PolicyAnchor[];
}

// ---------------------------------------------------------------------------
// Derived / runtime types
// ---------------------------------------------------------------------------

/** A rule after resolution — indicates whether it matched the current call */
export interface ResolvedRule extends PolicyRule {
  /** Whether this rule matched the evaluated tool call */
  matched: boolean;
  /** Per-condition match results (same order as conditions) */
  matchedConditions?: boolean[];
}

/** Result of evaluating a set of rules against a tool call */
export interface GateResult {
  /** Whether the tool call is allowed */
  allowed: boolean;
  /** All rules that were evaluated, with match results */
  matchedRules: ResolvedRule[];
  /** Any errors that occurred during evaluation */
  errors?: string[];
}

/** Options for gate evaluation */
export interface GateOptions {
  /** When true, unmatched calls are denied instead of allowed */
  strict?: boolean;
  /** Additional evaluation context */
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Factory methods
// ---------------------------------------------------------------------------

/**
 * Create a PolicyRule with sensible defaults.
 * Only `id` is required; all other fields fall back to safe defaults.
 */
export function createRule(overrides?: Partial<PolicyRule> & { id: string }): PolicyRule {
  return {
    effect: 'deny',
    target: { pattern: '**' },
    conditions: [],
    ...overrides,
  } as PolicyRule;
}

/**
 * Create a Condition with no defaults — all fields are required at the type
 * level, so this factory is primarily a convenience for tests.
 */
export function createCondition(field: string, operator: string, value: unknown): Condition {
  return { field, operator, value };
}

/**
 * Create a PolicyDocument with sensible defaults.
 */
export function createPolicyDocument(overrides?: Partial<PolicyDocument>): PolicyDocument {
  return {
    version: '1',
    rules: [],
    anchors: [],
    ...overrides,
  };
}

/**
 * Create a ResolvedRule from a PolicyRule, defaulting `matched` to false.
 */
export function resolveRule(rule: PolicyRule, matched = false): ResolvedRule {
  return {
    ...rule,
    matched,
    matchedConditions: rule.conditions?.map(() => false) ?? [],
  };
}

/**
 * Create a GateResult with sensible defaults.
 */
export function createGateResult(overrides?: Partial<GateResult>): GateResult {
  return {
    allowed: true,
    matchedRules: [],
    ...overrides,
  };
}
