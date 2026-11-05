// 执行计划构建 —— 「这批切片该怎么跑」的单一入口
//
// `zelto version start` 与 `zelto run --parallel` 都要先把切片排成阶段，
// 再按阶段顺序执行。排法只有一份（core/sched/batch.ts 的 planExecutionPhases），
// 读事实也只有一份（./batch-facts.ts）—— 两处各排一次，早晚得出不同结论。
//
// 排法（G-1 + G-2）：
// 1. 依赖分层：依赖来自规格「前置切片」章节（真源），CLI --depends-on 可覆盖
// 2. 写集降级：同层里写集重叠的切片自动拆成先后两个阶段，不整批 abort
//
// C3: 排阶段是确定性计算（不调模型、不触网）
// C1: 状态只在文件里——这里只读文件、只产出计划

import { affinityPreviousOf, planAffinityGroups, planExecutionPhases, splitPhaseByAffinity } from '../../core/sched/batch.js';
import type { AffinityPlan, PhaseDowngrade } from '../../core/sched/batch.js';
import { readDependencies, readEffectiveWriteSet, readModuleMap } from './batch-facts.js';

export interface ExecutionPlan {
  /** 阶段序列：阶段内可并行，阶段之间串行（已含亲和串行切分） */
  phases: string[][];
  /** 依赖成环时的环路径；无环为 null */
  cycle: string[] | null;
  /** 因写集冲突被降级为串行的切片 */
  downgrades: PhaseDowngrade[];
  /** 亲和分组（ADR-024）：sliceId → groupId，无命中为 null（全局组，用于上下文与追溯） */
  affinity: Map<string, string | null>;
  /** 亲和组列表：仅含两人以上的组 */
  affinityGroups: AffinityPlan['affinityGroups'];
  /** 每片的组内前序（按执行序 = 组内 id 排序）；无组与组首为空数组 */
  affinityPrevious: Map<string, string[]>;
}

/**
 * 为这批切片排出执行阶段。
 *
 * 排法（G-1 + G-2 + ADR-024）：
 * 1. 依赖分层 + 写集降级（planExecutionPhases，不变）
 * 2. 亲和分组（planAffinityGroups）：只改变同阶段内「谁先谁后」，
 *    不改变阶段划分；同组切片在阶段内按 splitPhaseByAffinity 切成串行轮次
 *
 * @param ids 要执行的切片 id
 * @param cliArgs 命令行参数（用于读 --depends-on 覆盖）
 */
export async function buildExecutionPlan(
  ids: string[],
  cliArgs: string[] = [],
): Promise<ExecutionPlan> {
  // 依赖：规格「前置切片」章节 + 命令行覆盖
  const deps = await readDependencies(ids, cliArgs);

  // 写集必须是「生效写集」——与运行时守卫（ADR-014）用的是同一份
  const members = await Promise.all(
    ids.map(async (id) => ({ id, writes: await readEffectiveWriteSet(id) })),
  );

  const plan = planExecutionPhases(members, deps);

  if (plan.cycle) {
    return {
      phases: [],
      cycle: plan.cycle,
      downgrades: [],
      affinity: new Map(ids.map((id) => [id, null])),
      affinityGroups: [],
      affinityPrevious: new Map(ids.map((id) => [id, []])),
    };
  }

  // 亲和分组：依赖链 → 写集前缀 → 设计模块（确定性，不调模型）
  const moduleMap = await readModuleMap(ids);
  const affinityPlan = planAffinityGroups(members, deps, moduleMap);

  // 亲和只在同一执行阶段内排序：同组切片切成串行轮次，其余仍可并行。
  // 阶段划分本身不变（ADR-019 §3.3 不变）。
  const phases: string[][] = [];
  for (const phase of plan.phases) {
    const rounds = splitPhaseByAffinity(phase, affinityPlan.groups);
    phases.push(...rounds);
  }

  return {
    phases,
    cycle: null,
    downgrades: plan.downgrades,
    affinity: affinityPlan.groups,
    affinityGroups: affinityPlan.affinityGroups,
    affinityPrevious: affinityPreviousOf(affinityPlan),
  };
}

/**
 * 把执行计划打印给人看。
 *
 * 为什么要让人看见：并行度是 zelto 最核心的价值主张，
 * 但「哪些切片被串行化了、为什么」必须摊开——否则「高速」变成了不可解释的黑箱。
 */
export function printExecutionPlan(plan: ExecutionPlan): void {
  console.log('执行计划：');

  if (plan.cycle) {
    console.log(`  ❌ 依赖成环：${plan.cycle.join(' → ')}`);
    console.log('     环里的切片没法排先后，先解开依赖再跑。');
    return;
  }

  for (let p = 0; p < plan.phases.length; p++) {
    const phase = plan.phases[p];
    const parallel = phase.length > 1 ? `（${phase.length} 个并行）` : '（单独跑）';
    console.log(`  阶段 ${p + 1}: ${phase.join(', ')} ${parallel}`);
  }

  for (const d of plan.downgrades) {
    console.log(
      `  ⚠️  ${d.sliceId} 与 ${d.conflictsWith.join(', ')} 写集重叠 —— 已降级为串行`,
    );
  }

  if (plan.affinityGroups.length > 0) {
    const reasonLabel: Record<string, string> = {
      dep: '依赖链',
      'writes-prefix': '同写集前缀',
      module: '同设计模块',
    };
    for (const g of plan.affinityGroups) {
      console.log(
        `  🧲 亲和组 ${g.groupId}（${reasonLabel[g.reason] ?? g.reason}）：${g.members.join(' → ')} —— 组内串行`,
      );
    }
  }
}
