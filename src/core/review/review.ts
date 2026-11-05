// 草稿评审 —— 把「一份大 markdown」变成「摘要 + diff + 决策点」
//
// 见 docs/zelto-项目目标.md §6 G-5：规划确认体验重是这条路上最硬的一块。
//
// buildDraftReview 是纯函数：输入两份事实（当前稿 + 上一稿），
// 输出一份给人看的评审。没有 IO、不调模型、不触网（C3）。

import { diffOps, summarizeOps } from './diff.js';
import {
  designDecisionPoints,
  planDecisionPoints,
  requirementDecisionPoints,
} from './decision-points.js';
import { renderFacts } from './render.js';
import type {
  DecisionPoint,
  DesignFacts,
  DraftFacts,
  DraftKind,
  DraftReview,
  PlanFacts,
  RequirementFacts,
} from './types.js';

/**
 * 构建草稿评审结论。
 *
 * @param kind 草稿种类
 * @param id 草稿 id
 * @param status 草稿状态
 * @param facts 当前稿
 * @param previousFacts 上一稿；没有则为 null（此时没有 diff）
 * @param revisionCount 已保存的修订数
 */
export function buildDraftReview(
  kind: DraftKind,
  id: string,
  status: string,
  facts: DraftFacts,
  previousFacts: DraftFacts | null,
  revisionCount: number,
): DraftReview {
  const current = extractPoints(kind, facts);
  const points = previousFacts
    ? comparePoints(extractPoints(kind, previousFacts), current)
    : current;

  const changedCount = points.filter(
    (p) => p.status === 'added' || p.status === 'removed' || p.status === 'changed',
  ).length;

  let diff = null;
  if (previousFacts) {
    const ops = diffOps(renderFacts(kind, previousFacts), renderFacts(kind, facts));
    diff = summarizeOps(ops);
  }

  return {
    kind,
    id,
    title: facts.title,
    status,
    summary: buildSummary(kind, facts, points, diff, revisionCount),
    decisionPoints: points,
    changedCount,
    revisionCount,
    diff,
  };
}

/** 按种类抽取决策点 */
export function extractPoints(kind: DraftKind, facts: DraftFacts): DecisionPoint[] {
  switch (kind) {
    case 'requirement':
      return requirementDecisionPoints(facts as RequirementFacts);
    case 'design':
      return designDecisionPoints(facts as DesignFacts);
    case 'plan':
      return planDecisionPoints(facts as PlanFacts);
  }
}

/**
 * 对齐两版决策点，标出每个点的状态。
 *
 * 按 id 对齐：同一个 id 的点就是「同一个决策点」，
 * 文案变了就是 changed，消失了就是 removed，新出现的就是 added。
 */
export function comparePoints(
  previous: DecisionPoint[],
  current: DecisionPoint[],
): DecisionPoint[] {
  const prevById = new Map(previous.map((p) => [p.id, p]));
  const curById = new Map(current.map((p) => [p.id, p]));

  const result: DecisionPoint[] = [];

  for (const point of current) {
    const before = prevById.get(point.id);
    if (!before) {
      result.push({ ...point, status: 'added' });
      continue;
    }
    const changed = before.label !== point.label || before.detail !== point.detail;
    result.push({ ...point, status: changed ? 'changed' : 'unchanged' });
  }

  for (const point of previous) {
    if (curById.has(point.id)) continue;
    result.push({ ...point, status: 'removed' });
  }

  return result;
}

/** 生成摘要条目 —— 一屏能读完 */
function buildSummary(
  kind: DraftKind,
  facts: DraftFacts,
  points: DecisionPoint[],
  diff: DraftReview['diff'],
  revisionCount: number,
): string[] {
  const summary: string[] = [];
  const counts = countByKind(points);

  summary.push(`草稿类型: ${kind}`);
  summary.push(`决策点: ${points.length} 条（新增 ${counts.added} / 移除 ${counts.removed} / 变更 ${counts.changed}）`);

  if (kind === 'requirement') {
    summary.push(`验收标准: ${(facts as RequirementFacts).acceptanceCriteria.length} 条`);
  } else if (kind === 'design') {
    summary.push(`模块: ${(facts as DesignFacts).modules.length} 个`);
  } else {
    const versions = (facts as PlanFacts).versions;
    const slices = versions.reduce(
      (acc, v) => acc + v.slices.length,
      0,
    );
    summary.push(`版本: ${versions.length} 个 / 切片: ${slices} 个`);
  }

  if (diff) {
    summary.push(`与上一版差异: +${diff.added} / -${diff.removed} 行`);
  } else {
    summary.push('与上一版差异: 无（这是第一版）');
  }

  summary.push(`历史修订: ${revisionCount} 份`);

  return summary;
}

function countByKind(points: DecisionPoint[]): {
  added: number;
  removed: number;
  changed: number;
} {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const p of points) {
    if (p.status === 'added') added++;
    else if (p.status === 'removed') removed++;
    else if (p.status === 'changed') changed++;
  }
  return { added, removed, changed };
}
