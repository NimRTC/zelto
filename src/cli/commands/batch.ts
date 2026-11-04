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

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { reviewBatch, planBatchPhases, evaluateBatchConflicts, groupIssues } from '../../core/sched/batch.js';
import type { BatchIssue, BatchMember } from '../../core/sched/batch.js';
import { parseDependsOnArgs } from '../../core/sched/depgraph.js';
import { parsePrerequisites, parseScopePaths } from '../../core/spec/scope.js';
import { BudgetCollector } from '../../core/budget/collector.js';
import { register, store, events, ZELTO_DIR, hashSpecFile } from './shared.js';

/**
 * 从切片文件里读出审核需要的事实。
 *
 * 刻意只取「事实」而不是把整个 SliceData 传下去 —— core/sched/batch.ts
 * 不应该知道切片文件的字段布局。
 */
async function readFacts(id: string): Promise<BatchMember | { missing: true }> {
  let slice;
  try {
    slice = await store.read(id);
  } catch {
    return { missing: true };
  }

  // 写集为空时，从规格「范围」章节解析（不写回文件——只读命令不改状态）
  let writes = slice.writes;
  if (writes.length === 0 && slice.spec.path && existsSync(slice.spec.path)) {
    try {
      const content = await readFile(slice.spec.path, 'utf-8');
      writes = parseScopePaths(content);
    } catch {
      writes = [];
    }
  }

  // 规格漂移：冻结时的哈希与当前文件内容不一致
  let specDrift = slice.drift.detected;
  if (!specDrift && slice.spec.frozenHash && slice.spec.path && existsSync(slice.spec.path)) {
    try {
      const current = hashSpecFile(slice.spec.path);
      if (current && current !== slice.spec.frozenHash) specDrift = true;
    } catch {
      /* 读不出哈希就不判漂移——下面的 review 会因为缺 frozenHash 报错 */
    }
  }

  // 预算
  let budgetExhausted = false;
  try {
    const budget = new BudgetCollector(events, ZELTO_DIR);
    budgetExhausted = await budget.isExhausted(id);
  } catch {
    budgetExhausted = false;
  }

  // 验收测试目录
  const acceptancePresent = slice.acceptance.dir
    ? existsSync(slice.acceptance.dir)
    : false;

  return {
    id: slice.id,
    state: slice.state,
    writes,
    specFrozen: Boolean(slice.spec.frozenHash),
    specDrift,
    trace: {
      requirements: slice.trace.requirements.length,
      contracts: slice.trace.contracts.length,
      tests: slice.trace.tests.length,
    },
    traceWaiver: slice.traceWaiver !== null,
    acceptancePresent,
    budgetExhausted,
  };
}

/**
 * 读出这批切片之间的依赖关系。
 *
 * 两个来源，命令行覆盖规格：
 *   1. 规格的「前置 / Prerequisites」章节（真源）
 *   2. `--depends-on <id>=<dep>`（临时覆盖）
 */
async function readDependencies(ids: string[], cliArgs: string[]): Promise<Map<string, string[]>> {
  const deps = new Map<string, string[]>();

  for (const id of ids) {
    const prereqs: string[] = [];
    try {
      const slice = await store.read(id);
      if (slice.spec.path && existsSync(slice.spec.path)) {
        const content = await readFile(slice.spec.path, 'utf-8');
        prereqs.push(...parsePrerequisites(content));
      }
    } catch {
      /* 读不到规格就没有前置 */
    }
    deps.set(id, prereqs);
  }

  // 命令行覆盖
  const cliDeps = parseDependsOnArgs(cliArgs);
  for (const [id, list] of cliDeps) {
    deps.set(id, list);
  }

  return deps;
}

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
    const facts = await readFacts(id);
    if ('missing' in facts) missing.push(id);
    else members.push(facts);
  }

  if (missing.length > 0) {
    console.error(`Slice(s) not found: ${missing.join(', ')}`);
    return 1;
  }

  // ── 判定 ──────────────────────────────────────────────────────────────────
  const review = reviewBatch(members);
  const deps = await readDependencies(ids, args);
  const phasePlan = planBatchPhases(ids, deps);
  const conflicts = evaluateBatchConflicts(members, phasePlan.phases);
  const allIssues: BatchIssue[] = [...review.issues, ...phasePlan.issues, ...conflicts];
  const { errors, warnings } = groupIssues(allIssues);

  const ready = review.ready && phasePlan.cycle === null && errors.length === 0;

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
      phases: phasePlan.phases,
      cycle: phasePlan.cycle,
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
    const sliceIssues = review.issues.filter((i) => i.sliceId === m.id);
    const errs = sliceIssues.filter((i) => i.severity === 'error');
    const warns = sliceIssues.filter((i) => i.severity === 'warning');
    const icon = errs.length > 0 ? '❌' : warns.length > 0 ? '⚠️ ' : '✅';
    console.log(`  ${icon} ${m.id} — ${m.state}`);
    for (const i of errs) console.log(`       ❌ ${i.message}`);
    for (const i of warns) console.log(`       ⚠️  ${i.message}`);
  }

  console.log('');
  if (phasePlan.cycle) {
    console.log(`执行阶段：❌ 依赖成环 —— ${phasePlan.cycle.join(' → ')}`);
    console.log('         环里的切片没法排先后，必须先解开依赖。');
  } else {
    console.log(`执行阶段：${phasePlan.phases.length} 个`);
    for (let p = 0; p < phasePlan.phases.length; p++) {
      const parallel = phasePlan.phases[p].length > 1 ? '（可并行）' : '';
      console.log(`  Phase ${p}: ${phasePlan.phases[p].join(', ')} ${parallel}`);
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
