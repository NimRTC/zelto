// 死切片的批量清理（ADR-053）
//
// 「死切片」= 状态还停在 `running`，但 agent 早就挂了。
//
// 为什么它是一个独立的问题（ADR-047 已修掉一半）：
// ADR-047 让死切片**不再阻塞别人**（准入的写集冲突表排除带停机分类的切片），
// 但它们仍然占着 `zelto status` 的「running」计数，而且人得逐片
// `zelto resume` 才能把它们清掉。
//
// 为什么 `zelto halt --rollback` 扫不到它们：
// `--rollback` 的判据是「持有预约的进程已经死了」—— 那是**批次崩了**
// 的场景。死切片**没有预约**（agent 挂了，预约已释放），
// 所以它扫不到。这是两个不同的问题，不能混在一条命令里。
//
// 本模块的判据（确定性，C3）：**状态是 `running` 且带停机分类**。
// 纯读文件，不调模型、不触网。
//
// C1: 状态只落在文件里
// C4: 每个动作写 append-only 事件

import type { EventStream } from '../events/stream.js';
import type { SliceData, SliceStore } from '../slice/store.js';
import {
  classifyLiveness,
  readRecoveries,
  readSliceLivenessRecord,
  readSliceLivenessRecords,
  type LivenessInfo,
} from '../activity/index.js';

/** 一片死切片的信息 */
export interface DeadSlice {
  sliceId: string;
  title: string;
  /** 停机分类（为什么它是死的） */
  stallClass: string;
  /** 上次运行的时间（如果有） */
  lastRunAt: string | null;
}

/**
 * 一片「空壳」切片 —— 状态是 `running`，但**没有任何停机分类**，
 * 而且现场证据（会话/任务文件 + 进程表）说明它已经没人在管了。
 *
 * 与 `DeadSlice` 的区别：
 * - 死切片：跑挂了、被判定停机，但状态没退回去（有分类，缺一个显式的清理）
 * - 空壳：**连分类都没有** —— 典型成因是 `--detach` 之后 CLI 主进程退出，
 *   后台监视器被杀，没人写收尾，文件永远停在 `running`（D-30）。
 *
 * 为什么它必须单独一类：`findDeadSlices` 的判据是「带停机分类」，
 * 空壳天然过不了这条 —— 按旧判据，`zelto stall --reap` 永远看不见它们，
 * 于是它们能一直挂在界面上当「正在跑」。
 */
export interface OrphanShell {
  sliceId: string;
  title: string;
  /** 活性判定（stale / dead；active 的不会进来） */
  liveness: LivenessInfo;
  /** 看门狗已自愈次数 —— 上报过几次让人心里有数 */
  recoveries: number;
  escalated: boolean;
  /** 上次运行的时间（如果有） */
  lastRunAt: string | null;
}

/** 清理结果 */
export interface ReapResult {
  sliceId: string;
  title: string;
  /** 回退前的状态 */
  from: string;
  /** 回退后的状态 */
  to: string;
  /** 是否真的回退了 */
  reverted: boolean;
  /** 回退前的停机分类 */
  stallClass: string;
}

/**
 * 找出死切片：状态是 `running` 且带停机分类。
 *
 * **例外：提问回路（`agent_question`）不算死切片。**
 * 那不是「跑挂了」—— agent 还活着，只是停下来等人数码，答完在原地续跑
 * （ADR-013）。把它算成死的，等于把一个还在等答复的会话判成尸体。
 *
 * @param slices 已读出的切片（由调用方给，避免重复读盘）
 */
export function findDeadSlices(slices: SliceData[]): DeadSlice[] {
  const dead: DeadSlice[] = [];
  for (const slice of slices) {
    if (slice.state !== 'running') continue;
    if (slice.stall.class === null) continue;
    // 提问回路的 agent 还活着 —— 不算死
    if (slice.stall.class === 'agent_question') continue;

    dead.push({
      sliceId: slice.id,
      title: slice.title,
      stallClass: slice.stall.class,
      lastRunAt: slice.runs.length > 0 ? slice.runs[slice.runs.length - 1].at : null,
    });
  }
  return dead;
}

