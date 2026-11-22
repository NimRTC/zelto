// 待办动作的判定 —— 「这个切片眼下该做什么」
//
// 为什么不能只看切片状态：`completed` 同时表示「门禁②过了」与「人已经签字」
// （ADR-018：签字不改状态，SIGN_APPROVE 停在 completed）。所以按状态排优先级时，
// 早已签过字的切片跟刚过门禁的切片长得一模一样——`zelto next` 会一直叫人去签
// 三周前就签过的切片，`zelto suggest` 会把上百条历史切片全列出来。
//
// 真正的分界是签字请求的状态（`.zelto/locks/sign-*.json`）：
//   pending → 等人签字
//   approved → 已签字，等着合进主干
// 这与 `zelto inbox`、`zelto merge` 取同一个来源，三处不会各说各话。
//
// C3：只读文件与 git，不调模型、不触网。

import { SignManager, type SignRequest } from '../../core/gate/sign.js';
import { store, events, ZELTO_DIR, worktreeManager } from './shared.js';
import { collectMergeCandidates } from './merge-runner.js';
import { branchExists, isMergedIntoHead } from './merge-executor.js';

/** 一条待办动作 —— 一个切片 + 一句「现在该做什么」 */
export interface PendingAction {
  sliceId: string;
  title: string;
  /** 这一步在做什么（人话） */
  prepare: string;
  /** 该敲的命令 */
  action: string;
}

export interface PendingActions {
  /** 等人签字：门禁过了，停在待签字 */
  sign: PendingAction[];
  /** 已签字但还没合进主干 */
  merge: PendingAction[];
  /** 门禁过了却连签字请求都还没发起 —— 需要人先发起 */
  requestSign: PendingAction[];
  /**
   * 被退回重跑，等着人再跑一次（ADR-094 §5.1）。
   *
   * 人说「退回去改」之后，下一步是**人**去跑它 —— 工具不自动重跑
   * （重跑要花 agent 配额、要花时间，那是人的决定）。
   *
   * 但**必须**出现在待办里：退回的语义是「这片还要做」，
   * 而 `completed` 之外的切片在待办里一个都看不见 ——
   * 人退完就「这片没了」，它会静静躺在 `frozen` 里直到被忘掉。
   */
  rerun: PendingAction[];
}

/**
 * 取出每个切片「最新的一条」签字请求。
 *
 * 一个切片可能有多条签字请求（重签、撤销后再签）。判据只看最新那条——
 * 否则撤销过一次的切片会同时出现在「已签字」和「待签字」两处。
 *
 * `SignManager.list()` 按 requestedAt 倒序，所以首个命中的就是最新的。
 */
function latestSignRequestPerSlice(requests: SignRequest[]): Map<string, SignRequest> {
  const latest = new Map<string, SignRequest>();
  for (const req of requests) {
    if (!latest.has(req.sliceId)) latest.set(req.sliceId, req);
  }
  return latest;
}

/**
 * 收集当前项目所有待办动作。
 *
 * 只读文件与 git —— 不改状态、不发请求、不触网（C3）。
 */
