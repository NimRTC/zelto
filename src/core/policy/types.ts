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
}

export interface Anchor {
  hash: string;
  commit: string;
  lockedAt: string;
  lockedBy: string;
}
