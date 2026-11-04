// Batch review — 批量开发的准入判定
//
// 「先审核、后批量开发」的判定核心：给定一组切片的静态事实，
// 回答「这批切片现在能不能一起开工、该怎么分阶段」。
//
// C3: 全部是确定性计算，不调模型、不触网
// C6: core/ 内，不依赖 adapters/
// C1: 不持有状态——输入由调用方从文件读出，输出只是一份判定结论
//
// 见 docs/adr-012-parallel-coordination.md §3.2 / §3.3

import { detectArtifactConflicts } from './artifact.js';
import { DependencyGraph } from './depgraph.js';
import { writeSetsOverlap } from './paths.js';

/** 问题严重程度 */
export type BatchSeverity = 'error' | 'warning';

/**
 * 一条审核问题。
 *
 * `sliceId` 为 null 表示批次级问题（例如整个批次的依赖成环）。
 */
export interface BatchIssue {
  sliceId: string | null;
  severity: BatchSeverity;
  code: string;
  message: string;
}

/**
 * 单个切片的审核输入——全部由调用方从文件读出后传入。
 *
 * 这里刻意用「事实」而不是「对象」，让判定逻辑与文件布局解耦。
 */
export interface BatchMember {
  id: string;
  /** 切片当前状态 */
  state: string;
  /** 写集 */
  writes: string[];
  /** 规格是否已冻结（有 frozenHash） */
  specFrozen: boolean;
  /** 规格当前内容是否已偏离冻结时的哈希 */
  specDrift: boolean;
  /** 追溯信息条数 */
  trace: {
    requirements: number;
    contracts: number;
    tests: number;
  };
  /** 是否豁免了「必须引用契约」的要求 */
  traceWaiver: boolean;
  /** 验收测试目录是否存在 */
  acceptancePresent: boolean;
  /** 预算是否已耗尽 */
  budgetExhausted: boolean;
}

/** 审核结论 */
export interface BatchReview {
  /** 没有 error 级问题即为 true */
  ready: boolean;
  slices: string[];
  issues: BatchIssue[];
  errorCount: number;
  warningCount: number;
}

/** 分阶段计划 */
export interface BatchPhasePlan {
  /** 每个阶段内的切片（阶段内可并行） */
  phases: string[][];
  /** 成环时的环路径；无环为 null */
  cycle: string[] | null;
  issues: BatchIssue[];
}

/** 批次评审的合法状态 */
const RUNNABLE_STATES = new Set(['frozen', 'completed']);

/**
 * 审核一批切片是否可以批量开工。
 *
 * 每个切片必须满足：
 * 1. 状态是 frozen（已审核冻结）或 completed
 * 2. 规格已冻结
 * 3. 规格未漂移
 * 4. 追溯到需求
 * 5. 追溯到契约（除非有豁免）
 * 6. 追溯到测试
 * 7. 验收测试目录存在
 * 8. 写集非空
 * 9. 预算未耗尽
 */
