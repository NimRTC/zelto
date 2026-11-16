// Web 驾驶舱的 API 层（ADR-072）
//
// 只读为主 + **唯一**的写操作（签字）。
//
// 所有事实都来自 `core/` 的既有模块：
//   - SliceStore / EventStream —— 状态与事件
//   - SignManager —— 签字请求
//   - AuditTrail —— 审计报告
//   - core/sign-review —— 签字复查的事实与判定（与 CLI 共用同一份）
//
// 不在这里做任何**新的判定**（C3）：能读的事实就读，
// 需要的判定调 core 里已经存在的纯函数。

import { join } from 'node:path';
import { SliceStore } from '../../core/slice/store.js';
import { EventStream } from '../../core/events/stream.js';
import { SignManager } from '../../core/gate/sign.js';
import { AuditTrail } from '../../core/audit/trail.js';
import { collectSignReviewFacts } from '../../core/sign-review/collect.js';
import { evaluateSignChecks } from '../../core/sign-review/evaluate.js';
import type { SignCheck, SignReviewFacts } from '../../core/sign-review/types.js';
import { WorktreeManager } from '../../core/worktree/manager.js';
import { BudgetCollector, UNLIMITED_BUDGET } from '../../core/budget/collector.js';
import { MetricsCollector } from '../../core/metrics/collector.js';

/** 一片切片的总览行 —— 前端列表用。 */
export interface SliceSummary {
  id: string;
  title: string;
  state: string;
  type: string | null;
  updatedAt: string;
  createdAt: string;
  /**
   * 追溯三元组 —— **条目 + 明细**（ADR-072 §6：「切片总览（… 追溯 …）」）。
   *
   * 一开始这里只有条目数，理由是「列表页放不下那么多字」。
   * 但那其实是在**替人决定**该看什么：追溯链是签字四项确认之一
   * （ADR-072 §5.2），列表页看不到明细，人就得逐片点进去才知道
   * 「这片到底追溯了什么」—— 多点几次，还是看不到全局。
   *
   * 计数保留：前端列表要先按数量排序/筛选时用得上。
   */
  trace: {
    requirements: string[];
    contracts: string[];
    tests: string[];
    /** 各类的条目数 —— 列表页排版用，不必自己算 length */
    counts: { requirements: number; contracts: number; tests: number };
  };
  /** 写集条目数 */
  writeCount: number;
  /** 是否停机 */
  stalled: boolean;
  /** 停机分类 */
  stallClass: string | null;
  /** agent 运行次数 */
  runCount: number;
  /** 最近一次 agent 运行是否成功 */
  lastRunOk: boolean | null;
  /** 该片的累计花费（USD）—— 来自 budget.spent 事件 */
  spentUsd: number;
}

/** 切片详情 —— 含签字复查的事实与判定。 */
export interface SliceDetail {
  slice: unknown;
  /** 签字复查的事实（与 CLI `--review` 同一份） */
  facts: SignReviewFacts;
  /** 签字复查的四项判定（与 CLI 同一份） */
  checks: SignCheck[];
  /** 追溯链明细 */
  trace: { requirements: string[]; contracts: string[]; tests: string[] };
  /** 写集 */
  writes: string[];
}

