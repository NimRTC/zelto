// Scheduler types — admission control and constraint distribution
// See docs/zelto-技术架构.md §8
// See docs/adr-012-parallel-coordination.md

import type { PolicyRule } from '../policy/types.js';
export type { DepGraphNode, CycleInfo } from './depgraph.js';
export type { ArtifactMapping, ArtifactConflict, ArtifactCategory, ConflictSeverity } from './artifact.js';
export type { MergeStrategy, MergePhase, MergeConflict, MergePlan } from './merge.js';

export type SchedDecision = 'admitted' | 'blocked' | 'queued';

export interface SchedResult {
  sliceId: string;
  decision: SchedDecision;
  reason: string | null;
  blockedBy: string[];
}

export interface SchedBlock {
  sliceId: string;
  blockedBy: string[];
  blockedAt: string;
  reason: string;
}

export interface ConstraintBundle {
  sliceId: string;
  specPath: string;
  frozenHash: string | null;
  acceptanceDir: string;
  writes: string[];
  protectedPaths: string[];
  policyRules: PolicyRule[];
  instructions: string;
}
