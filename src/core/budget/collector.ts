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
   * 判据：事件流里出现过任何一条成本证据（`budget.spent` 或 `llm.called`）。
   * 只读 `budget.spent` 不够 —— LLM 调用先写 `llm.called`，成本事件
   * 万一写失败，token 花掉了但账没记上，那也是「有证据但没金额」。
   */
  async getSpentDetail(sliceId: string): Promise<{ spent: number; measured: boolean }> {
    const evts = await this.events.read(sliceId);
    let total = 0;
    let measured = false;

    for (const evt of evts) {
      if (evt.type === 'budget.spent') {
        total += this.extractAmount(evt);
        measured = true;
      } else if (evt.type === 'llm.called') {
        measured = true;
      }
    }

    return { spent: total, measured };
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
