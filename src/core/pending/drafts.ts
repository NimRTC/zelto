// 规划草稿的收集 —— CLI 与 Web 驾驶舱共用
//
// 为什么从 `cli/commands/planning-drafts.ts` 搬进 core：
//
// 「哪些规划草稿还没确认」是「眼下该做什么」的一个来源
// （require / design / plan 三类草稿，优先级 20 —— 上游没确认，
// 下游跑了也白跑）。
//
// 它以前住在 CLI 层，Web 驾驶舱就没法用同一份 ——
// 于是驾驶舱只能显示切片层的待办，看不见规划层的。
//
// 收集用到的三个 store 本来就在 core/（requirements / design / version），
// 搬进来不引任何新依赖（C2）。
//
// 只读：只 list，不改任何文件、不调模型、不触网（C3）。

import { RequirementStore } from '../requirements/store.js';
import { DesignStore } from '../design/store.js';
import { VersionStore } from '../version/store.js';

/** 一条待确认的规划草稿。 */
export interface PlanningDraft {
  kind: 'require' | 'design' | 'plan';
  id: string;
  title: string;
}

/**
 * 列出所有待确认的规划草稿（只读）。
 *
 * @param baseDir `.zelto` 根（如 ZELTO_DIR）。读不到就当空，不抛错——
 *   next / suggest 是日常入口，不能因为规划目录坏了就崩。
 */
export async function collectPlanningDrafts(baseDir: string): Promise<PlanningDraft[]> {
  const drafts: PlanningDraft[] = [];

  try {
    const reqStore = new RequirementStore(baseDir);
    const reqs = await reqStore.list();
    for (const r of reqs) {
      if (r.status === 'draft') drafts.push({ kind: 'require', id: r.id, title: r.title });
    }
  } catch {
    // 读不到就跳过，保持入口可用
  }

  try {
    const designStore = new DesignStore(baseDir);
    const designs = await designStore.list();
    for (const d of designs) {
      if (d.status === 'draft') drafts.push({ kind: 'design', id: d.id, title: d.title });
    }
  } catch {
    // 同上
  }

  try {
    const versionStore = new VersionStore(baseDir);
    const plans = await versionStore.list();
    for (const p of plans) {
      if (p.status === 'draft') drafts.push({ kind: 'plan', id: p.id, title: p.title });
    }
  } catch {
    // 同上
  }

  return drafts;
}