/**
 * 找出空壳切片：状态是 `running`、**没有停机分类**、活性判定为 `stale` / `dead`
 * **或压根没有任何运行记录**。
 *
 * 「提问回路」（`agent_question`）永远排除：那是有分类的、agent 还活着。
 *
 * 为什么 stale 也要算进来（而不是只认 dead）：
 * 老会话文件没有 pid，进程表查不了 —— 那是「无法确认活着」而不是
 * 「确认活着」。对它们唯一的证据就是时间：几小时没有任何心跳，还能是什么？
 * 这类切片**不会自动改状态**（改状态必须显式），但必须能在清理命令里被看见。
 *
 * 为什么「压根没有运行记录」也要算进来（D-64）：
 * 切片状态是 `running`，但会话/任务文件里**一条记录都没有** ——
 * 说明 agent 从来没起来过（准备阶段就挂了：装守卫失败、worktree 建不出来、
 * 进程在起 agent 前被杀）。这比 stale/dead 更确定：**没有任何东西在管它**。
 *
 * 原判据把它漏掉了：`classifyLiveness(null)` 返回 `finished`
 * （不是 stale/dead）→ 不算空壳 → `zelto stall --reap` 看不见它。
 * 结果是这种切片永远卡在 running：跑不了、合不了、reap 不到，
 * 唯一出路是 `abandon`（整个切片作废，规格得重写）。
 * 实测于 nimrtc-zelto v4-ai-teammate（2026-11-18）：
 * `version start v4` 装守卫时 git status 超时 → 整批 abort → 切片卡在 running。
 */
export function findOrphanShells(
  slices: SliceData[],
  projectRoot: string,
  isProcessAlive?: (pid: number) => boolean,
): OrphanShell[] {
  const shells: OrphanShell[] = [];
  for (const slice of slices) {
    if (slice.state !== 'running') continue;
    // 有停机分类的归 findDeadSlices 管，不在这里重复报
    if (slice.stall.class !== null) continue;

    const liveness = classifyOrphanShell(projectRoot, slice.id, isProcessAlive);
    if (liveness === null) continue;
    if (liveness.state !== 'stale' && liveness.state !== 'dead') continue;

    const rec = readRecoveries(projectRoot, slice.id);
    shells.push({
      sliceId: slice.id,
      title: slice.title,
      liveness,
      recoveries: rec.count,
      escalated: rec.escalated,
      lastRunAt: slice.runs.length > 0 ? slice.runs[slice.runs.length - 1].at : null,
    });
  }
  return shells;
}

/**
 * 空壳判据 —— **唯一一份**（`findOrphanShells` 与 `reapDeadSlices` 共用）。
 *
 * 为什么必须只有一份：
 * 判据分叉的后果是「列表里看得见、清理时却不认」——
 * 人看着 `zelto stall --reap` 的列表里有这片，命令却说「没找到」。
 * 这不是小毛病：它意味着「清理」这条路对某些切片**根本不存在**，
 * 而人看不出哪些切片属于那一类。
 *
 * @returns 活性判定；`null` = 不是空壳（或判据读不出来）
 */
export function classifyOrphanShell(
  projectRoot: string,
  sliceId: string,
  isProcessAlive?: (pid: number) => boolean,
): LivenessInfo | null {
  try {
    const rec = readSliceLivenessRecord(projectRoot, sliceId);
    if (rec !== null) {
      // 有 running 记录 → 可能是活着的 agent。活性判定说了算
      // （active → 不算空壳；stale/dead → 算）。
      return classifyLiveness(rec, { isProcessAlive });
    }

    // `readSliceLivenessRecord` 只返回 status==='running' 的记录，所以
    // rec===null 有**两种**可能，必须分开：
    //
    //   (a) 盘上**一条记录都没有** → agent 从来没起过（准备阶段就挂了）
    //   (b) 有记录但都不是 running → 那一轮**已经收尾**了
    //
    // (b) 曾经被判为「不是空壳」（D-64 的原始判据），但那是错的：
    //
    //   病灶（实测于 nimrtc-v14 v1-n5-turn-server，2026-11-20）：
    //   切片卡在 `running`（`startRun` 推的），盘上的会话记录全是
    //   `status: completed` —— 那是**上一轮**留下的。那一轮收尾时
    //   应该把切片退回 frozen，但没退（跑完超预算 → 收尾提前 return）。
    //
    //   于是这一片卡在 running，而四条路全堵死：
    //     - `run` 拒绝跑（准入只认 frozen / completed）
    //     - `merge` 不收它（没签字）
    //     - `stall --reap` 看不见它（这里就是原因）
    //     - `resume` 说它没停机（stall.class 是 null）
    //   唯一出路是 `abandon` —— 整个切片作废，规格得重写。
    //
    // 现在的判据：**没有一条 running 记录 = 没人再管这一轮 = 空壳**。
    //
    // 为什么不看「记录有多旧」：记录时间不是判据 —— 判据是
    // 「现在还有没有人在管这一轮」。没有 running 记录 = 没人管。
    // 有 running 记录时绝不能碰（那可能是 agent 还活着）——
    // 上面 `rec !== null` 分支已经处理了那种情况。
    const anyRecord = readSliceLivenessRecords(projectRoot, sliceId);
    const hasRunning = anyRecord.some((r) => r.status === undefined || r.status === 'running');
    if (hasRunning) return null;

    const statuses = anyRecord.map((r) => r.status ?? 'running').join(', ');
    return {
      state: 'dead',
      lastActivityAt: null,
      idleMs: null,
      pid: null,
      reason:
        anyRecord.length === 0
          ? '没有任何运行记录（agent 从未开跑）'
          : `运行记录都已收尾（${statuses}），但切片仍停在 running —— 没人再管这一轮`,
    };
  } catch {
    return null;
  }
}