export function reviewBatch(members: BatchMember[]): BatchReview {
  const issues: BatchIssue[] = [];

  for (const m of members) {
    const add = (severity: BatchSeverity, code: string, message: string): void => {
      issues.push({ sliceId: m.id, severity, code, message });
    };

    if (!RUNNABLE_STATES.has(m.state)) {
      add('error', 'state_not_frozen',
        `切片状态是 "${m.state}"，批量开发要求 "frozen"（已审核冻结）或 "completed"`);
    }

    if (!m.specFrozen) {
      add('error', 'spec_not_frozen', '规格未冻结（没有 frozenHash），不能开工');
    }

    if (m.specDrift) {
      add('error', 'spec_drift', '规格内容已偏离冻结时的哈希，需重新冻结');
    }

    if (m.trace.requirements === 0) {
      add('error', 'no_requirements', '追溯信息里没有需求引用，无法证明代码出处');
    }

    if (m.trace.contracts === 0 && !m.traceWaiver) {
      add('error', 'no_contracts', '追溯信息里没有契约引用（也没有豁免记录）');
    }

    if (m.trace.tests === 0) {
      add('error', 'no_tests', '追溯信息里没有测试引用，无法验证');
    }

    if (!m.acceptancePresent) {
      add('error', 'acceptance_missing', '验收测试目录不存在，无法验证');
    }

    if (m.writes.length === 0) {
      add('error', 'no_write_set', '写集为空，无法判定边界');
    }

    if (m.budgetExhausted) {
      add('error', 'budget_exhausted', '预算已耗尽');
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;

  return {
    ready: errorCount === 0,
    slices: members.map((m) => m.id),
    issues,
    errorCount,
    warningCount,
  };
}

/**
 * 按依赖关系把切片排成阶段。
 *
 * 阶段内可并行，阶段之间必须串行——后面的切片要看到前面切片的产物。
 */
export function planBatchPhases(
  ids: string[],
  deps: Map<string, string[]>,
): BatchPhasePlan {
  const graph = new DependencyGraph();
  for (const id of ids) {
    graph.addNode(id, deps.get(id) ?? []);
  }

  const cycle = graph.checkCycles();
  if (cycle) {
    return {
      phases: [],
      cycle: cycle.cycle,
      issues: [{
        sliceId: null,
        severity: 'error',
        code: 'dependency_cycle',
        message: `循环依赖：${cycle.cycle.join(' → ')}`,
      }],
    };
  }

  return { phases: graph.phasesFromDeps(), cycle: null, issues: [] };
}

/**
 * 因写集冲突被降级为串行的记录。
 *
 * 「降级」= 原本可以同阶段并行，因为写集重叠被排到了更靠后的阶段。
 */
export interface PhaseDowngrade {
  sliceId: string;
  /** 与它写集重叠、因此它必须让路的切片 */
  conflictsWith: string[];
}

/** 执行阶段计划（依赖分层 + 写集冲突降级） */
export interface ExecutionPhasePlan {
  /** 阶段序列：阶段内互不冲突可并行，阶段之间串行 */
  phases: string[][];
  /** 依赖成环时的环路径；无环为 null */
  cycle: string[] | null;
  /** 被降级为串行的切片 */
  downgrades: PhaseDowngrade[];
}

/**
 * 排阶段只需要「id + 写集」——写集是唯一影响能否并行的字段。
 */
export interface WriteSetMember {
  id: string;
  writes: string[];
}

/**
 * 排出「可以直接开跑」的执行阶段。
 *
 * 两步判定，都是确定性的：
 * 1. 依赖分层：按 `deps` 拓扑分层，阶段之间串行（G-1）
 * 2. 写集降级：同一层里写集重叠的切片自动拆开，排成先后两个阶段（G-2）
 *
 * 降级用贪心着色：按 id 排序依次放切片，放进第一个与已有切片都不冲突的
 * 阶段；都冲突就新开一个阶段。id 排序保证同一批输入永远得到同一份计划。
 *
 * 注意：跨阶段的写集重叠不处理——阶段之间本来就允许改同一批文件，
 * 那正是依赖关系的含义。
 */
export function planExecutionPhases(
  members: WriteSetMember[],
  deps: Map<string, string[]>,
): ExecutionPhasePlan {
  const ids = members.map((m) => m.id);
  const depPlan = planBatchPhases(ids, deps);

  if (depPlan.cycle) {
    return { phases: [], cycle: depPlan.cycle, downgrades: [] };
  }

  const byId = new Map(members.map((m) => [m.id, m]));
  const phases: string[][] = [];
  const downgrades: PhaseDowngrade[] = [];

  for (const depPhase of depPlan.phases) {
    // 依赖层内按 id 排序 —— 贪心着色的结果必须与输入顺序无关
    const ordered = [...depPhase].sort((a, b) => a.localeCompare(b));

    // 每个子阶段内部的成员
    const groups: string[][] = [];

    for (const id of ordered) {
      const member = byId.get(id);
      const writes = member?.writes ?? [];

      let placed = false;
      for (let g = 0; g < groups.length; g++) {
        const conflicting = groups[g].filter((otherId) => {
          const other = byId.get(otherId);
          return other ? writeSetsOverlap(writes, other.writes) : false;
        });

        if (conflicting.length === 0) {
          groups[g].push(id);
          placed = true;
          break;
        }

        // 放不进这一组 —— 记下降级（与这一组里冲突的切片）
        const existing = downgrades.find((d) => d.sliceId === id);
        if (existing) {
          for (const c of conflicting) {
            if (!existing.conflictsWith.includes(c)) existing.conflictsWith.push(c);
          }
        } else {
          downgrades.push({ sliceId: id, conflictsWith: [...conflicting] });
        }
      }

      if (!placed) {
        groups.push([id]);
      }
    }

    phases.push(...groups);
  }

  return { phases, cycle: null, downgrades };
}

/**
 * 检查同一阶段内的切片是否可以并行。
 *
 * 同阶段意味着同时开工，因此：
 * - 写集重叠 → error（两个 agent 会同时改同一批文件）
 * - 工件冲突 → 按工件类别分级（error / warning / info）
 *
 * 跨阶段不做检查——阶段之间本来就允许改同一批文件（那正是依赖的含义）。
 */
export function evaluateBatchConflicts(
  members: BatchMember[],
  phases: string[][],
): BatchIssue[] {
  const issues: BatchIssue[] = [];
  const byId = new Map(members.map((m) => [m.id, m]));

  for (let p = 0; p < phases.length; p++) {
    const phaseSlices = phases[p];

    // 写集重叠
    for (let i = 0; i < phaseSlices.length; i++) {
      for (let j = i + 1; j < phaseSlices.length; j++) {
        const a = byId.get(phaseSlices[i]);
        const b = byId.get(phaseSlices[j]);
        if (!a || !b) continue;
        if (writeSetsOverlap(a.writes, b.writes)) {
          issues.push({
            sliceId: null,
            severity: 'error',
            code: 'write_set_overlap',
            message:
              `Phase ${p}: "${a.id}" 与 "${b.id}" 写集重叠，不能并行开工` +
              `（A: ${a.writes.join(', ')} / B: ${b.writes.join(', ')}）`,
          });
        }
      }
    }

    // 工件冲突
    const pairs = phaseSlices.map((id) => {
      const m = byId.get(id);
      return [id, m?.writes ?? []] as [string, string[]];
    });
    for (const c of detectArtifactConflicts(pairs)) {
      if (c.severity === 'info') continue; // info 只做提示，不进问题列表
      issues.push({
        sliceId: null,
        severity: c.severity === 'error' ? 'error' : 'warning',
        code: 'artifact_conflict',
        message: `Phase ${p}: ${c.description}`,
      });
    }
  }

  return issues;
}

/**
 * 把审核问题整理成给人看的分组。
 */
export function groupIssues(issues: BatchIssue[]): {
  errors: BatchIssue[];
  warnings: BatchIssue[];
} {
  return {
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}
