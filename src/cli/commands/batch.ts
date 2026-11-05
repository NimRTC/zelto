// zelto batch — 批量开工前的准入审核
//
// 回答一个问题：「这批切片现在能不能一起开工、该怎么分阶段。」
//
// 与 `zelto run --parallel` 的分工：
//   - `zelto batch`   只查不跑 —— 审核准入、排依赖阶段、查写集/工件冲突
//   - `zelto run --parallel`  只跑不查 —— 直接开跑
//
// 判定逻辑全部在 `core/sched/batch.ts`（C3 确定性，不调模型、不触网）。
// 这里只负责把磁盘上的事实读出来喂给它，再把结论渲染成人能看的样子。
//
// C1: 不持有状态 —— 输入从切片文件读出，输出只是一份判定结论
// C3: 判定确定 —— 本命令不调模型、不触网
// C4: 只读命令不写事件 —— 与 `zelto depgraph` / `zelto artifact check` 一致
// C6: core/ 不依赖 adapters/ —— 本文件只 import core/ 与 Node 内置

import { reviewBatch, planExecutionPhases, evaluateBatchConflicts, groupIssues } from '../../core/sched/batch.js';
import type { BatchIssue, BatchMember } from '../../core/sched/batch.js';
import { readDependencies, readEffectiveWriteSet, readSliceFacts } from './batch-facts.js';
import { loadWholeGraphGuard, sliceGuardForWrites, sliceGuardIssue } from './arch-guard.js';
import { register } from './shared.js';

register('batch', async (args) => {
  const ids = args.filter((a) => !a.startsWith('--') && !a.includes('='));
  const asJson = args.includes('--json');

  if (ids.length === 0) {
    console.error('Usage: zelto batch <slice-id-1> [slice-id-2 ...] [--depends-on <id>=<dep>] [--json]');
    console.error('');
    console.error('审核这批切片能否一起开工，并按依赖关系排出执行阶段。');
    console.error('只查不跑 —— 实际执行用 `zelto run --parallel`。');
    return 1;
  }

  // ── 读事实 ────────────────────────────────────────────────────────────────
  const members: BatchMember[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    const facts = await readSliceFacts(id);
    if ('missing' in facts) missing.push(id);
    else members.push(facts);
  }

  if (missing.length > 0) {
    console.error(`Slice(s) not found: ${missing.join(', ')}`);
    return 1;
  }

  // 写集统一用「生效写集」——与执行器、运行时守卫用的是同一份
  for (const m of members) {
    m.writes = await readEffectiveWriteSet(m.id);
  }

  // ── 判定 ──────────────────────────────────────────────────────────────────
  const review = reviewBatch(members);
  const deps = await readDependencies(ids, args);

  // 阶段 = 依赖分层 + 写集冲突降级 —— 与执行器用的是同一份排法
  const plan = planExecutionPhases(members, deps);
  const phases = plan.cycle ? [] : plan.phases;
  const conflicts = evaluateBatchConflicts(members, phases);

  // ── 架构护栏（切片级：只看与本片写集相关的偏离，ADR-027 Q2）──────
  // 整图只扫一次，逐片按写集过滤。无关模块的漂移不拦干净切片。
  // 无确认设计时跳过（老项目无感）。batch 是只读命令，不写事件。
  const archIssues: BatchIssue[] = [];
  const archCtx = await loadWholeGraphGuard();
  if (archCtx) {
    for (const m of members) {
      const { verdict } = sliceGuardForWrites(archCtx, m.writes);
      const issue = sliceGuardIssue(m.id, verdict);
      if (issue) archIssues.push(issue);
    }
  }

  const allIssues: BatchIssue[] = [...review.issues, ...conflicts, ...archIssues];
  if (plan.cycle) {
    allIssues.push({
      sliceId: null,
      severity: 'error',
      code: 'dependency_cycle',
      message: `循环依赖：${plan.cycle.join(' → ')}`,
    });
  }
  const { errors, warnings } = groupIssues(allIssues);

  const ready = review.ready && plan.cycle === null && errors.length === 0;

  if (asJson) {
    console.log(JSON.stringify({
      slices: ids,
      ready,
      review: {
        ready: review.ready,
        errorCount: review.errorCount,
        warningCount: review.warningCount,
        issues: review.issues,
      },
      phases,
      cycle: plan.cycle,
      downgrades: plan.downgrades,
      conflicts,
      issues: allIssues,
      errorCount: errors.length,
      warningCount: warnings.length,
    }, null, 2));
    return ready ? 0 : 1;
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  console.log(`zelto batch — 审核 ${ids.length} 个切片`);
  console.log('');

  console.log('准入检查：');
  for (const m of members) {
    const sliceIssues = allIssues.filter((i) => i.sliceId === m.id);
    const errs = sliceIssues.filter((i) => i.severity === 'error');
    const warns = sliceIssues.filter((i) => i.severity === 'warning');
    const icon = errs.length > 0 ? '❌' : warns.length > 0 ? '⚠️ ' : '✅';
    console.log(`  ${icon} ${m.id} — ${m.state}`);
    for (const i of errs) console.log(`       ❌ ${i.message}`);
    for (const i of warns) console.log(`       ⚠️  ${i.message}`);
  }

  console.log('');
  if (plan.cycle) {
    console.log(`执行阶段：❌ 依赖成环 —— ${plan.cycle.join(' → ')}`);
    console.log('         环里的切片没法排先后，必须先解开依赖。');
  } else {
    console.log(`执行阶段：${phases.length} 个`);
    for (let p = 0; p < phases.length; p++) {
      const parallel = phases[p].length > 1 ? `（${phases[p].length} 个并行）` : '（单独跑）';
      console.log(`  Phase ${p + 1}: ${phases[p].join(', ')} ${parallel}`);
    }
    for (const d of plan.downgrades) {
      console.log(`  ⚠️  ${d.sliceId} 与 ${d.conflictsWith.join(', ')} 写集重叠 —— 已降级为串行`);
    }
  }

  if (conflicts.length > 0) {
    console.log('');
    console.log('同阶段冲突：');
    for (const c of conflicts) {
      const icon = c.severity === 'error' ? '❌' : '⚠️ ';
      console.log(`  ${icon} ${c.message}`);
    }
  }

  console.log('');
  if (ready) {
    console.log('结论：✅ 这批切片可以一起开工');
    console.log(`      阶段内并行，阶段之间串行。接着跑：zelto run --parallel ${ids.join(' ')}`);
  } else {
    console.log(`结论：❌ 还不能开工（${errors.length} 个阻断项）`);
    console.log('      修掉上面标 ❌ 的问题后重跑 zelto batch。');
  }

  return ready ? 0 : 1;
});
