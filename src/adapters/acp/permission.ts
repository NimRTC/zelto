// ACP 挂起 permission 请求的登记与结算（ADR-141）
//
// ## 为什么这个模块存在
//
// ACP 路线下 C9 的主判定点是 `session/request_permission` 回调 ——
// agent 主动来问，zelto 回答（ADR-133 决策四）。
//
// 这个设计的前提是：**每一次 permission 请求都有一次明确的答复**。
//
// 而终止路径（进程退出 / 空转超时 / 人工停止）**没有结算**挂起的请求 ——
// 那些请求永远悬着：
//
// 1. **追溯链断一次写入** —— 挂起的那次写入既没被判允许、也没被判拒绝，
//    在事件流里**没有 `policy.decision`**（与 ADR-139 修的断链同形状）；
// 2. **agent 侧那个 turn 永远不结束** —— JSON-RPC 请求有 id，
//    不答复就一直等（T3 PR #21439 踩过这个：ACP 取消失败会让 turn 卡住）；
// 3. **判定进行中被终止** —— 回调永远不返回，请求永远没有答复。
//
// ## T3 的原则
//
// T3 的 `docs/internals/03_providers.md` 把这条列在「反复坑到多个 adapter」
// 的陷阱清单里：
//
// > **Terminal settlement.** Every terminal path (completion, Stop, provider
// > error, process exit) must settle open tool calls, subagents, and pending
// > requests.
//
// ## 结算只允许「拒绝」这一个方向
//
// **绝不回 `allow_always`** —— agent 收到它会写进自己的 allowlist
// （`.cursor/permissions.json`），之后同类操作**不再问 zelto** →
// 逐写判定被永久绕过（ADR-133 决策四之二的实测）。
//
// 结算时只在 agent 提供的选项里找 `reject_once` / `reject_always`；
// **一个都找不到**就回 `cancelled` ——
// **绝不回 agent 提供的第一个选项**（那可能就是 `allow_always`）。
//
// ## 幂等与「谁写事件」
//
// 结算可能被调用多次（超时 → 杀进程 → exit 事件 → 又走一遍退出路径）。
// 每条挂起请求只结算一次 —— 重复结算会写出**重复的事件**，
// 而 C4 说事件流是 append-only，重复事件无法撤销。
//
// **「谁写事件」的规则**：每条挂起请求有一个**归属权**（`resolved`）——
// 判定方与结算方**争抢**它（`resolve()`），**抢到的那一方**负责写那条
// `policy.decision`。这样两条路径**永远不会各写一条**。
//
// **为什么不用「谁先取到谁写」这种破坏性赛跑**：
// 判定方要**问人**（「以后都允许吗」），可能耗很久；终止路径可能**插队**。
// 如果判定方一开始就「取走」请求，终止路径就**看不到**它 →
// 没有事件 → 追溯链断链（ADR-141 要修的正是这个）。
//
// 所以判定方**先干活、后争抢归属权**：
// - 终止路径在判定**期间**到达 → 结算方抢到 → 写「因终止未处理」事件；
// - 判定**先完成** → 判定方抢到 → 写正常判定事件；之后终止路径抢不到 → 不写。
//
// 恰好一条事件，两条路径都不会漏。

import type { AcpPermissionOption } from '../../hook/acp.js';

/**
 * 结算时回给 agent 的答复。
 *
 * 只有两种形状：选了一个**拒绝**选项，或者 `cancelled`。
 * **没有第三种** —— 绝不会是 `allow_always`。
 */
export type SettlementOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } };

/**
 * 一条挂起的 permission 请求。
 *
 * 登记时记下「agent 给了哪些选项」—— 结算时要从中挑一个**拒绝**选项。
 */
export interface PendingPermission {
  /** JSON-RPC 请求 id（agent 侧用来配对答复） */
  requestId: string;
  /** agent 提供的选项 */
  options: AcpPermissionOption[];
  /** 工具名（写进事件，让人看得懂这次是什么操作） */
  tool: string;
  /** 写目标（判不出就是 null —— 不猜） */
  path: string | null;
}

/**
 * 挂起请求的登记册（**按会话**记，不按进程记）。
 *
 * **为什么按会话不按进程**：终止是**会话**级的事实（这个会话的 agent 死了），
 * 不是进程号的事实。而且 `resume()` 会起**新进程**但属于**同一逻辑轮次** ——
 * 挂起集合必须跟着会话走。
 */
export class PendingPermissionRegistry {
  private readonly items = new Map<string, PendingPermission>();
  /** 已结算请求的答复（判定方醒来时来取 —— 见文件头的「谁写事件」） */
  private readonly settled = new Map<string, SettlementOutcome>();
  /** 已有归属方的请求（归属权**只给一次** —— 保证只写一条事件） */
  private readonly resolved = new Map<string, 'judge' | 'termination'>();

  /** 登记一条挂起的请求。 */
  add(item: PendingPermission): void {
    this.items.set(item.requestId, item);
  }