/**
 * 把死切片退回 `frozen`（RUN_FINISH）。
 *
 * 与 ADR-047 的 `markSliceStalled` 是**同一条退路**：
 * `running --RUN_FINISH--> frozen`，语义是「这一轮跑完了，回到可以再跑的状态」。
 * 与 ADR-037 的越界回退也是同一条。
 *
 * **不清停机分类** —— 与 ADR-047 的 `resume()` 一致：
 * 清掉分类等于说「这片已经处理好了」，但这里只是把状态掰回可跑的样子，
 * 停机这件事本身仍然成立（人还没看过现场）。
 * 人看到「`running` 不再卡着」之后，仍然要用 `zelto resume` 走正式的恢复流程。
 *
 * `allowNoStallClass`（空壳清理）：默认 `false`，只认「running + 带停机分类」。
 * 显式传 `true` 时，额外接受「running + 无分类 + 活性 stale/dead」的空壳 ——
 * 判据在这里**重新算一遍**（与 `findOrphanShells` 同一份判据），
 * 不信任调用方传来的列表：从人看到列表到执行清理之间，切片可能又跑起来了。
 *
 * @returns 退不成的切片不进结果（状态被别人改过就算了，不强改）
 */
export async function reapDeadSlices(
  store: SliceStore,
  events: EventStream,
  sliceIds: string[],
  options?: {
    actor?: string;
    reason?: string;
    /** 额外清理无停机分类的 running 空壳（需要 projectRoot 才能查活性） */
    includeOrphans?: { projectRoot: string; isProcessAlive?: (pid: number) => boolean };
  },
): Promise<ReapResult[]> {
  const actor = options?.actor ?? 'human';
  const reason = options?.reason ?? '清理死切片：agent 已停机，切片卡在 running';

  const results: ReapResult[] = [];

  for (const sliceId of sliceIds) {
    let slice: SliceData;
    try {
      slice = await store.read(sliceId);
    } catch {
      continue;
    }

    const from = slice.state;
    if (from !== 'running') continue;

    let stallClass = slice.stall.class;
    if (stallClass !== null) {
      // 有分类的：提问回路的 agent 还活着 —— 不算死
      if (stallClass === 'agent_question') continue;
    } else {
      // 无分类的：只有调用方显式要求，且现场判据说它已经不在了，才动
      const orphanOpt = options?.includeOrphans;
      if (!orphanOpt) continue;
      // 判据用**同一份**（`classifyOrphanShell`）—— 见那里的说明：
      // 判据分叉的后果是「列表里看得见、清理时却不认」。
      const live = classifyOrphanShell(
        orphanOpt.projectRoot,
        sliceId,
        orphanOpt.isProcessAlive,
      );
      if (live === null) continue;
      if (live.state !== 'stale' && live.state !== 'dead') continue;
      // 清理事件里要写清「为什么认为是空壳」—— 没有分类可写，就把活性判定写上
      stallClass = null;
    }

    let to: string = from;
    let reverted = false;

    try {
      await store.transit(sliceId, 'RUN_FINISH', actor);
      to = 'frozen';
      reverted = true;
    } catch {
      // 状态被别处改过 —— 不强改。分类照写，事件照留。
    }

    await events.append(sliceId, 'slice.state.changed', actor, {
      sliceId,
      from,
      to,
      event: 'RUN_FINISH',
      reason,
      reaped: true,
      previousStallClass: stallClass,
      orphanShell: stallClass === null,
    });

    results.push({ sliceId, title: slice.title, from, to, reverted, stallClass: stallClass ?? 'orphan_shell' });
  }

  return results;
}
