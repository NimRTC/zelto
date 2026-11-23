// Scheduler types — admission control and constraint distribution
// See docs/zelto-技术架构.md §8
// See docs/adr-012-parallel-coordination.md

import type { PolicyRule } from '../policy/types.js';
import type { GateFeedback } from '../gate/feedback.js';
import type { HumanFeedback } from '../review/human-feedback.js';
export type { GateFeedback } from '../gate/feedback.js';
export type { HumanFeedback } from '../review/human-feedback.js';
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
  /**
   * 门禁作用域（ADR-097）—— 这轮门禁会**验哪些用例**。
   *
   * **为什么需要**：ADR-045 让 agent 知道「门禁会跑哪条命令」，但命令是
   * **项目级**的（跑全部用例），而门禁实际会**按写集收窄**（ADR-097）。
   *
   * 不告诉 agent 的话，它会以为「门禁跑全量、我跑 3 个用例就行」——
   * 两边口径不一致。后果不是「门禁太严」，而是**门禁过了但 agent
   * 没验过它该验的**（或者反过来，agent 以为全量过了就收工）。
   *
   * 这是**事实陈述**，不是判定 —— agent 仍然可以跑别的命令，但要知道
   * 门禁会用哪一套。
   */
  gateScope?: GateScopeSummary;
  /**
   * 上一轮门禁/验收的失败反馈（ZD-013）。
   *
   * **为什么需要**：重跑的 agent 拿不到「上次为什么失败」——
   * 它只能看到规格、写集、门禁命令。上一轮已经做对的部分它不知道，
   * 上一轮错在哪它更不知道。于是它可能把对的东西改错。
   *
   * 这里放的是**原文**（门禁/验收的真实输出），不是人转述的版本 ——
   * 人转述会把关键细节转掉。
   */
  gateFeedback?: GateFeedback[];
  /**
   * 人审阅时提的意见（ADR-094 §5.2）。
   *
   * **为什么需要**：人被退回打回重跑时，说的「哪里不对」是这条追溯链上
   * **唯一不由工具生成的判断**。它不进上下文，agent 就只能从头再摸一遍，
   * 甚至可能把已经做对的东西改错。
   *
   * 与 `gateFeedback` 是同一条路的两个来源：那一个送「机器验失败」的
   * 证据（ZD-013），这一个送「人提意见」的原文。
   *
   * 这里是**原文**（ADR-094 D3）—— 人转述会把关键细节转掉。
   */
  humanFeedback?: HumanFeedback[];
}

/** 门禁命令摘要（只给 agent 看，不参与任何判定） */
export interface GateCommandSummary {
  name: string;
  run: string;
}

/**
 * 门禁作用域摘要（ADR-097）—— 只给 agent 看，不参与任何判定。
 *
 * `scoped` 为 false 时 `labels` 为空 —— 门禁跑全量。
 */
export interface GateScopeSummary {
  /** 这轮门禁是不是收窄跑的。 */
  scoped: boolean;
  /** 收窄到的作用域标签（CTest LABELS）。 */
  labels: string[];
  /** 为什么收窄 / 为什么没收窄。 */
  reason: string;
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
