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

/** 一片切片的总览行 —— 前端列表用。 */
export interface SliceSummary {
  id: string;
  title: string;
  state: string;
  type: string | null;
  updatedAt: string;
  createdAt: string;
  /** 追溯三元组的条目数 */
  trace: { requirements: number; contracts: number; tests: number };
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

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    const zeltoDir = join(repoRoot, '.zelto');
    this.store = new SliceStore(join(zeltoDir, 'slices'));
    this.events = new EventStream(join(zeltoDir, 'events'));
    this.signs = new SignManager(zeltoDir, this.events, this.store);
    this.audit = new AuditTrail(this.events);
    this.worktrees = new WorktreeManager(repoRoot);
  }

  /** 切片总览列表。 */
  async listSlices(): Promise<SliceSummary[]> {
    const ids = await this.store.list();
    const out: SliceSummary[] = [];
    for (const id of ids) {
      try {
        const slice = await this.store.read(id);
        out.push(toSummary(slice));
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

  /** 概况 —— 切片数 / 状态分布 / 待签字 / 成本。 */
  async summary(): Promise<unknown> {
    const slices = await this.listSlices();
    const byState: Record<string, number> = {};
    for (const s of slices) {
      byState[s.state] = (byState[s.state] ?? 0) + 1;
    }
    const pending = await this.signs.list('pending');
    const stalled = slices.filter((s) => s.stalled);

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
   */
  async approveSign(
    signId: string,
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

/** 把切片状态文件收敛成列表行。 */
function toSummary(slice: {
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
}): SliceSummary {
  const runs = slice.runs ?? [];
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
  return {
    id: slice.id,
    title: slice.title,
    state: slice.state,
    type: slice.type ?? null,
    updatedAt: slice.updatedAt,
    createdAt: slice.createdAt,
    trace: {
      requirements: slice.trace?.requirements?.length ?? 0,
      contracts: slice.trace?.contracts?.length ?? 0,
      tests: slice.trace?.tests?.length ?? 0,
    },
    writeCount: slice.writes?.length ?? 0,
    stalled: slice.stall?.class != null,
    stallClass: slice.stall?.class ?? null,
    runCount: runs.length,
    lastRunOk: lastRun ? lastRun.ok : null,
  };
}
