// 批量审核 / 执行规划要用的「事实读取」
//
// 为什么单独抽出来：`zelto batch`（只查不跑）与 `zelto version start` /
// `zelto run --parallel`（要跑）都需要从切片文件里读出同一批事实：
// 写集、冻结状态、追溯、依赖。前者是给人看的审核，后者是排阶段的输入。
// 两边各读一遍，读法一旦漂移，「审核说能开工」和「实际怎么排」就对不上。
//
// C1: 只读文件，不持有状态
// C3: 读取与解析都是确定性的（不调模型、不触网）

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { BatchMember } from '../../core/sched/batch.js';
import { pathsOverlap } from '../../core/sched/paths.js';
import { parseDependsOnArgs } from '../../core/sched/depgraph.js';
import { parsePrerequisites, parseScopePaths } from '../../core/spec/scope.js';
import { BudgetCollector } from '../../core/budget/collector.js';
import { DesignStore } from '../../core/design/store.js';
import { events, hashSpecFile, store, ZELTO_DIR } from './shared.js';
import { resolveWriteSet } from './run-support.js';

/**
 * 从切片文件里读出审核需要的事实。
 *
 * 刻意只取「事实」而不是把整个 SliceData 传下去 —— core/sched/batch.ts
 * 不应该知道切片文件的字段布局。
 */
export async function readSliceFacts(id: string): Promise<BatchMember | { missing: true }> {
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
 * 读出执行规划要用的写集——必须是「生效写集」，不是切片文件里那个原始值。
 *
 * 生效写集 = 切片文件里的 writes；没有就从规格「范围」章节解析；
 * 再没有就按目录探测（resolveWriteSet 会把这三种来源统一，并写回切片文件）。
 * 排阶段用的写集必须与运行时守卫（ADR-014）用的写集是同一份，
 * 否则会出现「规划说没有冲突、运行时却抢同一个文件」。
 */
export async function readEffectiveWriteSet(id: string): Promise<string[]> {
  try {
    // persist=false：规划阶段不改状态——写回是执行器的事（它本来就会写回）
    const resolved = await resolveWriteSet(id, false);
    return resolved.writes;
  } catch {
    return [];
  }
}

/**
 * 读出切片→设计模块名的映射（ADR-024 §3.1 规则 3）。
 *
 * 做法：取最近一份已确认的设计（与 `zelto arch check` 的找设计逻辑一致），
 * 把每片的生效写集与各模块的 filePatterns 做重叠判定（pathsOverlap），
 * 命中的模块名即为该片的模块归属。一片可属多模块。
 *
 * 全部是字符串/集合运算，不调模型、不触网（C3）。没有确认设计时返回空映射，
 * 调用方视为无模块命中（宁可不分组，不错分组）。
 */
export async function readModuleMap(ids: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const id of ids) result.set(id, []);

  try {
    const designStore = new DesignStore(ZELTO_DIR);
    const list = await designStore.list();
    const confirmed = list.filter((d) => d.status === 'confirmed');
    if (confirmed.length === 0) return result;
    const doc = await designStore.read(confirmed[0].id);
    if (!doc.modules || doc.modules.length === 0) return result;

    const writesOf = new Map<string, string[]>();
    for (const id of ids) {
      try {
        writesOf.set(id, await readEffectiveWriteSet(id));
      } catch {
        writesOf.set(id, []);
      }
    }

    for (const id of ids) {
      const writes = writesOf.get(id) ?? [];
      const hits: string[] = [];
      for (const mod of doc.modules) {
        if (!mod.name || !mod.filePatterns) continue;
        const hit = (mod.filePatterns as string[]).some((pat) =>
          writes.some((w) => pathsOverlap(w, pat) || pathsOverlap(pat, w)),
        );
        if (hit) hits.push(mod.name);
      }
      hits.sort((a, b) => a.localeCompare(b));
      result.set(id, hits);
    }
  } catch {
    /* 读不到设计就没有模块归属 */
  }
  return result;
}

/**
 * 读出这批切片之间的依赖关系。
 *
 * 两个来源，命令行覆盖规格：
 *   1. 规格的「前置 / Prerequisites」章节（真源）
 *   2. `--depends-on <id>=<dep>`（临时覆盖）
 */
export async function readDependencies(ids: string[], cliArgs: string[] = []): Promise<Map<string, string[]>> {
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
