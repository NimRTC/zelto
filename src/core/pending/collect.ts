// 待办事实的收集 —— CLI 与 Web 驾驶舱共用
//
// 「判定」在 `rank.ts`；这里只做**收集**（读文件、读 git），
// 把事实填进 `PendingFacts`。
//
// **为什么要分两层**：
//   - 收集需要上下文（哪些根、哪个仓库、哪些 store）—— 各调用方不一样；
//   - 判定与排序是纯计算 —— 各调用方必须一致。
//
// 分层的另一层好处：**Web 驾驶舱是多根的**（仓库根 + 每个版本集成目录），
// 它可以对每个根各收一次事实再合并；CLI 只收仓库根那份。
// 收法不同，但**排完序的结果口径一致**（同一份 `rank.ts`）。
//
// C3：只读文件与 git，不调模型、不触网。

import type { SliceData } from '../slice/store.js';
import type { SignRequest } from '../gate/sign.js';
import type { BranchIndex } from '../git/facts.js';
import { collectMergeCandidates, type MergeCandidateSource } from './merge-candidates.js';
import { collectPlanningDrafts } from './drafts.js';
import {
  collectAutoResolved,
  collectLongRunning,
  collectVersionTodos,
} from './slice-state.js';
import { emptyPendingFacts, type PendingFact, type PendingFacts } from './types.js';

/** 收集所需的依赖（注入 —— core/ 不认识全局单例）。 */
export interface PendingSource extends MergeCandidateSource {
  /** 列出切片 id */
  listSliceIds(): Promise<string[]>;
  /** 读切片 */
  readSlice(id: string): Promise<SliceData>;
  /** 列出签字请求（全部状态） */
  listSignRequests(): Promise<SignRequest[]>;
  /**
   * 一次问清全部分支事实 —— 存在哪些分支、哪些已合入 HEAD。
   *
   * **为什么不给「一个分支一个问」的接口**：
   * 真实仓库里有上百个切片，逐片问 git = 几百次子进程启动，
   * 实测 `zelto next` 要跑 60 多秒，Web 驾驶舱的待办接口直接超时。
   * 批量化后是一次 `for-each-ref` + 一次 `branch --merged`（C3 不变 —— 仍然是 git 事实，只是问法批量化）。
   *
   * 返回的索引**会被复用于合并候选判定** —— 同一轮里只建一次。
   */
  branchFacts(): Promise<BranchIndex>;
}

/**
 * 收集全部待办事实。
 *
 * 只读 —— 不改状态、不发请求、不触网（C3）。
 */
