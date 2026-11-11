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
  /** 亲和上下文（ADR-024）：只读建议，不参与任何判定 */
  affinity?: AffinityContext | null;
  /**
   * 门禁命令原文（ADR-045）。
   *
   * agent 必须用**同一套**命令验证自己的产物，否则门禁②会在 agent
   * 留下的现场上失败 —— 最典型的是 CMake 生成器不一致：agent 用
   * NMake/Ninja 配的 `build/`，门禁用 Visual Studio 再配一次，直接报
   * 「generator platform does not match the platform used previously」。
   *
   * 这是**事实陈述**，不是判定：agent 仍然可以跑别的命令，但要知道
   * 门禁会用哪一套。
   */
  gateCommands?: GateCommandSummary[];
}

/** 门禁命令摘要（只给 agent 看，不参与任何判定） */
export interface GateCommandSummary {
  name: string;
  run: string;
}

/** 亲和组前序切片的确定性摘要（只读文件与 git，不调模型） */
export interface AffinitySummary {
  sliceId: string;
  frozenHash: string | null;
  /** 合入 commit；未知为 null（只认已冻结与已合入，不读中间态） */
  commit: string | null;
  /** 确定性摘要文本：标题 + 写集 + 短哈希，不含 agent 会话记忆 */
  summary: string;
}

/** 注入约束包的亲和上下文 */
export interface AffinityContext {
  groupId: string;
  /** 组内排在本片之前的切片 id（按执行序） */
  previousSlices: string[];
  summaries: AffinitySummary[];
}