  /**
   * **争抢归属权** —— 判定方与结算方都用这个。
   *
   * 返回 `true` 表示**抢到了**（这一方负责写那条 `policy.decision`）；
   * 返回 `false` 表示**另一方已经抢到**（这一方不写事件）。
   *
   * ## 为什么判定方要**最后**才抢
   *
   * 判定方要**先问人**（「以后都允许吗」），那段时间里进程可能被杀。
   * 如果判定方一开始就把请求从登记册里**取走**，
   * 终止路径就 `drain()` 不到它 → **没有事件** → 追溯链断链。
   *
   * 所以判定方的顺序是：**判定 → 抢归属权 → 写事件**。
   * 终止路径的顺序是：**结算 → 抢归属权 → 写事件**。
   *
   * 两条路径**恰好一条**事件：
   * - 终止路径在判定**期间**到达 → 结算方先抢到 → 写「因终止未处理」；
   * - 判定**先完成** → 判定方先抢到 → 写正常判定；终止路径抢不到 → 不写。
   */
  resolve(requestId: string, owner: 'judge' | 'termination'): boolean {
    if (this.resolved.has(requestId)) return false;
    this.resolved.set(requestId, owner);
    return true;
  }

  /** 这条请求的归属方是谁（没有 → undefined）。 */
  ownerOf(requestId: string): 'judge' | 'termination' | undefined {
    return this.resolved.get(requestId);
  }

  /**
   * 取下一条挂起的请求（**从登记册里移除**）。
   *
   * 取下就移走 —— 终止时结算用这个：取到的就结算掉。
   */
  take(requestId: string): PendingPermission | undefined {
    const item = this.items.get(requestId);
    if (item) {
      this.items.delete(requestId);
      // **注意**：归属权（`resolved`）**不清** ——
      // 判定方醒来后还要靠它知道自己「没抢到」→ 不写重复事件。
    }
    return item;
  }

  /**
   * 登记册里还有几条。
   *
   * **只在测试与诊断里用** —— 业务逻辑靠 `take()` / `drain()` 的取下语义。
   */
  get size(): number {
    return this.items.size;
  }

  /**
   * 全部取出并清空（终止时结算所有挂起请求）。
   *
   * 清空 = 幂等 —— 第二次 `drain()` 拿不到任何东西。
   */
  drain(): PendingPermission[] {
    const all = [...this.items.values()];
    this.items.clear();
    // **归属权（`resolved`）不动** ——
    // 归属权由 `resolve()` 决定，不由 `drain()` 决定。
    //
    // 原因：`drain()` 之后**还要**逐条 `resolve()` ——
    // 那时才知道这条到底归谁（判定方抢到了就是判定方的，终止方不写）。
    // 如果 `drain()` 抢先标成「终止方」，就会把判定方的事件抢掉。
    return all;
  }

  /** 记下某条请求的结算答复。 */
  markSettled(requestId: string, outcome: SettlementOutcome): void {
    this.settled.set(requestId, outcome);
  }

  /**
   * 取某条请求的结算答复（没有 → undefined）。
   *
   * 判定方醒来时用它回复 agent —— 答复内容与结算时选出的一致，
   * 避免「结算选了 reject_once、判定醒来却回 cancelled」这种不一致。
   */
  getSettled(requestId: string): SettlementOutcome | undefined {
    return this.settled.get(requestId);
  }
}

/**
 * 结算用的 `basis` —— 与 `acp:unknown-tool` 形状不同。
 *
 * | basis | 含义 |
 * |---|---|
 * | `acp:unknown-tool` | 我们**看了**这次调用，判不出写目标（agent 的问题） |
 * | `acp:terminated` | 我们**根本没判**（进程没了，zelto 的问题） |
 *
 * 混成一个 → 事后审计分不清是 agent 的问题还是 zelto 的问题。
 */
export const TERMINATED_BASIS = 'acp:terminated';

/**
 * 终止原因 —— 写进事件负载，让人能回答「这次写入为什么没被处理」。
 */
export type TerminationReason = 'timeout' | 'killed' | 'exit';

/**
 * 从 agent 给的选项里挑一个**拒绝**选项。
 *
 * **绝不挑 `allow_always`** —— 见文件头的说明。
 *
 * 找不到 → null（调用方回 `cancelled`）。
 */
export function selectRejectOptionForSettlement(
  options: AcpPermissionOption[] | undefined,
): string | null {
  if (!options) return null;
  // 优先级：`reject_once` > `reject_always` > 任何名字里像拒绝的。
  //
  // **为什么 reject_once 优先**：语义上「这一次不批准」比
  // 「永远不批准」更接近「进程终止了这一次」的实际情况 ——
  // 终止**不是**一条永久策略。
  const rejectOnce = options.find((o) => o.kind === 'reject_once');
  if (rejectOnce) return rejectOnce.optionId;

  const rejectAlways = options.find((o) => o.kind === 'reject_always');
  if (rejectAlways) return rejectAlways.optionId;

  // 兜底：只看 kind 不认得，但 optionId 名字像拒绝。
  //
  // **为什么还要这一档**：agent 的 `kind` 是**可扩展**的枚举 ——
  // 规范说将来可能加新 kind。认不得就当作「拒绝」而不是「放行」
  // （fail closed）。
  const byName = options.find(
    (o) => typeof o.optionId === 'string' && /reject|deny|cancel/i.test(o.optionId),
  );
  return byName ? byName.optionId : null;
}

/**
 * 结算一条挂起请求时**回给 agent 的答复**。
 *
 * - 有拒绝选项 → 回那个选项；
 * - 没有 → 回 `cancelled`（协议允许的自定义 outcome，
 *   语义上「这一轮被取消」）。
 *
 * **绝不会是 `allow_always`** —— 这条是硬规则。
 */
export function renderSettlementOutcome(
  options: AcpPermissionOption[] | undefined,
): SettlementOutcome {
  const reject = selectRejectOptionForSettlement(options);
  if (reject) return { outcome: { outcome: 'selected', optionId: reject } };
  return { outcome: { outcome: 'cancelled' } };
}
