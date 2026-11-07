// 看板的成本与 token 汇总 —— 事件流是唯一真源
//
// 为什么单独一个模块：看板有三处渲染（TTY / JSON / HTML），成本口径必须只有一份。
// 三处各算一遍 totals 迟早漂移 —— 这正是 zelto 自己在 ADR-012（单一并行执行实现）
// 与 catalog.ts（命令目录唯一真源）里反复防的那类事。
//
// 口径（ADR-035）：
//   - `budget.spent` 带 `source: 'agent'` → agent 干活花的钱，附 inputTokens/outputTokens
//   - `budget.spent` 不带 source（reason 形如 `llm:<model>`）→ 规划期草稿花的钱
//   - `llm.called` → 规划期 LLM 的 token 明细
//
// 「测到 0」与「没测到」严格分开：measured 是独立标志位。
// 0 是有效数据（ADR-035 §3.5），把它当成「没测到」会让看板凭空少一片。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetCollector } from '../../core/budget/collector.js';
import { events, ZELTO_DIR } from './shared.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SliceCost {
  /** 总花费（agent + llm），美元 */
  totalCost: number;
  /** agent 执行花费 */
  agentCost: number;
  /** 规划期 LLM 草稿花费 */
  llmCost: number;
  /** agent 侧 input token */
  agentInputTokens: number;
  /** agent 侧 output token */
  agentOutputTokens: number;
  /** agent 侧 token 合计 */
  agentTokens: number;
  /** 规划期 LLM input token */
  llmPromptTokens: number;
  /** 规划期 LLM output token */
  llmCompletionTokens: number;
  /** 规划期 LLM token 合计 */
  llmTokens: number;
  /** 全部 token */
  totalTokens: number;
  /** agent 会话次数 —— 每次 agent 退出记一条 */
  agentCalls: number;
  /** LLM 通路调用次数 */
  llmCalls: number;
  /** 是否测到过用量 —— false 是「没测到」，与 0 严格分开 */
  measured: boolean;
}

export interface CostTotals {
  totalCost: number;
  agentCost: number;
  llmCost: number;
  agentInputTokens: number;
  agentOutputTokens: number;
  agentTokens: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  llmTokens: number;
  totalTokens: number;
  agentCalls: number;
  llmCalls: number;
  /** 测到用量的切片数 */
  measuredSlices: number;
  /** 没测到用量的切片数（有切片但一条成本事件都没有） */
  unmeasuredSlices: number;
}

/** 一条待签字请求（来自 `.zelto/locks/sign-*.json`） */
export interface PendingSign {
  id: string;
  sliceId: string;
  requestedAt: string;
}

// ─── Cost Cache ──────────────────────────────────────────────────────────────
// 事件流是 append-only 的，文件 mtime 没变就说明没有新记录 —— 缓存按 mtime 失效。

const costCache = new Map<string, { mtimeMs: number; cost: SliceCost }>();

