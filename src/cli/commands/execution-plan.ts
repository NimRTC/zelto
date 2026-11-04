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

import { planExecutionPhases } from '../../core/sched/batch.js';
import type { PhaseDowngrade } from '../../core/sched/batch.js';
import { readDependencies, readEffectiveWriteSet } from './batch-facts.js';

export interface ExecutionPlan {
  /** 阶段序列：阶段内可并行，阶段之间串行 */
  phases: string[][];
  /** 依赖成环时的环路径；无环为 null */
  cycle: string[] | null;
  /** 因写集冲突被降级为串行的切片 */
  downgrades: PhaseDowngrade[];
}

/**
 * 为这批切片排出执行阶段。
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

  return {
    phases: plan.phases,
    cycle: plan.cycle,
    downgrades: plan.downgrades,
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
}
