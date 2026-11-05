// Policy engine — deterministic permission decision
// See docs/zelto-场景功能地图.md §附录C

export type Decision = 'allow' | 'deny' | 'ask';

export interface PolicyDecision {
  decision: Decision;
  ruleId: string | null;
  basis: string;
  guidance: string | null;
  policyVersion: string;
}

export interface PolicyRule {
  id: string;
  description?: string;
  match: {
    path?: string;
    operation?: string;
    harness?: string;
  };
  action: Decision;
  basis: string;
  guidance?: string;
  priority?: number;
}

export interface PolicyConfig {
  rules: PolicyRule[];
  protected: string[];
  arch?: ArchGuardRule[];
}

/** 架构护栏可配的硬偏离种类（软偏离 unverifiable_dependency 不可配） */
export type ArchDeviationKind =
  | 'missing_dependency'
  | 'undeclared_dependency'
  | 'ambiguous_module'
  | 'unmapped_file'
  | 'unknown_module'
  | 'cycle';

/** policy.yaml `arch:` 段的一条护栏规则 */
export interface ArchGuardRule {
  kind: ArchDeviationKind;
  action: Decision;
  basis: string;
  guidance?: string;
}

export interface Anchor {
  hash: string;
  commit: string;
  lockedAt: string;
  lockedBy: string;
}