export class WebApi {
  private readonly repoRoot: string;
  private readonly store: SliceStore;
  private readonly events: EventStream;
  private readonly signs: SignManager;
  private readonly audit: AuditTrail;
  private readonly worktrees: WorktreeManager;
  private readonly budget: BudgetCollector;
  private readonly metrics: MetricsCollector;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    const zeltoDir = join(repoRoot, '.zelto');
    this.store = new SliceStore(join(zeltoDir, 'slices'));
    this.events = new EventStream(join(zeltoDir, 'events'));
    this.signs = new SignManager(zeltoDir, this.events, this.store);
    this.audit = new AuditTrail(this.events);
    this.worktrees = new WorktreeManager(repoRoot);
    // BudgetCollector 要 zeltoDir 才能读 config.yaml 里的 budgetLimitUsd
    this.budget = new BudgetCollector(this.events, zeltoDir);
    this.metrics = new MetricsCollector(this.events);
  }

  /** 切片总览列表。 */
  async listSlices(): Promise<SliceSummary[]> {
    const ids = await this.store.list();
    const out: SliceSummary[] = [];
    for (const id of ids) {
      try {
        const slice = await this.store.read(id);
        out.push(await toSummary(slice, this.budget));
      } catch {
        // 状态文件坏了 —— 跳过，不让一片坏的挡住整个列表
      }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** 切片详情 —— 含签字复查的事实与判定。 */
  async getSlice(id: string): Promise<SliceDetail | null> {
    const slice = await this.store.read(id);
    const facts = await this.collectFacts(id);
    const checks = evaluateSignChecks(facts);
    return {
      slice,
      facts,
      checks,
      trace: facts.trace,
      writes: slice.writes ?? [],
    };
  }

  /**
   * 收集签字复查事实 —— 与 CLI 走**同一个** core 实现（ADR-072 §5.1）。
   */
  private async collectFacts(id: string): Promise<SignReviewFacts> {
    return collectSignReviewFacts(id, {
      readSlice: (sliceId) => this.store.read(sliceId),
      readEvents: (sliceId) => this.events.read(sliceId),
      worktreePath: (sliceId) =>
        this.worktrees.exists(sliceId) ? this.worktrees.pathFor(sliceId) : null,
      repoRoot: this.repoRoot,
    });
  }

  /** 某片的事件流。 */
  async sliceEvents(id: string, limit?: number): Promise<unknown[]> {
    const list = await this.events.read(id);
    const trimmed = limit && limit > 0 ? list.slice(-limit) : list;
    return trimmed;
  }

  /** 某片的审计报告。 */
  async sliceAudit(id: string): Promise<unknown> {
    return this.audit.forSlice(id);
  }

  /** 全局最近事件 —— 跨所有切片。 */
  async recentEvents(limit: number): Promise<unknown[]> {
    const ids = await this.store.list();
    const all: Array<{ ts: string; slice: string; type: string; actor: string; payload: unknown }> = [];
    for (const id of ids) {
      const list = await this.events.read(id);
      for (const e of list) {
        all.push({
          ts: e.ts,
          slice: e.slice,
          type: e.type,
          actor: e.actor,
          payload: e.payload,
        });
      }
    }
    all.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return all.slice(0, limit);
  }

  /** 签字请求清单。 */
  async listSignRequests(status?: string): Promise<unknown[]> {
    const valid = status === 'pending' || status === 'approved' || status === 'rejected' || status === 'revoked'
      ? status
      : undefined;
    return this.signs.list(valid);
  }

  /**
   * 概况 —— 切片数 / 状态分布 / 待签字 / 成本。
   *
   * 成本部分（ADR-072 §6：「概况（切片数 / 状态分布 / 待签字数 / 成本）」）：
   * - `spentUsd`：全项目累计花费（各片 budget.spent 之和）
   * - `limitUsd`：预算上限（来自 config.yaml 的 budgetLimitUsd）
   * - `exhausted`：是否已超支
   *
   * 上限可能是 Infinity（ADR-035 §3.6：`budgetLimitUsd: 0` = 不限）。
   * Infinity 不能 JSON 序列化成数字 —— JSON.stringify 会把它变成 null。
   * 所以对外用 `null` 表示「不限」，另给一个 `unlimited: true` 标志，
   * 前端据此显示「不限」而不是「$null」。
   */
  async summary(): Promise<unknown> {
    const slices = await this.listSlices();
    const byState: Record<string, number> = {};
    for (const s of slices) {
      byState[s.state] = (byState[s.state] ?? 0) + 1;
    }
    const pending = await this.signs.list('pending');
    const stalled = slices.filter((s) => s.stalled);

    const spentUsd = slices.reduce((sum, s) => sum + s.spentUsd, 0);
    const rawLimit = await this.budget.getLimit('');
    const unlimited = rawLimit === UNLIMITED_BUDGET;
    const limitUsd = unlimited ? null : rawLimit;
    const exhausted = !unlimited && spentUsd >= rawLimit;

    return {
      totalSlices: slices.length,
      byState,
      pendingSignCount: pending.length,
      pendingSigns: pending.map((p) => ({
        id: p.id,
        sliceId: p.sliceId,
        requestedAt: p.requestedAt,
      })),
      stalledCount: stalled.length,
      stalledSlices: stalled.map((s) => ({ id: s.id, stallClass: s.stallClass })),
      // ── 成本（ADR-072 §6）──
      spentUsd,
      limitUsd,
      unlimited,
      exhausted,
      /** 超支比例（0~1+）；不限时为 null —— 没有上限就没有比例 */
      spendRatio: unlimited ? null : rawLimit > 0 ? spentUsd / rawLimit : 0,
    };
  }

  /**
   * 批准签字 —— **唯一的写操作**。
   *
   * 服务端**自己重新算一遍**四项判定（不信前端传来的结果），
   * 四项全绿才签；任一不过 → 拒绝并回传是哪一项不过（ADR-072 §5.2）。
   *
   * 返回 `{ ok: false, reason, checks }` 表示**没有签字**，
   * 与「签了但状态特殊」区分开。
   *
   * @param signId 签字请求 id
   * @param clientChecks 前端传来的四项判定结果 —— **当凭据用**，不作数。
   *   ADR-072 §5.2：「必须带四项判定结果」+「只把前端传的当作
   *   『人确认过了这四项』的凭据」。缺了它就说明人没确认过 → 拒绝。
   */
  async approveSign(
    signId: string,
    clientChecks?: unknown,
  ): Promise<
    | { ok: true; request: unknown; checks: SignCheck[] }
    | { ok: false; reason: string; checks: SignCheck[]; error?: string }
  > {
    let request;
    try {
      request = await this.signs.get(signId);
    } catch {
      return { ok: false, reason: `签字请求不存在：${signId}`, checks: [] };
    }

    if (request.status !== 'pending') {
      return {
        ok: false,
        reason: `签字请求已是 ${request.status} 状态，不能再批准`,
        checks: [],
      };
    }

    // 前端必须带四项判定结果 —— 这是「人确认过了」的凭据。
    //
    // 缺凭据就拒绝：**不是**因为不信前端的内容（内容本来就不作数），
    // 而是因为「没带」本身就说明流程没走完 —— 人没在页面上看过这四项。
    // 这一条是「先看后签」的前半段；后半段是下面的服务端重算。
    const acknowledged = parseClientChecks(clientChecks);
    if (!acknowledged.ok) {
      return {
        ok: false,
        reason: acknowledged.reason,
        checks: [],
      };
    }

    // 服务端重算判定 —— 前端传什么都不作数
    let checks: SignCheck[];
    try {
      const facts = await this.collectFacts(request.sliceId);
      checks = evaluateSignChecks(facts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: `收集签字复查事实失败：${message}`,
        checks: [],
      };
    }

    const failing = checks.filter((c) => !c.ok);
    if (failing.length > 0) {
      // fail closed —— 有确认项不通过就不签
      return {
        ok: false,
        reason: `签字前确认项未通过：${failing.map((c) => c.label).join('、')}`,
        checks,
      };
    }

    try {
      const approved = await this.signs.approve(signId, 'human', null);
      return { ok: true, request: approved, checks };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `批准失败：${message}`, checks };
    }
  }
}

