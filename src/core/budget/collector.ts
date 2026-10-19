// Budget collector — tracks spend from event stream against config limits
// Implements BudgetPort (defined in src/core/ports/index.ts)
// C2: zero npm dependencies (Node built-ins only)
// C3: deterministic — no model calls, no network

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventStream, EventEnvelope } from '../events/stream.js';

const DEFAULT_BUDGET_LIMIT = 1.0; // USD

export class BudgetCollector {
  private readonly events: EventStream;
  private readonly zeltoDir: string;

  constructor(events: EventStream, zeltoDir: string = '.zelto') {
    this.events = events;
    this.zeltoDir = zeltoDir;
  }

  /**
   * Calculate total cost spent for a slice from event stream.
   * Sums `cost` from `llm.called` and `budget.spent` events.
   */
  async getSpent(sliceId: string): Promise<number> {
    const evts = await this.events.read(sliceId);
    let total = 0;

    for (const evt of evts) {
      if (evt.type === 'llm.called') {
        total += this.extractCost(evt);
      } else if (evt.type === 'budget.spent') {
        total += this.extractCost(evt);
      }
    }

    return total;
  }

  /**
   * Read budget limit from .zelto/config.yaml.
   * Falls back to DEFAULT_BUDGET_LIMIT if not configured.
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
          if (!Number.isNaN(val) && val > 0) {
            return val;
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
   */
  async isExhausted(sliceId: string): Promise<boolean> {
    const [spent, limit] = await Promise.all([
      this.getSpent(sliceId),
      this.getLimit(sliceId),
    ]);
    return spent >= limit;
  }

  /**
   * Extract cost value from an event's payload.
   * Tries `cost` field first, falls back to `amount`, then 0.
   */
  private extractCost(evt: EventEnvelope): number {
    const cost = evt.payload?.cost;
    if (typeof cost === 'number') return cost;
    if (typeof cost === 'string') {
      const parsed = Number.parseFloat(cost);
      if (!Number.isNaN(parsed)) return parsed;
    }
    const amount = evt.payload?.amount;
    if (typeof amount === 'number') return amount;
    if (typeof amount === 'string') {
      const parsed = Number.parseFloat(amount);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  }
}