function emptyCost(): SliceCost {
  return {
    totalCost: 0,
    agentCost: 0,
    llmCost: 0,
    agentInputTokens: 0,
    agentOutputTokens: 0,
    agentTokens: 0,
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
    llmTokens: 0,
    totalTokens: 0,
    agentCalls: 0,
    llmCalls: 0,
    measured: false,
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 逐个切片收集成本与 token。
 *
 * 读的是 `.zelto/events/<sliceId>/events.jsonl` —— 事件流是唯一真源，
 * 看板不另存一份账（否则两处会漂移）。
 */
export function collectCosts(): Map<string, SliceCost> {
  const dir = join(ZELTO_DIR, 'events');
  const costMap = new Map<string, SliceCost>();
  if (!existsSync(dir)) return costMap;

  for (const sd of readdirSync(dir, { withFileTypes: true })) {
    if (!sd.isDirectory()) continue;
    const sliceId = sd.name;
    const f = join(dir, sliceId, 'events.jsonl');
    if (!existsSync(f)) continue;

    let mtimeMs = 0;
    try {
      mtimeMs = statSync(f).mtimeMs;
    } catch {
      /* stat 失败 → 当作没缓存 */
    }

    const cached = costCache.get(sliceId);
    if (cached && cached.mtimeMs === mtimeMs) {
      if (cached.cost.measured) costMap.set(sliceId, cached.cost);
      continue;
    }

    const cost = emptyCost();
    try {
      for (const line of readFileSync(f, 'utf-8').split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          if (e.type === 'llm.called') {
            cost.measured = true;
            cost.llmCalls++;
            const p = num(e.payload?.promptTokens);
            const c = num(e.payload?.completionTokens);
            cost.llmPromptTokens += p;
            cost.llmCompletionTokens += c;
            cost.llmTokens += num(e.payload?.totalTokens) || p + c;
          } else if (e.type === 'budget.spent') {
            cost.measured = true;
            const amount = num(e.payload?.amount);
            if (e.payload?.source === 'agent') {
              cost.agentCalls++;
              cost.agentCost += amount;
              cost.agentInputTokens += num(e.payload?.inputTokens);
              cost.agentOutputTokens += num(e.payload?.outputTokens);
            } else {
              // 规划期 LLM：老的 llm 侧事件不带 source，靠 reason 区分的那批也落这里
              cost.llmCost += amount;
            }
          }
        } catch {
          /* malformed line → skip */
        }
      }
    } catch {
      /* 读不了 → 这一片没有可用的账 */
    }

    // 从来没测到过用量 → 不进 map。这跟「测到 0」是两回事。
    if (!cost.measured) continue;

    cost.agentTokens = cost.agentInputTokens + cost.agentOutputTokens;
    cost.totalCost = cost.agentCost + cost.llmCost;
    cost.totalTokens = cost.agentTokens + cost.llmTokens;
    costMap.set(sliceId, cost);
    costCache.set(sliceId, { mtimeMs, cost });
  }
  return costMap;
}

/**
 * 把逐片成本加总成一份总计。
 *
 * `totalSlices` 是分母 —— 用来回答「有多少片根本没测到用量」。
 */
export function sumCosts(costMap: Map<string, SliceCost>, totalSlices = 0): CostTotals {
  const t: CostTotals = {
    totalCost: 0,
    agentCost: 0,
    llmCost: 0,
    agentInputTokens: 0,
    agentOutputTokens: 0,
    agentTokens: 0,
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
    llmTokens: 0,
    totalTokens: 0,
    agentCalls: 0,
    llmCalls: 0,
    measuredSlices: 0,
    unmeasuredSlices: 0,
  };

  for (const c of costMap.values()) {
    t.totalCost += c.totalCost;
    t.agentCost += c.agentCost;
    t.llmCost += c.llmCost;
    t.agentInputTokens += c.agentInputTokens;
    t.agentOutputTokens += c.agentOutputTokens;
    t.agentTokens += c.agentTokens;
    t.llmPromptTokens += c.llmPromptTokens;
    t.llmCompletionTokens += c.llmCompletionTokens;
    t.llmTokens += c.llmTokens;
    t.totalTokens += c.totalTokens;
    t.agentCalls += c.agentCalls;
    t.llmCalls += c.llmCalls;
    if (c.measured) t.measuredSlices++;
  }

  // 只统计「确实有切片」的分母 —— 否则 version-* 事件目录会让数字失真
  t.unmeasuredSlices = Math.max(0, totalSlices - t.measuredSlices);
  return t;
}

/** 按 token 消耗排前 N 片 —— 回答「钱和 token 花在哪了」 */
export function topSlicesByTokens(
  costMap: Map<string, SliceCost>,
  limit = 8,
): Array<{ sliceId: string; cost: SliceCost }> {
  return [...costMap.entries()]
    .filter(([, c]) => c.totalTokens > 0 || c.totalCost > 0)
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens || b[1].totalCost - a[1].totalCost)
    .slice(0, limit)
    .map(([sliceId, cost]) => ({ sliceId, cost }));
}

// ─── Budget Limit ────────────────────────────────────────────────────────────

/**
 * 每片的预算上限（美元）。
 *
 * 口径直接取 `core/budget/collector.ts` 的 `BudgetCollector.getLimit()` ——
 * 不在这里重写一遍 YAML 解析：`0` = 不限、缺失 = 默认 1.0 这些语义
 * 都在那边定义过（ADR-035 §3.6），重写必然漂移。
 */
export async function readBudgetLimit(): Promise<number> {
  try {
    return await new BudgetCollector(events, ZELTO_DIR).getLimit('');
  } catch {
    return 1.0;
  }
}

// ─── Pending Signs ───────────────────────────────────────────────────────────

/**
 * 待签字队列。
 *
 * 真源是 `.zelto/locks/sign-*.json` —— 与 `zelto inbox`、`zelto merge`、
 * `zelto next` 同源（见 `cli/commands/pending-actions.ts` 的说明）。
 *
 * 只认 `sign-` 前缀的文件：locks 目录里还放着写集预约（`<sliceId>.json`），
 * 那是另一回事。
 */
export function readPendingSigns(): PendingSign[] {
  const dir = join(ZELTO_DIR, 'locks');
  if (!existsSync(dir)) return [];

  const out: PendingSign[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('sign-') || !f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        if (d?.status !== 'pending') continue;
        out.push({
          id: typeof d.id === 'string' ? d.id : f.replace(/\.json$/, ''),
          sliceId: typeof d.sliceId === 'string' ? d.sliceId : '',
          requestedAt: typeof d.requestedAt === 'string' ? d.requestedAt : '',
        });
      } catch {
        /* malformed → skip */
      }
    }
  } catch {
    /* 读不了 → 空队列 */
  }

  // 排队最久的先办
  out.sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime());
  return out;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function fmtCost(cost: number): string {
  if (!Number.isFinite(cost) || cost === 0) return '$0';
  if (cost < 0.01) return '$' + cost.toFixed(4);
  if (cost < 1) return '$' + cost.toFixed(3);
  return '$' + cost.toFixed(2);
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

/** 预算上限的显示：不限 / 具体数额 */
export function fmtLimit(limit: number): string {
  return Number.isFinite(limit) ? fmtCost(limit) : '不限';
}