export async function collectPendingFacts(source: PendingSource): Promise<PendingFacts> {
  const facts = emptyPendingFacts();

  // ── 停机 ────────────────────────────────────────────────────────────────
  //
  // 判据：切片状态文件里的 `stall.class !== null`。
  // 人被交还控制权的那一刻，最该看见的就是它。
  const ids = await source.listSliceIds();
  const slices = new Map<string, SliceData>();
  for (const id of ids) {
    try {
      slices.set(id, await source.readSlice(id));
    } catch {
      // 读不出的切片跳过（不编）
    }
  }

  for (const [id, slice] of slices) {
    if (slice.stall.class === null) continue;
    facts.stalled.push({
      id,
      title: slice.title,
      prepare: '处理停机现场',
      action: `zelto stall ${id}`,
      reason: `停机分类 ${slice.stall.class}`,
      at: slice.updatedAt,
    });
  }

  // ── 规划草稿 ────────────────────────────────────────────────────────────
  //
  // require / design / plan 三类未确认的草稿 —— 上游没确认，下游跑了也白跑。
  // 收集用 core 里那三个 store（`core/pending/drafts.ts`）。
  for (const d of await collectPlanningDrafts(source.zeltoDir)) {
    facts.drafts.push({
      id: d.id,
      title: d.title,
      prepare: '看完再确认',
      action: `zelto ${d.kind} show ${d.id}`,
      then: `zelto ${d.kind} confirm ${d.id}`,
      reason: `${d.kind} 草稿还没确认 —— 上游没确认，下游跑了也白跑`,
    });
  }

  // ── 签字请求相关（待签 / 待重跑 / 待发签）─────────────────────────────
  const signRequests = await source.listSignRequests();
  const latest = latestSignRequestPerSlice(signRequests);

  // 待重跑 —— 人刚说过「要改」，还没改。
  for (const req of latest.values()) {
    if (req.status !== 'revised' && req.status !== 'returned') continue;

    const slice = slices.get(req.sliceId);
    if (!slice) continue;

    // 状态与请求状态**必须对得上** —— 对不上说明中间有人动过
    // （比如退完之后又跑了），那就交给别的分支处理，别在这里报。
    const expected = req.status === 'revised' ? 'frozen' : 'draft';
    if (slice.state !== expected) continue;

    facts.rerun.push({
      id: req.sliceId,
      title: slice.title,
      prepare:
        req.status === 'revised'
          ? 'Sent back for rework — rerun with the reviewer notes'
          : 'Returned upstream — update the spec, then freeze and run',
      action:
        req.status === 'revised'
          ? `zelto run ${req.sliceId}`
          : `zelto check ${req.sliceId} && zelto freeze ${req.sliceId}`,
      reason: '人说了要改，但还没改 —— 每多放一天就多错一天',
      at: req.decidedAt ?? req.requestedAt,
    });
  }

  // 待签字 —— 排队最久的先办。
  const pending = [...latest.values()]
    .filter((req) => req.status === 'pending')
    .sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime());
  for (const req of pending) {
    facts.sign.push({
      id: req.sliceId,
      title: slices.get(req.sliceId)?.title ?? req.sliceId,
      prepare: 'Review and sign off',
      action: `zelto sign ${req.sliceId} --approve`,
      reason: '门禁过了，等人签字',
      at: req.requestedAt,
    });
  }

  // ── 待合并 ──────────────────────────────────────────────────────────────
  //
  // 与 `zelto merge` 取同一个来源（`collectMergeCandidates`）——
  // 两处判据必须一致，否则人看到「待合并」却合不了。
  //
  // 分支索引**建一次**，合并候选与「待发签」共用 —— 两次建索引
  // 就是两次多余的 git 往返。
  const branchIndex = await source.branchFacts();
  const candidates = await collectMergeCandidates(source, undefined, branchIndex);
  for (const cand of candidates) {
    facts.merge.push({
      id: cand.id,
      title: slices.get(cand.id)?.title ?? cand.id,
      prepare: 'Merge into main branch',
      action: `zelto merge ${cand.id}`,
      reason: '已签字，等着合进目标',
    });
  }

  // ── 待发起签字 ──────────────────────────────────────────────────────────
  //
  // 门禁过了，但这个切片没有可用的签字请求：
  //   - 从没签过（签字请求没落盘）
  //   - 签过又被撤销（ADR-021）—— 批准作废了，得重新走一次
  //
  // 这类切片若不捞出来，就永远躺在 `completed` 里没人看见。
  //
  // 但只在切片真的还留着分支时才报：那说明它的产物还在树上、等着进主干。
  // 分支没了的切片有两种 —— 早就合进主干的，以及接管既有项目时生成的基线切片
  // （`project scan` 把已有代码映射成切片，本来就没有分支）。这两种都不该
  // 出现在待办里，否则历史切片会把待办列表淹掉。
  //
  // **分支判据走批量索引**（一次 `for-each-ref` + 一次 `branch --merged`
  // 答完全部切片）—— 逐片问 git 在真实仓库里要跑 60 多秒。
  for (const [id, slice] of slices) {
    if (slice.state !== 'completed') continue;

    const req = latest.get(id);
    if (req && (req.status === 'pending' || req.status === 'approved')) continue;

    const branch = source.branchFor(id);
    if (!branchIndex.branches.has(branch)) continue;
    if (branchIndex.mergedIntoHead.has(branch)) continue;

    facts.requestSign.push({
      id,
      title: slice.title,
      prepare: req ? 'Re-request signature (previous one was revoked)' : 'Request signature',
      action: `zelto sign ${id} --approve`,
      reason: '门禁过了，却连签字请求都没发起',
      at: slice.updatedAt,
    });
  }

  // ── 版本级 / 自动恢复 / 长跑 ───────────────────────────────────────────
  //
  // 三者都只依赖切片状态文件与版本计划文件 —— 判据在 `core/pending/slice-state.ts`。
  const sliceStates = new Map<string, string>();
  for (const [id, slice] of slices) sliceStates.set(id, slice.state);

  facts.version.push(...(await collectVersionTodos(source.versionsDir, sliceStates)));
  facts.autoResolved.push(...collectAutoResolved(slices.values()));
  facts.longRunning.push(...collectLongRunning(slices.values()));

  // ── 还没开始的活（按切片状态兜底）────────────────────────────────────
  //
  // **放在最后**：正在顺利跑的东西不值得占注意力。
  // 只有「没有更该做的事」时，这些才浮上来。
  //
  // 已被别的类别报过的切片不再重复列 ——
  // 那一条的提示更准（带着「人说了什么」的上下文），
  // 泛泛的「Execute slice」反而把那条信息盖掉了。
  const reported = new Set<string>([
    ...facts.stalled.map((f) => f.id),
    ...facts.rerun.map((f) => f.id),
    ...facts.sign.map((f) => f.id),
    ...facts.requestSign.map((f) => f.id),
    ...facts.merge.map((f) => f.id),
  ]);

  for (const [id, slice] of slices) {
    if (reported.has(id)) continue;
    const action = SLICE_STATE_ACTION[slice.state];
    if (!action) continue;
    facts.sliceState.push({
      id,
      title: slice.title,
      prepare: SLICE_STATE_PREPARE[slice.state] ?? '看看这片',
      action: action.replaceAll('<id>', id),
      reason: `切片状态 ${slice.state}`,
      at: slice.updatedAt,
    });
  }

  return facts;
}

/** 切片状态 → 该敲的命令（`null` = 这个状态不需要人管）。 */
const SLICE_STATE_ACTION: Record<string, string | undefined> = {
  draft: 'zelto check <id> && zelto freeze <id>',
  clarifying: 'zelto clarify <id>',
  frozen: 'zelto run <id> --dry-run',
  running: 'zelto events <id>',
};

/** 切片状态 → 这一步在做什么。 */
const SLICE_STATE_PREPARE: Record<string, string | undefined> = {
  draft: 'Check and freeze spec',
  clarifying: 'Answer clarification questions',
  frozen: 'Execute slice',
  running: 'Monitor execution',
};

/**
 * 取出每个切片「最新的一条」签字请求。
 *
 * 一个切片可能有多条签字请求（重签、撤销后再签）。判据只看最新那条——
 * 否则撤销过一次的切片会同时出现在「已签字」和「待签字」两处。
 *
 * `list()` 按 requestedAt 倒序，所以首个命中的就是最新的。
 */
export function latestSignRequestPerSlice(requests: SignRequest[]): Map<string, SignRequest> {
  const latest = new Map<string, SignRequest>();
  for (const req of requests) {
    if (!latest.has(req.sliceId)) latest.set(req.sliceId, req);
  }
  return latest;
}
