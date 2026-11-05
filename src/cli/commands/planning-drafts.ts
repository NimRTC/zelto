// 规划草稿推荐 —— G-6 日常交互密度
//
// `zelto next` / `zelto suggest` 以前只看切片，看不到规划层的待确认草稿：
// require / design / plan 的 draft 一直躺着，日常入口却只推切片动作。
// 这里把三类草稿收敛成一个只读列表，next / suggest 直接消费。
//
// 只读：只 list，不改任何文件、不调模型、不触网。
// 顺序按管线从上往下：require → design → plan，上游先确认再往下走。

import { RequirementStore } from '../../core/requirements/store.js';
import { DesignStore } from '../../core/design/store.js';
import { VersionStore } from '../../core/version/store.js';

export interface PlanningDraft {
  kind: 'require' | 'design' | 'plan';
  id: string;
  title: string;
}

/**
 * 列出所有待确认的规划草稿（只读）。
 *
 * @param baseDir `.zelto` 根（如 ZELTO_DIR）。读不到就当空，不抛错——
 * next / suggest 是日常入口，不能因为规划目录坏了就崩。
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

/** 下一步确认命令：先看决策点，再 confirm（G-5 同一入口） */
export function draftShowCommand(d: PlanningDraft): string {
  return `zelto ${d.kind} show ${d.id}`;
}

/** 看完之后确认的命令 */
export function draftConfirmCommand(d: PlanningDraft): string {
  return `zelto ${d.kind} confirm ${d.id}`;
}
