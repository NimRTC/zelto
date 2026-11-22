// PR 追溯链的事实收集（ADR-094 §6.1）
//
// **不复算任何判定** —— 事实全部来自 `core/sign-review/collect.ts`
// （`SignReviewFacts`）。那是签字复查的唯一实源（ADR-070 的核心诉求：
// 判定只有一处）。这里只做两件事：
//
// 1. 补上 PR 需要的、签字复查没有的字段（分支、签字请求、切片元信息）；
// 2. 把事实整理成 PR body 要的形状。
//
// 为什么不多做一层判定：PR body 里的「门禁过没过」如果另算一套，
// 就会出现「zelto 说过了、PR body 说没过」—— 远端 reviewer 会去查
// 为什么，而答案只是两份实现的漂移。
//
// C3: 只读文件与 git、纯计算；不调模型、不触网。
// C2: 只用 Node 内置。

import type { SignReviewFacts } from '../sign-review/types.js';
import type { EventEnvelope } from '../events/stream.js';
import type { SliceData } from '../slice/store.js';

/** PR 追溯链需要的全部事实 */
export interface ForgeTraceFacts {
  /** 切片 id */
  sliceId: string;
  /** 切片标题 */
  title: string;
  /** 规格路径 */
  specPath: string;
  /** 冻结哈希（规格基线的凭据） */
  frozenHash: string | null;
  /** 边界摘要（写集 + 门禁命令，ADR-092） */
  boundaryHash: string | null;
  /** 批准这次签字的签字请求 id */
  signId: string | null;
  /** 谁批的 */
  approvedBy: string | null;
  /** 什么时候批的 */
  approvedAt: string | null;
  /** 来源分支 */
  headBranch: string;
  /** 目标分支 */
  baseBranch: string;
  /** 签字复查的事实（已算好，不重算） */
  review: SignReviewFacts;
}

/**
 * 从事件流里找出「批准这个切片的那次签字」。
 *
 * 判据：找**最新一条** `sign.approved` 事件。
 *
 * 为什么用事件而不是 `.zelto/locks/sign-*.json`：
 * 事件流是追溯的唯一证据载体（C4），且**追加顺序 = 时间顺序** ——
 * 「最新一次批准」这个事实可以直接从流里读出来。
 *
 * 「最新」而不是「唯一」：一个切片可能被批了又被撤销（ADR-021），
 * 又被重新批过。追溯块要引的是**当前有效的那次**批准。
 */
export function findLatestApproval(
  events: EventEnvelope[],
): { signId: string | null; approvedBy: string | null; approvedAt: string | null } {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'sign.approved') continue;
    const signId = typeof e.payload?.signId === 'string' ? e.payload.signId : null;
    return {
      signId,
      approvedBy: typeof e.actor === 'string' && e.actor ? e.actor : null,
      approvedAt: e.ts,
    };
  }
  return { signId: null, approvedBy: null, approvedAt: null };
}

/**
 * 组装 PR 追溯链事实。
 *
 * `headBranch` 与 `baseBranch` 由调用方给（CLI 侧解析归属，ADR-056）——
 * 解析要读版本计划与 git，core/ 的这一层不做那件事。
 */
export function buildForgeTraceFacts(
  slice: SliceData,
  review: SignReviewFacts,
  events: EventEnvelope[],
  branches: { head: string; base: string },
): ForgeTraceFacts {
  const approval = findLatestApproval(events);
  return {
    sliceId: slice.id,
    title: slice.title,
    specPath: slice.spec.path,
    frozenHash: slice.spec.frozenHash,
    boundaryHash: slice.spec.boundaryHash ?? null,
    signId: approval.signId,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    headBranch: branches.head,
    baseBranch: branches.base,
    review,
  };
}
