// Budget collector — tracks spend from event stream against config limits
// Implements BudgetPort (defined in src/core/ports/index.ts)
// C2: zero npm dependencies (Node built-ins only)
// C3: deterministic — no model calls, no network

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventStream, EventEnvelope } from '../events/stream.js';

const DEFAULT_BUDGET_LIMIT = 1.0; // USD

/**
 * 「不限」的哨兵值。
 *
 * `budgetLimitUsd: 0` 在 config.yaml 的注释里写的是「unlimited」，但实现
 * 一直把它当成无效值回落到默认 1.0 —— 注释与实现不符 = 假的（ADR-035 §3.6）。
 *
 * 用 `Infinity` 而不是 `0` 表示不限：上限在别处要做比较
 * （`spent >= limit`），`Infinity` 让比较天然正确，而 `0` 会让
 * 「不限」被误读成「一分钱都不许花」。
 */
export const UNLIMITED_BUDGET = Number.POSITIVE_INFINITY;

/**
 * 成本的「测没测到」——三态，不是布尔。
 *
 * 为什么不能是布尔：布尔只能表达「测到 / 没测到」，
 * 而真相有三种（ADR-035 §3.5 的同一原则）：
 *
 * | 状态 | 含义 | 界面显示 |
 * |---|---|---|
 * | `unmeasured` | 压根没有成本证据 —— 不知道花了多少 | 「未记账」 |
 * | `unavailable` | 核查过，但**拿不到**金额 | 「未测到」 |
 * | `measured` | 测到了金额（金额可能就是 0） | 「$X.XXXX」 |
 *
 * `unavailable` 与 `unmeasured` 混同的后果很具体：把「没测到」显示成 $0.0000，
 * 人会以为这片没花钱；反过来把「测得 0」显示成「未记账」，
 * 人会以为账丢了。两者都不是事实。
 *
 * 判定靠 `budget.spent` 事件的 payload：
 * - 有 `budget.spent` 且 `measured !== false` → 测到了（金额可能是 0）
 * - 有 `budget.spent` 且 `measured === false` → **核查过但拿不到金额**
 *   （回填时给那些 agent 输出为空、拿不到用量的切片补的标记）
 * - 一条成本事件都没有 → 压根没核查
 */
export type CostMeasurement = 'unmeasured' | 'unavailable' | 'measured';

export class BudgetCollector {
  private readonly events: EventStream;
  private readonly zeltoDir: string;

  constructor(events: EventStream, zeltoDir: string = '.zelto') {
    this.events = events;
    this.zeltoDir = zeltoDir;
  }

  /**
   * Calculate total cost spent for a slice from event stream.
   * Reads `amount` from `budget.spent` events (authoritative cost source).
   */
  async getSpent(sliceId: string): Promise<number> {
    return (await this.getSpentDetail(sliceId)).spent;
  }

  /**
   * 花费 + 「有没有测到」。
   *
   * 为什么不能只看 `getSpent()` 的数字：没见过成本事件的切片返回 0，
   * 「真的没花钱」和「压根没记账」在界面上都是 $0.0000 —— 那是在
   * 用假数据撑门面。`measured=false` 时界面必须显示「未记账」而不是金额。
   *
   * 判据：事件流里出现过任何一条**有效**的成本证据
   * （`budget.spent` 且 `measured !== false`，或 `llm.called`）。
   * 只读 `budget.spent` 不够 —— LLM 调用先写 `llm.called`，成本事件
   * 万一写失败，token 花掉了但账没记上，那也是「有证据但没金额」。
   *
   * 三态（`CostMeasurement`）：
   * - `unmeasured` —— 一条有效证据都没有（压根没核查）
   * - `unavailable` —— 有 `budget.spent` 但标了 `measured: false`
   *   （核查过了，agent 没报出用量，拿不到金额）
   * - `measured` —— 测到了（金额可能正好是 0）
   */
  async getSpentDetail(
    sliceId: string,
    /**
     * 已经读好的事件流 —— 有它就不再读文件。
     *
     * 为什么加这个参数：驾驶舱的 `/api/summary` 一次要给 149 片
     * 算成本，而「判基线还是开发」也要同一份事件流 ——
     * 两边各读一遍就是 248 次读（实测 2026-11-27），
     * 其中最大的几份事件流各 400+ KB，白扔一半 IO。
     *
     * 判据没变：算的还是同一批事件的同一批字段，
     * 只是不再**重复读同一份文件**。
     */
    preloaded?: EventEnvelope[],
  ): Promise<{ spent: number; measured: boolean; measurement: CostMeasurement }> {
    const evts = preloaded ?? (await this.events.read(sliceId));
    let total = 0;
    let measured = false;
    // 「核查过但拿不到金额」—— 与「压根没核查」分开。
    let unavailable = false;

    for (const evt of evts) {
      if (evt.type === 'budget.spent') {
        // `measured: false` 的事件是「已核查但拿不到金额」的标记，
        // 不计入花费，也不算「测到」—— 但它证明有人核查过这一片。
        if (evt.payload?.measured === false) {
          unavailable = true;
          continue;
        }
        total += this.extractAmount(evt);
        measured = true;
      } else if (evt.type === 'llm.called') {
        measured = true;
      }
    }

    const measurement: CostMeasurement = measured ? 'measured' : unavailable ? 'unavailable' : 'unmeasured';
    return { spent: total, measured, measurement };
  }

  /**
   * Read budget limit from .zelto/config.yaml.
   *
   * 语义（ADR-035 §3.6）：
   * - `budgetLimitUsd > 0` → 这个数就是上限
   * - `budgetLimitUsd: 0` → 不限（返回 `UNLIMITED_BUDGET`）
   * - 没有这一项 / 解析不出数 → 默认 `1.0`
   */
  async getLimit(_sliceId: string): Promise<number> {
    const configPath = join(this.zeltoDir, 'config.yaml');
    if (!existsSync(configPath)) {
      return DEFAULT_BUDGET_LIMIT;
    }

    try {
      const content = readFileSync(configPath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('budgetLimitUsd:')) {
          const val = Number.parseFloat(trimmed.slice(15).trim());
          if (!Number.isNaN(val) && val >= 0) {
            return val === 0 ? UNLIMITED_BUDGET : val;
          }
        }
      }
    } catch {
      // Fall through to default
    }

    return DEFAULT_BUDGET_LIMIT;
  }

  /**
   * Check if a slice has exhausted its budget.
   *
   * 上限为「不限」时永远不算超支 —— 没有上限就没有闸门。
   */
  async isExhausted(sliceId: string): Promise<boolean> {
    const [spent, limit] = await Promise.all([
      this.getSpent(sliceId),
      this.getLimit(sliceId),
    ]);
    if (!Number.isFinite(limit)) return false;
    return spent >= limit;
  }

  /**
   * Extract cost amount from a budget.spent event payload.
   */
  private extractAmount(evt: EventEnvelope): number {
    const amount = evt.payload?.amount;
    if (typeof amount === 'number') return amount;
    if (typeof amount === 'string') {
      const parsed = Number.parseFloat(amount);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  }
}