/**
 * 把切片状态文件收敛成列表行。
 *
 * 花费（spentUsd）从 **budget.spent 事件**算 —— 那是权威的成本来源
 * （core/budget/collector.ts 的注释明确说了这一点）。
 * 不去翻 agent 的原始输出 —— 那是实现细节，且格式不保证稳定。
 */
async function toSummary(
  slice: {
    id: string;
    title: string;
    state: string;
    type?: string;
    updatedAt: string;
    createdAt: string;
    trace?: { requirements?: unknown[]; contracts?: unknown[]; tests?: unknown[] };
    writes?: string[];
    stall?: { class: string | null };
    runs?: Array<{ ok: boolean }>;
  },
  budget: BudgetCollector,
): Promise<SliceSummary> {
  const runs = slice.runs ?? [];
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;

  const requirements = toStringList(slice.trace?.requirements);
  const contracts = toStringList(slice.trace?.contracts);
  const tests = toStringList(slice.trace?.tests);

  return {
    id: slice.id,
    title: slice.title,
    state: slice.state,
    type: slice.type ?? null,
    updatedAt: slice.updatedAt,
    createdAt: slice.createdAt,
    trace: {
      requirements,
      contracts,
      tests,
      counts: {
        requirements: requirements.length,
        contracts: contracts.length,
        tests: tests.length,
      },
    },
    writeCount: slice.writes?.length ?? 0,
    stalled: slice.stall?.class != null,
    stallClass: slice.stall?.class ?? null,
    runCount: runs.length,
    lastRunOk: lastRun ? lastRun.ok : null,
    spentUsd: await budget.getSpent(slice.id),
  };
}

/** 追溯三元组的元素统一成字符串数组。 */
function toStringList(value: unknown[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
}

/**
 * 校验前端传来的「人确认过了这四项」凭据。
 *
 * **只校验「形状对不对」，不校验「内容真不真」** ——
 * 内容由服务端自己重算（`evaluateSignChecks`）说了算。
 * 前端传的内容在这里是**完全不作数**的。
 *
 * 那为什么还要校验形状？因为「没传」本身就是一个信号：
 * 说明人没在页面上看过那四项（或者有人绕过前端直接调 API）。
 * 两种情况都不该被签字。
 *
 * 要求：
 * - 是一个数组
 * - 至少 4 项（ADR-072 §5.2 的四项确认）
 * - 每项有 label / ok / evidence / adrRef
 *
 * 刻意**不**校验「四项都 ok」—— 那是服务端重算后才知道的事。
 * 前端报「有一项没过」也是有效凭据（说明人看到了失败项）。
 */
function parseClientChecks(
  raw: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      reason: '缺少确认项凭据：签字必须带上前端渲染给人看过的那四项（ADR-072 §5.2）',
    };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: '确认项凭据格式非法：应为数组' };
  }
  if (raw.length < 4) {
    return {
      ok: false,
      reason: `确认项凭据不完整：收到 ${raw.length} 项，至少要有 4 项（ADR-072 §5.2）`,
    };
  }
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, reason: '确认项凭据格式非法：每一项都应是对象' };
    }
    const c = item as Record<string, unknown>;
    if (typeof c.label !== 'string' || typeof c.ok !== 'boolean') {
      return { ok: false, reason: '确认项凭据格式非法：每项都该有 label 与 ok' };
    }
  }
  return { ok: true };
}