export async function collectPendingActions(): Promise<PendingActions> {
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const latest = latestSignRequestPerSlice(await signManager.list());

  const titleOf = async (sliceId: string): Promise<string> => {
    try {
      return (await store.read(sliceId)).title;
    } catch {
      return sliceId;
    }
  };

  // ── 待签字 ──────────────────────────────────────────────────────────────
  // list() 倒序（最新在前），这里反过来 —— 排队最久的先办。
  const pending = [...latest.values()]
    .filter((req) => req.status === 'pending')
    .sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime());

  const sign: PendingAction[] = [];
  for (const req of pending) {
    sign.push({
      sliceId: req.sliceId,
      title: await titleOf(req.sliceId),
      prepare: 'Review and sign off',
      action: `zelto sign ${req.sliceId} --approve`,
    });
  }

  // ── 待合并 ──────────────────────────────────────────────────────────────
  // 与 `zelto merge` 取同一个来源：已签字 + 分支还在 + 尚未合入 HEAD。
  const merge: PendingAction[] = [];
  for (const cand of await collectMergeCandidates()) {
    merge.push({
      sliceId: cand.id,
      title: await titleOf(cand.id),
      prepare: 'Merge into main branch',
      action: `zelto merge ${cand.id}`,
    });
  }

  // ── 需要发起签字 ────────────────────────────────────────────────────────
  // 门禁过了，但这个切片没有可用的签字请求：
  //   - 从没签过（签字请求没落盘）
  //   - 签过又被撤销（ADR-021）—— 批准作废了，得重新走一次
  // 这类切片若不捞出来，就永远躺在 `completed` 里没人看见。
  //
  // 但只在切片真的还留着分支时才报：那说明它的产物还在树上、等着进主干。
  // 分支没了的切片有两种——早就合进主干的，以及接管既有项目时生成的基线切片
  // （`project scan` 把已有代码映射成切片，本来就没有分支）。这两种都不该
  // 出现在待办里，否则历史切片会把待办列表淹掉。
  const requestSign: PendingAction[] = [];
  const manager = worktreeManager();
  const repoRoot = process.cwd();
  for (const id of await store.list()) {
    let state: string;
    try {
      state = (await store.read(id)).state;
    } catch {
      continue;
    }
    if (state !== 'completed') continue;

    const req = latest.get(id);
    if (req && (req.status === 'pending' || req.status === 'approved')) continue;

    const branch = manager.branchFor(id);
    if (!branchExists(branch, repoRoot)) continue;
    if (isMergedIntoHead(branch, repoRoot)) continue;

    requestSign.push({
      sliceId: id,
      title: await titleOf(id),
      prepare: req ? 'Re-request signature (previous one was revoked)' : 'Request signature',
      action: `zelto sign ${id} --approve`,
    });
  }

  // ── 待重跑（被退回重跑 / 退回上游）────────────────────────────────────
  //
  // 判据：**最新一条签字请求是 `revised` 或 `returned`**。
  //
  // 为什么用签字请求的状态而不是切片状态：
  //   - `revised` → 切片回 `frozen`（规格与写集不动，重跑即可）；
  //   - `returned` → 切片回 `draft`（**规格要改**，先改规格再冻结）。
  //
  // 两种都归到「待重跑」但**下一步不一样** —— `returned` 的下一步是
  // 「改规格」，不是「直接跑」。所以动作提示要分开写。
  //
  // 为什么这条重要（ADR-094 §5.1）：
  // 退回之后，切片不再 `completed`，于是**在待办里彻底消失**。
  // 人退完就「这片没了」—— 它静静躺在 `frozen`/`draft` 里直到被忘掉。
  // 而「人说要改」的那一片恰恰是**最不该被忘掉**的一片。
  //
  // **不要求分支存在**（与 `requestSign` 不同）：
  // 那一条问的是「产物还在树上、等着进主干吗」，所以要分支在。
  // 这一条问的是「人说了要改、还没改吗」—— 而
  //   - 分支可能还没建（人审的是**规格**与产物，`zelto run` 还没跑过）；
  //   - 分支可能已清理（`zelto merge` 后删掉了）。
  // 两种情况下这片**都还要做**，所以不能因为「没分支」就装作没有这回事。
  // 判据用**切片状态** —— 退回时状态机把它从 `completed` 挪到了
  // `frozen`/`draft`，那本身就是「这片还没做完」的确证。
  const rerun: PendingAction[] = [];
  for (const req of latest.values()) {
    if (req.status !== 'revised' && req.status !== 'returned') continue;

    let state: string;
    try {
      state = (await store.read(req.sliceId)).state;
    } catch {
      continue;
    }

    // 状态与请求状态**必须对得上** —— 对不上说明中间有人动过
    // （比如退完之后又跑了），那就交给别的分支处理，别在这里报。
    const expected = req.status === 'revised' ? 'frozen' : 'draft';
    if (state !== expected) continue;

    rerun.push({
      sliceId: req.sliceId,
      title: await titleOf(req.sliceId),
      prepare:
        req.status === 'revised'
          ? 'Sent back for rework — rerun with the reviewer notes'
          : 'Returned upstream — update the spec, then freeze and run',
      action:
        req.status === 'revised'
          ? `zelto run ${req.sliceId}`
          : `zelto check ${req.sliceId} && zelto freeze ${req.sliceId}`,
    });
  }

  // 排队最久的先办 —— 与 `sign` 一致。
  rerun.sort((a, b) => {
    const ra = latest.get(a.sliceId);
    const rb = latest.get(b.sliceId);
    const ta = ra ? new Date(ra.decidedAt ?? ra.requestedAt).getTime() : 0;
    const tb = rb ? new Date(rb.decidedAt ?? rb.requestedAt).getTime() : 0;
    return ta - tb;
  });

  return { sign, merge, requestSign, rerun };
}
