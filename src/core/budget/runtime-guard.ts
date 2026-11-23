// 运行中预算拦截（ZD-007）
//
// 病灶（nimrtc v1.4，2026-11-20）：一轮烧了 $5.86（上限 $1.00），
// 产物其实做完了，但因为超预算**没进门禁**，切片卡在 frozen。
// 更糟的是「预算耗尽」这个停机分类**误导人** —— 它看起来像「agent 跑砸了」，
// 实际是「agent 跑成了但超了闸门」，人第一反应是重跑 → 再烧一遍。
//
// 根因：`checkBudget` 只在**起跑前**调一次，跑完后由 `settleRunCost`
// 记账时复判 —— **运行期间没有任何地方查预算**。
// 于是 agent 想烧多少烧多少，闸门形同虚设。
//
// 本模块提供**可中断点**：运行期间定期查花费，超了就停手。
//
// C2：本文件属于 core/，只用 Node 内置。
// C3：确定性 —— 不调模型、不触网，只读文件 + 纯计算。

/**
 * 一次预算检查的结论。
 *
 * 为什么不是布尔：三种状态必须分开（与 `CostMeasurement` 同一原则）——
 * - `ok` —— 没超，继续跑
 * - `exceeded` —— 超了，**停手**
 * - `unknown` —— **测不到**花费（适配器报不出运行中用量）
 *   → **不判定超支**，继续跑。
 *
 * `unknown` 合并进「ok」是最容易犯的错：把「测不到」当成「没花钱」，
 * 预算闸门就成了假闸门 —— 恰恰是 ZD-007 要修的那个病。
 */
export type BudgetCheckResult =
  | { status: 'ok'; spentUsd: number; limitUsd: number }
  | { status: 'exceeded'; spentUsd: number; limitUsd: number }
  | { status: 'unknown'; spentUsd: null; limitUsd: number };

/**
 * 运行中预算检查器。
 *
 * 职责：给一个**正在跑**的 agent 会话定期查花费，超了就喊停。
 *
 * 花费从哪来：适配器的 `getLiveUsage`（运行中累计用量）。
 * 拿不到 → `unknown` → 不判定超支（但这意味着**这个切片没有运行中闸门**，
 * 只能靠起跑前那次检查与跑完后的复判兜底 —— 所以拿不到时值得提醒人）。
 */
export class RuntimeBudgetGuard {
  /**
   * @param limitUsd 上限（美元）。`Infinity` = 不限 → 永远不判超支。
   * @param readLiveUsage 读运行中累计用量的回调。返回 null = 测不到。
   */
  constructor(
    private readonly limitUsd: number,
    private readonly readLiveUsage: () => { costUsd: number } | null,
  ) {}

  /**
   * 上限是否「不限」。
   *
   * 不限时**不做检查** —— 没有上限就没有闸门，
   * 白花一次 IO 还会给人「有闸门在管」的错觉。
   */
  get enabled(): boolean {
    return Number.isFinite(this.limitUsd);
  }

  /**
   * 查一次预算。
   *
   * 不抛异常 —— 查不到 / 读失败 → `unknown`（不判定超支）。
   * 预算闸门读失败不该把 agent 停掉：那是「测不到」，不是「超支」。
   */
  check(): BudgetCheckResult {
    if (!this.enabled) {
      return { status: 'ok', spentUsd: 0, limitUsd: this.limitUsd };
    }

    let usage: { costUsd: number } | null;
    try {
      usage = this.readLiveUsage();
    } catch {
      return { status: 'unknown', spentUsd: null, limitUsd: this.limitUsd };
    }

    if (!usage) {
      return { status: 'unknown', spentUsd: null, limitUsd: this.limitUsd };
    }

    const spentUsd = usage.costUsd;
    if (!Number.isFinite(spentUsd) || spentUsd < 0) {
      // 数据坏了 —— 按「测不到」处理，不拿它判超支。
      return { status: 'unknown', spentUsd: null, limitUsd: this.limitUsd };
    }

    if (spentUsd >= this.limitUsd) {
      return { status: 'exceeded', spentUsd, limitUsd: this.limitUsd };
    }
    return { status: 'ok', spentUsd, limitUsd: this.limitUsd };
  }
}

/**
 * 把「超预算」判据抽成一个纯函数（便于测，也便于两处共用同一口径）。
 *
 * @param spentUsd 已花费（null = 测不到）
 * @param limitUsd 上限（Infinity = 不限）
 */
export function isOverBudget(
  spentUsd: number | null,
  limitUsd: number,
): boolean {
  if (!Number.isFinite(limitUsd)) return false; // 不限 → 没有闸门
  if (spentUsd === null) return false; // 测不到 → 不判定超支
  if (!Number.isFinite(spentUsd) || spentUsd < 0) return false;
  return spentUsd >= limitUsd;
}

/**
 * 超预算时给人和 agent 看的话。
 *
 * 措辞要点：**说清是「闸门拦下的」而不是「跑砸了」**（ZD-007 的病灶之一）。
 * 人看到「预算耗尽」的第一反应是「agent 跑砸了，重跑」→ 再烧一遍。
 * 所以这里明说：产物可能已经在盘上，重跑只会再烧一遍钱。
 */
export function budgetInterceptionMessage(opts: {
  sliceId: string;
  spentUsd: number;
  limitUsd: number;
}): string {
  return [
    `⛔ 预算闸门：切片 ${opts.sliceId} 已花 $${opts.spentUsd.toFixed(4)}，` +
      `超过上限 $${opts.limitUsd.toFixed(4)} —— 已叫停 agent。`,
    '   注意：这不是「agent 跑砸了」，是「闸门在运行中拦下的」。',
    '   产物可能已经写在 worktree 里 —— 先看现场，别直接重跑（重跑会再烧一遍钱）。',
    '   要放行就调高 budgetLimitUsd（或设为 0 = 不限）再重跑。',
  ].join('\n');
}
