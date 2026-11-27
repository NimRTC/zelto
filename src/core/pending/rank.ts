// 待办的排序与呈现 —— 纯计算（C3）
//
// 这里只做**判定与排序**，不做任何 IO：
// 输入是收集层给的事实，输出是排好序的待办清单。
//
// 「判定集中在一处」的意义：CLI 的 `zelto next`、`zelto dashboard`、
// `zelto suggest` 与 Web 驾驶舱的「眼下该做什么」全部消费**同一个**排序，
// 于是三处不会各说各话（D-11 的老教训）。
//
// 优先级表见 `types.ts` 的注释 —— 每一条都有理由，不是拍脑袋。

import type { PendingFacts, PendingItem, PendingKind, PendingFact } from './types.js';

/** 各类别的排序权重 —— 与 `types.ts` 的优先级表一一对应。 */
export const PENDING_PRIORITY: Record<PendingKind, number> = {
  stalled: 10,
  draft: 20,
  rerun: 30,
  sign: 40,
  requestSign: 45,
  merge: 50,
  version: 60,
  autoResolved: 85,
  sliceState: 90,
  longRunning: 95,
};

/** 类别 → 人话标签（CLI 与 Web 共用同一份措辞）。 */
export const PENDING_KIND_LABEL: Record<PendingKind, string> = {
  stalled: '停机待处理',
  draft: '规划草稿待确认',
  rerun: '退回待重跑',
  sign: '待签字',
  requestSign: '待发起签字',
  merge: '待合并',
  version: '版本级待办',
  autoResolved: '自动恢复过',
  sliceState: '未开始',
  longRunning: '长跑',
};

/**
 * 类别 → CLI 分段标题。
 *
 * 与 `PENDING_KIND_LABEL` 是**两套措辞、同一份事实**：
 * CLI 的 `zelto suggest` 一直是英文段名（`Sent Back For Rework` 等），
 * 改掉会让人眼熟的命令输出变样；Web 驾驶舱是中文界面。
 *
 * 两份措辞放在**同一个文件**里 —— 类别与标题的对应关系只有一处，
 * 不会出现「多了一个类别，CLI 忘了给标题」。
 */
export const PENDING_SECTION_TITLE: Record<PendingKind, string> = {
  stalled: 'Stalled — Needs Attention',
  draft: 'Planning Drafts',
  rerun: 'Sent Back For Rework',
  sign: 'Awaiting Signature',
  requestSign: 'Needs Signature Request',
  merge: 'Awaiting Merge',
  version: 'Version Actions',
  autoResolved: 'Auto-Resolved',
  sliceState: 'Not Started',
  longRunning: 'Running Long',
};

/** 类别 → 事实集合里的字段名（`draft` 这一类在事实里叫 `drafts`）。 */
const FACTS_KEY: Record<PendingKind, keyof PendingFacts> = {
  stalled: 'stalled',
  draft: 'drafts',
  rerun: 'rerun',
  sign: 'sign',
  requestSign: 'requestSign',
  merge: 'merge',
  version: 'version',
  autoResolved: 'autoResolved',
  sliceState: 'sliceState',
  longRunning: 'longRunning',
};

/**
 * 把事实集合排成一份待办清单。
 *
 * 排序规则（三层，从粗到细）：
 *   1. 优先级（权重小的在前）
 *   2. 同类内按 `at` 时间戳 —— **排队最久的先办**
 *      （待签字那一列躺了多久，比它先来后到更该被人看见）
 *   3. 再同则按 id 字典序 —— 保证**确定性**（C3：同样的输入必须同样的输出）
 */
export function rankPending(facts: PendingFacts): PendingItem[] {
  const items: PendingItem[] = [];

  for (const [kind, list] of Object.entries(facts) as Array<[PendingKind, PendingFact[]]>) {
    const priority = PENDING_PRIORITY[kind];
    for (const f of list) {
      items.push({
        kind,
        priority,
        id: f.id,
        title: f.title,
        prepare: f.prepare,
        action: f.action,
        reason: f.reason ?? '',
        ...(f.then ? { then: f.then } : {}),
        ...(f.scope ? { scope: f.scope } : {}),
        ...(f.label !== undefined ? { label: f.label } : {}),
      });
    }
  }

  return items.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const ta = timeOf(a.id, facts, a.kind);
    const tb = timeOf(b.id, facts, b.kind);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 取某条待办的组内时间戳（毫秒；没有则 0）。 */
function timeOf(id: string, facts: PendingFacts, kind: PendingKind): number {
  const list = (facts[FACTS_KEY[kind]] ?? []) as PendingFact[];
  const hit = list.find((f) => f.id === id);
  if (!hit?.at) return 0;
  const t = new Date(hit.at).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * 分组 —— 按类别返回，组内保持排序后的顺序。
 *
 * CLI 的 `zelto suggest` 要分段呈现（每段一个标题），
 * Web 驾驶舱要按段折叠 —— 两边消费**同一份**分组结果。
 */
export function groupPending(items: PendingItem[]): Array<{
  kind: PendingKind;
  label: string;
  priority: number;
  items: PendingItem[];
}> {
  const groups: Array<{ kind: PendingKind; label: string; priority: number; items: PendingItem[] }> = [];
  const byKind = new Map<PendingKind, PendingItem[]>();
  for (const item of items) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }
  // 按优先级顺序出组（与排序一致）
  for (const kind of Object.keys(PENDING_PRIORITY) as PendingKind[]) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    groups.push({
      kind,
      label: PENDING_KIND_LABEL[kind],
      priority: PENDING_PRIORITY[kind],
      items: list,
    });
  }
  return groups;
}

/**
 * 「眼下最该做的一件事」。
 *
 * `zelto next` 与驾驶舱首屏的「大号提示」都用它。
 * 清单为空 → null（= 没事要做，不是「不知道」）。
 */
export function topPending(items: PendingItem[]): PendingItem | null {
  return items.length > 0 ? items[0] : null;
}
