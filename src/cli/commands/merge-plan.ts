// Merge plan builder — 从切片数据与规格「前置切片」章节构建合并计划
//
// C3: 依赖解析与策略选择都是确定性计算，不调模型、不触网
// C6: core/ 不 import adapters/（本文件在 cli/ 层）
//
// 见 docs/adr-012-parallel-coordination.md §3.2 / §3.4

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DependencyGraph } from '../../core/sched/depgraph.js';
import { MergePlanner } from '../../core/sched/merge.js';
import type { MergePlan } from '../../core/sched/merge.js';
import type { SliceData } from '../../core/slice/store.js';
import { parsePrerequisites } from '../../core/spec/scope.js';

/** 构建计划所需的输入 */
export interface PlanInput {
  /** 参与合并的切片 id */
  ids: string[];
  /** 切片数据，key 为切片 id */
  slices: Map<string, SliceData>;
  /** 规格目录（用于读取「前置切片」章节） */
  specDir: string;
  /** 命令行显式声明的依赖，会覆盖规格里的声明 */
  cliDeps?: Map<string, string[]>;
}

/**
 * 构建依赖图并生成合并计划。
 *
 * 依赖来源有两条，命令行优先：
 * 1. 规格 Markdown 的 `## Prerequisites` 章节
 * 2. `--depends-on <id>=<dep>` 参数
 *
 * 抛出的错误信息面向使用者，不吞异常。
 */
export async function buildMergePlan(input: PlanInput): Promise<MergePlan> {
  const graph = new DependencyGraph();

  for (const id of input.ids) {
    const cliDeps = input.cliDeps?.get(id);
    let deps = cliDeps ?? [];

    if (!cliDeps) {
      deps = await readPrerequisitesFromSpec(input.specDir, id);
    }

    graph.addNode(id, deps);
  }

  const cycle = graph.checkCycles();
  if (cycle) {
    throw new Error(`循环依赖：${cycle.cycle.join(' → ')}`);
  }

  const sorted = graph.topologicalSort();
  const planner = new MergePlanner();
  return planner.planFromDependencyGraph(sorted, input.slices);
}

/**
 * 读取规格里的「前置切片」章节。
 *
 * 规格文件缺失或读取失败时返回空数组——依赖关系是可选的，
 * 缺失不应阻断合并流程。
 */
async function readPrerequisitesFromSpec(specDir: string, sliceId: string): Promise<string[]> {
  try {
    const content = await readFile(resolve(specDir, `${sliceId}.md`), 'utf-8');
    return parsePrerequisites(content);
  } catch {
    return [];
  }
}
