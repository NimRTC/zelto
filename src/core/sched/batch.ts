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
import { judgeTrace } from '../trace/index.js';

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
  /** 豁免理由原文；null 表示未豁免（空串/纯空白同样视为未豁免） */
  traceWaiver: string | null;
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

    // 追溯判据唯一真源：core/trace/judgment.ts —— 这里只做呈现翻译
    for (const v of judgeTrace({ trace: m.trace, waiver: m.traceWaiver }).violations) {
      add('error', v.code, v.message);
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

/** 亲和分组结果：每个切片至多属于一组，无命中为 null */
export interface AffinityPlan {
  /** sliceId → groupId（无命中为 null） */
  groups: Map<string, string | null>;
  /** 组列表：仅含两人以上的组，成员已按 id 排序 */
  affinityGroups: Array<{ groupId: string; members: string[]; reason: 'dep' | 'writes-prefix' | 'module' }>;
}

/**
 * 由亲和分组算出每片的组内前序（按执行序 = 组内 id 排序，ADR-024 §3.3）。
 *
 * 确定性纯函数：同输入必得同输出。无组（null）与组首片的前序为空数组。
 */
export function affinityPreviousOf(plan: AffinityPlan): Map<string, string[]> {
  const prev = new Map<string, string[]>();
  for (const [id, group] of plan.groups) {
    if (group === null) {
      prev.set(id, []);
    }
  }
  for (const g of plan.affinityGroups) {
    const ordered = [...g.members].sort((a, b) => a.localeCompare(b));
    for (let i = 0; i < ordered.length; i++) {
      prev.set(ordered[i], ordered.slice(0, i));
    }
  }
  // 兜底：groups 里有但上面没覆盖到的 id
  for (const id of plan.groups.keys()) {
    if (!prev.has(id)) prev.set(id, []);
  }
  return prev;
}

/**
 * 取写集的主亲和前缀（确定性）。
 *
 * 规则：把每条写集去掉 glob 段（`*` 之后全丢），取前两段目录
 * （如 `src/core/sched/engine.ts` → `src/core`）；整片的前缀取众数，
 * 票数相同取字典序最小，保证同输入同输出。无有效前缀返回 null。
 */
export function affinityPrefixOf(writes: string[]): string | null {
  const prefixes: string[] = [];
  for (const raw of writes) {
    const normalized = raw.replace(/\\/g, '/');
    if (!normalized) continue;
    // 去掉 glob 段
    const star = normalized.indexOf('*');
    const cut = star >= 0 ? normalized.slice(0, star) : normalized;
    const segs = cut.split('/').filter((s) => s.length > 0);
    if (segs.length === 0) continue;
    const prefix = segs.slice(0, 2).join('/');
    if (prefix) prefixes.push(prefix);
  }
  if (prefixes.length === 0) return null;
  const counts = new Map<string, number>();
  for (const p of prefixes) counts.set(p, (counts.get(p) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = -1;
  for (const [p, c] of counts) {
    if (c > bestCount || (c === bestCount && (best === null || p < best))) {
      best = p;
      bestCount = c;
    }
  }
  return best;
}

/**
 * 亲和分组（ADR-024，确定性纯计算）。
 *
 * 输入与排阶段相同：`{ id, writes }` + `deps` + 可选的切片→模块名映射。
 * 输出每片所属组（无命中为 null）。
 *
 * 分组优先级（按顺序命中即停的并查集合并）：
 * 1. 依赖链：B 的前置是 A 则同组
 * 2. 写集前缀：主亲和前缀相同则同组
 * 3. 设计模块：共享同一模块名则同组
 *
 * 全是字符串与集合运算，不调模型、不触网（C3）。同输入必得同分组。
 */
export function planAffinityGroups(
  members: WriteSetMember[],
  deps: Map<string, string[]>,
  moduleMap?: Map<string, string[]>,
): AffinityPlan {
  const ids = members.map((m) => m.id);
  const idSet = new Set(ids);
  const parent = new Map<string, string>();
  const reasonOf = new Map<string, 'dep' | 'writes-prefix' | 'module'>();

  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string, reason: 'dep' | 'writes-prefix' | 'module'): void => {
    if (!idSet.has(a) || !idSet.has(b) || a === b) return;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // 确定性：小 root 为新 root
    const [next, prev] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(prev, next);
    // 组内原因取首次合并原因（优先级已由调用顺序保证）
    if (!reasonOf.has(next)) reasonOf.set(next, reason);
  };
  for (const id of ids) parent.set(id, id);

  // 1. 依赖链
  for (const id of ids) {
    const list = deps.get(id) ?? [];
    for (const dep of list) {
      if (idSet.has(dep)) union(id, dep, 'dep');
    }
  }

  // 2. 写集前缀
  const byId = new Map(members.map((m) => [m.id, m]));
  const prefixBuckets = new Map<string, string[]>();
  for (const id of ids) {
    const prefix = affinityPrefixOf(byId.get(id)?.writes ?? []);
    if (!prefix) continue;
    const bucket = prefixBuckets.get(prefix) ?? [];
    bucket.push(id);
    prefixBuckets.set(prefix, bucket);
  }
  for (const bucket of prefixBuckets.values()) {
    const ordered = [...bucket].sort((a, b) => a.localeCompare(b));
    for (let i = 1; i < ordered.length; i++) union(ordered[0], ordered[i], 'writes-prefix');
  }

  // 3. 设计模块
  if (moduleMap) {
    const moduleBuckets = new Map<string, string[]>();
    for (const id of ids) {
      const mods = moduleMap.get(id) ?? [];
      for (const m of mods) {
        if (!m) continue;
        const bucket = moduleBuckets.get(m) ?? [];
        if (!bucket.includes(id)) bucket.push(id);
        moduleBuckets.set(m, bucket);
      }
    }
    for (const bucket of moduleBuckets.values()) {
      const ordered = [...bucket].sort((a, b) => a.localeCompare(b));
      for (let i = 1; i < ordered.length; i++) union(ordered[0], ordered[i], 'module');
    }
  }

  // 收敛：root → 成员
  const clusters = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const list = clusters.get(root) ?? [];
    list.push(id);
    clusters.set(root, list);
  }

  const groups = new Map<string, string | null>();
  const affinityGroups: AffinityPlan['affinityGroups'] = [];
  for (const [, membersOf] of clusters) {
    const ordered = [...membersOf].sort((a, b) => a.localeCompare(b));
    if (ordered.length < 2) {
      groups.set(ordered[0], null);
      continue;
    }
    const groupId = `affinity-${ordered[0]}`;
    for (const id of ordered) groups.set(id, groupId);
    // 原因：取该组首次合并原因，缺省按依赖→前缀→模块推断
    const root = find(ordered[0]);
    affinityGroups.push({
      groupId,
      members: ordered,
      reason: reasonOf.get(root) ?? 'writes-prefix',
    });
  }
  // 兜底：孤立 id（理论上不会漏）
  for (const id of ids) {
    if (!groups.has(id)) groups.set(id, null);
  }
  affinityGroups.sort((a, b) => a.groupId.localeCompare(b.groupId));

  return { groups, affinityGroups };
}

/**
 * 把一个执行阶段按亲和组切成串行轮次（ADR-024 §3.2）。
 *
 * 输入是已经排好的一个阶段（阶段内写集互不重叠、可并行）。
 * 输出是若干轮：同组切片分散到不同轮（串行），无组切片只在第 0 轮（与其余并行）。
 *
 * 切法（确定性）：
 * - 阶段内按 id 排序，保证同输入同输出
 * - 同一非空 groupId 的成员按 id 排序，分散到轮 0..k-1
 * - 无组（null）成员只进轮 0
 * - 轮内成员再按 id 排序
 *
 * 亲和只拆分、不合并：绝不把跨阶段的切片拉到同一轮（C4 验收标准 4）。
 * 无命中（全 null）时返回原阶段单轮，与 ADR-019 语义完全一致。
 */
export function splitPhaseByAffinity(
  phaseIds: string[],
  groups: Map<string, string | null>,
): string[][] {
  const ordered = [...phaseIds].sort((a, b) => a.localeCompare(b));
  if (ordered.length === 0) return [];

  const byGroup = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const id of ordered) {
    const g = groups.get(id) ?? null;
    if (g === null) {
      ungrouped.push(id);
    } else {
      const list = byGroup.get(g) ?? [];
      list.push(id);
      byGroup.set(g, list);
    }
  }

  if (byGroup.size === 0) return [ordered];

  let rounds = 1;
  for (const list of byGroup.values()) {
    if (list.length > rounds) rounds = list.length;
  }

  const result: string[][] = [];
  for (let r = 0; r < rounds; r++) {
    const round: string[] = [];
    if (r === 0) round.push(...ungrouped);
    for (const list of byGroup.values()) {
      if (r < list.length) round.push(list[r]);
    }
    round.sort((a, b) => a.localeCompare(b));
    if (round.length > 0) result.push(round);
  }
  return result;
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
