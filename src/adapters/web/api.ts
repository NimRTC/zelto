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

import { join, basename } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { SliceStore } from '../../core/slice/store.js';
import { EventStream } from '../../core/events/stream.js';
import { SignManager } from '../../core/gate/sign.js';
import { AuditTrail } from '../../core/audit/trail.js';
import { collectSignReviewFacts } from '../../core/sign-review/collect.js';
import { evaluateSignChecks } from '../../core/sign-review/evaluate.js';
import type { SignCheck, SignReviewFacts } from '../../core/sign-review/types.js';
import { WorktreeManager } from '../../core/worktree/manager.js';
import { BudgetCollector, UNLIMITED_BUDGET, type CostMeasurement } from '../../core/budget/collector.js';
import { MetricsCollector } from '../../core/metrics/collector.js';
import { isSliceStalled } from '../../core/stall/classifier.js';
import {
  classifyLiveness,
  classifyLivenessAsync,
  lastOutputLine,
  readRecoveries,
  readSliceLivenessRecord,
} from '../../core/activity/index.js';
import { isProcessAlive, isProcessTreeAlive } from '../../core/sched/index.js';
import { loadPolicy } from '../../core/policy/data-access.js';
import { VersionStore } from '../../core/version/store.js';
import { DesignStore } from '../../core/design/store.js';
import { RequirementStore } from '../../core/requirements/store.js';
import { resolveSliceOwnership } from '../../core/version/branch.js';
import type { Version } from '../../core/version/types.js';
import { HaltStore } from '../../core/halt/index.js';
import { QuestionStore, type QuestionRecord } from '../../core/question/index.js';
// ADR-086：驾驶舱的油门 —— freeze / gate / resume 直接调 core 编排，
// run 拉起 CLI 进程。判定不分叉（C3）。
import {
  freezeSlice,
  resumeSlice,
  runGate,
  type LifecycleContext,
} from '../../core/lifecycle/index.js';
import { loadConfigAt } from '../../core/config/index.js';
import { launchRun } from './throttle.js';

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
  /**
   * 是否测到过成本证据（budget.spent / llm.called）。
   *
   * `costMeasured === false` 时 `spentUsd` 的 0 是「没记账」而不是「没花钱」——
   * 界面必须显示「未记账」，不能拿 $0.0000 冒充账单（ADR-035 §3.5 的同一原则：
   * 「测到 0」与「没测到」严格分开）。
   */
  costMeasured: boolean;
  /**
   * 成本的**三态**（ADR-035 §3.5）。
   *
   * - `unmeasured` —— 压根没有成本证据，不知道花了多少 → 界面显示「未记账」
   * - `unavailable` —— **核查过**，但 agent 没报出用量 → 界面显示「未测到」
   * - `measured` —— 测到了（金额可能正好是 0）→ 界面显示金额
   *
   * 为什么 `costMeasured` 不够：它是布尔的，容不下「查过了但没测到」这一态。
   * 回填时会给那些 agent 输出为空、拿不到用量的切片补一条
   * `budget.spent`（`measured: false`）标记 —— 它们**不是**「压根没查」，
   * 也不该显示成「$0.0000（真的没花钱）」。
   */
  costMeasurement: CostMeasurement;
  /**
   * 被动活性（D-30）—— running 片才有意义，非 running 为 finished/null。
   * 服务端现场读会话/任务文件 + kill(pid,0)，不信 status: running。
   */
  liveness: 'active' | 'stale' | 'dead' | 'finished' | null;
  liveReason: string | null;
  idleMs: number | null;
  lastActivityAt: string | null;
  /** 看门狗已自愈次数（.zelto/activity/recoveries/<id>.json） */
  recoveries: number;
  /** 是否已上报（超 3 次不再自救） */
  escalated: boolean;
  /**
   * 实时进度（D-30 补）—— running 片才有。
   *
   * 为什么光有「活性 + 闲置时长」不够：那只能说明「还没死」，
   * 说明不了「在推进」。人盯着一个 active 但什么都没变的页面，
   * 几分钟后就会怀疑卡死了 —— 这正是要防的「误以为死掉」。
   *
   * `progressLine` 是 agent 最后一条有内容的输出（一行，已截断）；
   * `progressAt` 是那一行的时刻；`elapsedMs` 是本次运行已经跑了多久。
   * 三者一起，界面才能显示成「在跑 3 分 12 秒 · 正在跑测试…」。
   *
   * `elapsedIdleMs`（ADR-074）是「最新输出距今多久」。`--output-format json`
   * 让 Claude Code 只在结束时吐一次 stdout —— 运行中 `progressLine` 恒为 null，
   * 光看它，「在跑但没产出」与「空壳」长得一模一样。有了这个数，
   * 界面可以说「已运行 12 分 · 3 分钟无输出」，而不是留一片空白让人猜。
   */
  progressLine: string | null;
  progressAt: string | null;
  elapsedMs: number | null;
  elapsedIdleMs: number | null;
}

/** 切片详情 —— 含签字复查的事实与判定。 */
export interface SliceDetail {
  slice: unknown;
  /**
   * 列表行的总览（含活性 / 花费口径 / 看门狗计数）。
   *
   * 详情页也要它：`slice.updatedAt` 只是状态文件写入时间，
   * 一个死掉很久的空壳同样「看着刚更新过」。活性与最后活动只在
   * 总览里算过一次（`toSummary`），详情页直接复用，别在前端再猜。
   */
  summary: SliceSummary;
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
  private readonly zeltoDir: string;
  private readonly store: SliceStore;
  private readonly events: EventStream;
  private readonly signs: SignManager;
  private readonly audit: AuditTrail;
  private readonly worktrees: WorktreeManager;
  private readonly budgetCollector: BudgetCollector;
  private readonly metricsCollector: MetricsCollector;
  private readonly versions: VersionStore;
  private readonly designs: DesignStore;
  private readonly requirements: RequirementStore;
  /** 拉闸请求（ADR-084） */
  private readonly halts: HaltStore;
  /** agent 提问（ADR-084） */
  private readonly questions: QuestionStore;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    const zeltoDir = join(repoRoot, '.zelto');
    this.zeltoDir = zeltoDir;
    this.store = new SliceStore(join(zeltoDir, 'slices'));
    this.events = new EventStream(join(zeltoDir, 'events'));
    this.signs = new SignManager(zeltoDir, this.events, this.store);
    this.audit = new AuditTrail(this.events);
    this.worktrees = new WorktreeManager(repoRoot);
    // BudgetCollector 要 zeltoDir 才能读 config.yaml 里的 budgetLimitUsd
    this.budgetCollector = new BudgetCollector(this.events, zeltoDir);
    this.metricsCollector = new MetricsCollector(this.events);
    // 这三个 store 各自往 baseDir 下再拼一层子目录
    // （versions/、design/、requirements/），所以传 .zelto 根而不是子目录
    this.versions = new VersionStore(zeltoDir);
    this.designs = new DesignStore(zeltoDir);
    this.requirements = new RequirementStore(zeltoDir);
    // ADR-084：拉闸与提问的 store —— 与 CLI 侧同一套实现
    this.halts = new HaltStore(zeltoDir);
    this.questions = new QuestionStore({ baseDir: join(zeltoDir, 'questions') });
  }

  /** 切片总览列表。 */
  async listSlices(): Promise<SliceSummary[]> {
    const ids = await this.store.list();
    // 并发读，不是串行。
    //
    // 为什么：实测 130 片串行读要 297ms，并发只要 26ms（快 11 倍）——
    // 串行时每个 `await` 都在等一次磁盘往返，而那些往返之间 CPU 全闲着。
    // 这个端点是驾驶舱首屏的必经之路（总览页要看「正在运行」那一节），
    // 慢在这里 = 首屏白屏。
    //
    // 为什么不直接用 `Promise.all(ids.map(...))`：
    // 一片的状态文件坏了会让 `Promise.all` 整体 reject —— 一片坏，
    // 整个列表都没了。那比原来更糟。
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const slice = await this.store.read(id);
          return await toSummary(slice, this.budgetCollector, this.repoRoot);
        } catch {
          // 状态文件坏了 —— 跳过，不让一片坏的挡住整个列表
          //
          // 但**必须说出来**：原来这里静默吞掉，导致「磁盘上 130 片、
          // 界面显示 113 片」而没人知道少了 17 片。片子的存在本身是
          // 追溯链的一环 —— 它消失了，人就查不到它了。
          // 所以记一笔到 stderr：不是给用户看的横幅，是给排查的人留的线索。
          console.error(`[zelto web] 跳过状态文件读不出的切片：${id}`);
          return null;
        }
      }),
    );
    const out = results.filter((s): s is SliceSummary => s !== null);
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** 切片详情 —— 含签字复查的事实与判定。 */
  async getSlice(id: string): Promise<SliceDetail | null> {
    const slice = await this.store.read(id);
    const facts = await this.collectFacts(id);
    const checks = evaluateSignChecks(facts);
    return {
      slice,
      summary: await toSummary(slice, this.budgetCollector, this.repoRoot),
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

  /**
   * 全项目度量报告（ADR-010 §5.3 的 `/api/metrics`）。
   *
   * 走 `core/metrics/collector.ts` 的 `generateReport()` ——
   * 与 CLI `zelto summary --metrics` 同一份计算，不另写一套。
   */
  async metrics(): Promise<unknown> {
    const ids = await this.store.list();
    return this.metricsCollector.generateReport(ids);
  }

  /**
   * 停机列表（ADR-010 §5.3 的 `/api/stalls`）。
   *
   * 判定走 `core/stall/classifier.ts` 的 `isSliceStalled()` ——
   * 与 CLI `zelto stall` 同一份判据（C3：不在 Web 侧另立判据）。
   */
  async stalls(): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const id of await this.store.list()) {
      try {
        const slice = await this.store.read(id);
        // isSliceStalled 要完整的 StallInfo —— 切片文件里的 stall 字段
        // 缺 autoResolved/gateRetries 时（老状态文件）补齐，
        // 不然类型对不上（而且 ADR-041 的终态自愈也在读时归一化了）
        const stall = slice.stall ?? { class: null, autoResolved: 0, gateRetries: 0 };
        if (!isSliceStalled({ stall: { ...stall, class: stall.class ?? null } })) continue;
        out.push({
          id: slice.id,
          title: slice.title,
          state: slice.state,
          stallClass: stall.class ?? null,
          updatedAt: slice.updatedAt,
        });
      } catch {
        // 状态文件坏了 —— 跳过
      }
    }
    return out;
  }

  /**
   * 策略规则列表（ADR-010 §5.3 的 `/api/policy`）。
   *
   * **只读**：`core/policy/data-access.ts` 的 `loadPolicy()` ——
   * 与 CLI `zelto policy list` 同一份解析（core/policy/yaml.ts 是唯一解析器）。
   *
   * 注意：`loadPolicy` 返回的 `arch:` 段是策略的一部分，一并返回 ——
   * 只给 `rules:` 会让人以为策略只有一条规则。
   */
  async policy(): Promise<unknown> {
    const loaded = loadPolicy(this.repoRoot);
    if (!loaded) {
      return { exists: false, rules: [], arch: [], path: null, version: null };
    }
    return {
      exists: true,
      rules: loaded.rules,
      arch: loaded.arch ?? [],
      path: loaded.path,
      version: loaded.version,
    };
  }

  /**
   * AI pipeline 全链状态（ADR-010 §5.3 的 `/api/pipeline`）。
   *
   * 「需求 → 设计 → 计划 → 版本 → 切片」的链路总览。
   *
   * 数据来源都是文件里的状态（C1）：需求/设计/版本各有自己的 store，
   * 切片的状态在 `.zelto/slices`。**只读**，不触发任何判定或写入。
   *
   * 为什么在 Web 侧做这件事不违反 C3：这里**不判定**，
   * 只是把各处已有的状态**收集**起来给人看。
   * 真正的判定（规格与写集是否一致、版本能不能交付）都在 CLI 侧，
   * Web 侧不另写一份。
   */
  async pipeline(): Promise<unknown> {
    const plans = await this.versions.list();
    const designDocs = await this.designs.list();
    const requirements = await this.requirements.list();
    const slices = await this.listSlices();

    // 按版本分组的切片 —— 归属判定复用 core/version/branch.ts 的
    // resolveSliceOwnership（与 CLI `zelto merge` 同一份判据）。
    //
    // 为什么复用而不是自己扫版本计划文件：
    // 归属判据散着写必然漂移（D-11 的同一族）。CLI 侧判「这片归 v2」，
    // Web 侧判「这片归 v1」—— 人看到两套说法，无从判断该信哪个。
    const slicesByVersion = new Map<string, number>();
    const unassigned: string[] = [];
    for (const s of slices) {
      const v = this.resolveVersionOf(s.id);
      if (!v) {
        unassigned.push(s.id);
        continue;
      }
      slicesByVersion.set(v, (slicesByVersion.get(v) ?? 0) + 1);
    }

    return {
      requirements: {
        count: requirements.length,
        items: requirements.map((r) => ({
          id: (r as { id?: string }).id ?? '',
          title: (r as { title?: string }).title ?? '',
        })),
      },
      designs: {
        count: designDocs.length,
        items: designDocs.map((d) => ({
          id: (d as { id?: string }).id ?? '',
          title: (d as { title?: string }).title ?? '',
        })),
      },
      plans: {
        count: plans.length,
        items: plans.map((p) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          versionCount: p.versionCount,
        })),
      },
      versions: {
        count: plans.reduce((n, p) => n + p.versionCount, 0),
        // versionDetails 是 async —— 必须 await 后才能 map
        items: (
          await Promise.all(
            plans.map(async (p) => {
              const details = await this.versionDetails(p.id);
              return details.map((v) => ({
                planId: p.id,
                version: v.version,
                status: v.status,
                sliceCount: v.slices.length,
                sliceIds: v.slices.map((s) => s.id),
              }));
            }),
          )
        ).flat(),
      },
      slices: {
        count: slices.length,
        byVersion: Object.fromEntries(slicesByVersion),
        /** 不属于任何版本的切片 —— 直说，别让人以为漏了 */
        unassigned,
      },
    };
  }

  /**
   * 一片切片归属哪个版本 —— 复用 core/version/branch.ts 的判据。
   *
   * 判不出来（没进任何版本计划、规格 frontmatter 也没写）→ null。
   */
  private resolveVersionOf(sliceId: string): string | null {
    try {
      const ownership = resolveSliceOwnership(sliceId, {
        versionsDir: join(this.repoRoot, '.zelto', 'versions'),
      });
      return ownership.kind === 'version' ? ownership.version : null;
    } catch {
      // 归属有歧义（一个切片进了多个版本计划）—— 归属不明就说不明
      return null;
    }
  }

  /** 某个版本计划下的版本明细（读版本计划文件）。 */  private async versionDetails(planId: string): Promise<Version[]> {
    try {
      const plan = await this.versions.read(planId);
      return plan.versions ?? [];
    } catch {
      return [];
    }
  }

  /**
   * 预算概览（ADR-010 §5.3 的 `/api/budget`）。
   *
   * 上限来自 `config.yaml` 的 `budgetLimitUsd`（ADR-035 §3.6）：
   * `0` = 不限（内部用 `Infinity` 表示），其它数字就是上限。
   *
   * 对外时「不限」用 `null` + `unlimited: true` ——
   * 因为 `JSON.stringify(Infinity)` 得到的是 `null`，
   * 前端照着 null 显示会变成「$null」。
   */
  async budget(): Promise<unknown> {
    const rawLimit = await this.budgetCollector.getLimit('');
    const unlimited = rawLimit === UNLIMITED_BUDGET;
    const slices = await this.listSlices();
    const spentUsd = slices.reduce((sum, s) => sum + s.spentUsd, 0);
    // 没记账的切片 = 有切片但一条成本证据都没有 —— 总额要标注「部分未记账」，
    // 否则人会把「只算了一半的账」当成完整总额（ADR-035 §3.5）。
    //
    // 三态（ADR-035 §3.5）：「压根没查」与「查过但没测到」分开报。
    // 混在一起会让人以为「查过了，账是完整的」—— 那不是事实。
    const unmeasuredSlices = slices
      .filter((s) => s.costMeasurement === 'unmeasured')
      .map((s) => s.id);
    const checkedNoUsageSlices = slices
      .filter((s) => s.costMeasurement === 'unavailable')
      .map((s) => s.id);

    // 花费最高的几片 —— 人最需要知道「钱花在哪了」
    const topSpenders = slices
      .filter((s) => s.spentUsd > 0)
      .sort((a, b) => b.spentUsd - a.spentUsd)
      .slice(0, 10)
      .map((s) => ({ id: s.id, title: s.title, spentUsd: s.spentUsd }));

    return {
      spentUsd,
      limitUsd: unlimited ? null : rawLimit,
      unlimited,
      exhausted: !unlimited && spentUsd >= rawLimit,
      spendRatio: unlimited ? null : rawLimit > 0 ? spentUsd / rawLimit : 0,
      topSpenders,
      unmeasuredSlices,
      checkedNoUsageSlices,
    };
  }

  /**
   * 全局最近事件 —— 跨所有切片。
   *
   * 去重（D-30 后的第二个洞）：`policy.decision` 这类事件一次运行会写几百条
   * 一模一样的记录（同一切片、同一类型、同一 payload）。原样平铺，
   * 「最近事件」页就变成一屏复制粘贴，**真正有事的那条被挤出视野**。
   *
   * 去重规则是**只折叠相邻的完全重复**（slice / type / actor / payload 全同），
   * 并保留 `count` 与「从什么时候开始」—— 折叠只影响展示，不隐藏事实：
   * 人看到的仍然是一条真实事件，只是知道它重复了 N 次。
   * 中间夹了别的事件就断开 —— 那不是「刷屏」，是有节奏的动作。
   */
  async recentEvents(limit: number): Promise<unknown[]> {
    // 扫**事件目录**而不是切片列表。
    //
    // 原来的写法按 `.zelto/slices` 遍历，只读到「还有状态文件在的切片」的事件。
    // 实测这个仓库：事件目录 1429 个，切片状态文件一百来个 ——
    // 大部分事件根本进不了「最近事件」页。那页是追溯的入口，
    // 漏掉的恰恰是「切片已删 / 被清理」之后仍在证据链上的历史。
    const all: Array<{
      ts: string;
      slice: string;
      type: string;
      actor: string;
      payload: unknown;
      count?: number;
      since?: string;
    }> = [];
    for (const sliceId of this.listEventSlices()) {
      const list = await this.events.read(sliceId);
      for (const e of list) {
        all.push({
          ts: e.ts,
          slice: e.slice,
          type: e.type,
          actor: e.actor,
          payload: e.payload,
          count: 1,
          since: e.ts,
        });
      }
    }
    all.sort((a, b) => (a.ts < b.ts ? 1 : -1));

    const out: typeof all = [];
    for (const e of all) {
      const prev = out[out.length - 1];
      if (prev && sameEvent(prev, e)) {
        prev.count = (prev.count ?? 1) + 1;
        prev.since = e.ts;
        continue;
      }
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 事件目录下的切片 id —— 「最近事件」的数据源。
   *
   * 直接扫 `.zelto/events`：事件流是追溯的唯一证据载体（C4），
   * 「最近事件」该照事件目录说话，而不是照「哪些切片还有状态文件」说话。
   * 只取**真有** `events.jsonl` 的目录，空目录不当成切片。
   */
  private listEventSlices(): string[] {
    const dir = join(this.zeltoDir, 'events');
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!existsSync(join(dir, e.name, 'events.jsonl'))) continue;
      out.push(e.name);
    }
    return out;
  }

  /** 签字请求清单。 */
  async listSignRequests(status?: string): Promise<unknown[]> {
    // ADR-094 §5.1：签字请求多了两个状态 —— `revised`（退回重跑）与
    // `returned`（退回上游）。白名单漏掉它们的话，驾驶舱按这两个状态
    // 过滤会**返回全部**（status 变成 undefined），页面上的待签字列表
    // 就会把「已退回的片」混进「待签字的片」。
    const valid =
      status === 'pending' ||
      status === 'approved' ||
      status === 'rejected' ||
      status === 'revoked' ||
      status === 'revised' ||
      status === 'returned'
        ? status
        : undefined;
    return this.signs.list(valid);
  }

  /**
   * 工程信息 —— 「这是哪个项目」。
   *
   * 驾驶舱同时能开好几个（每个项目一个端口），页面标题若只有
   * 「zelto 驾驶舱」，人切几个标签页就分不清哪个是哪个项目。
   *
   * 来源优先级（都是文件里的既有事实，不新增状态 —— C1）：
   *   1. `.zelto/project-map.json` 的 `projectName`（`zelto init` 写入）
   *   2. 项目根目录名（没 init 也至少能说清是哪个目录）
   *   3. 都没有时 `null` —— 界面照实不显示，不编一个名字
   */
  async projectInfo(): Promise<unknown> {
    const name = readProjectName(this.repoRoot);
    return {
      name,
      root: this.repoRoot,
      host: basename(this.repoRoot),
    };
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
    const rawLimit = await this.budgetCollector.getLimit('');
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
      // ── 被动活性（D-30）：running 里到底几个活着、几个可疑、几个死了 ──
      live: {
        active: slices.filter((s) => s.liveness === 'active').map((s) => s.id),
        stale: slices.filter((s) => s.liveness === 'stale').map((s) => ({
          id: s.id, idleMs: s.idleMs, lastActivityAt: s.lastActivityAt, reason: s.liveReason,
        })),
        dead: slices.filter((s) => s.liveness === 'dead').map((s) => ({
          id: s.id, reason: s.liveReason, recoveries: s.recoveries, escalated: s.escalated,
        })),
      },
      // ── 看门狗上报（D-30）：超 3 次不再自救的，等人看 ──
      watchdog: {
        recovered: slices.filter((s) => s.recoveries > 0).map((s) => ({
          id: s.id, recoveries: s.recoveries, escalated: s.escalated,
        })),
        escalated: slices.filter((s) => s.escalated).map((s) => s.id),
      },
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

  // ── ADR-084：驾驶舱从「只读 + 签字」扩展为「可接管」 ────────────────
  //
  // 下面三个动作的共同纪律（ADR-084 §2）：
  // **Web 侧不重写判定，只调 core** ——
  // 每一件都复用 CLI 侧同一个 core 实现，
  // 否则「浏览器里点的」和「终端里跑的」会得出不同结论（C3 的隐患）。

  /**
   * **agent 的待答提问**（ADR-084）。
   *
   * 之前没有这个能力，于是 agent 一提问，人就得切回终端去 `zelto ask` 看 ——
   * 驾驶舱在最该起作用的时候把人赶走了。
   */
  async listQuestions(sliceId?: string, status?: string): Promise<unknown[]> {
    try {
      const pending = await this.questions.listPending(sliceId);
      if (!status || status === 'pending') return pending;
      // 其它状态目前不查 —— QuestionStore 的 listPending 只给待答的。
      // 「查不到」比「假装有」好（不编数据）。
      return [];
    } catch {
      return [];
    }
  }

  /**
   * **拒签** —— 与 `zelto sign <id> --reject` 同一套实现。
   *
   * 为什么驾驶舱要能拒签：签字队列是「人在被交还控制权的那一刻」看的页面。
   * 只能签不能拒，就等于把人赶回终端 —— 驾驶舱在最该起作用的时候失效。
   */
  async rejectSign(signId: string, comment?: string | null): Promise<
    | { ok: true; request: unknown }
    | { ok: false; reason: string }
  > {
    let request;
    try {
      request = await this.signs.get(signId);
    } catch {
      return { ok: false, reason: `签字请求不存在：${signId}` };
    }

    if (request.status !== 'pending') {
      return { ok: false, reason: `签字请求已是 ${request.status} 状态，不能再拒绝` };
    }

    try {
      const rejected = await this.signs.reject(signId, 'human', comment ?? null);
      return { ok: true, request: rejected };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `拒绝失败：${message}` };
    }
  }

  /**
   * **回答 agent 的提问** —— 只**记录**答案，**不续跑**（ADR-084 §1.1）。
   *
   * 为什么不在 Web 侧续跑：续跑要调 `adapter.resume()` 拉起 agent 会话，
   * 会让一个 HTTP 请求长时间挂着，还可能留下孤儿进程。
   * 而 CLI 侧本来就有完整实现 —— Web 侧再写一份就分叉了（C3）。
   *
   * 分工：**驾驶舱负责「把答案记下来」，CLI 负责「让 agent 接着跑」。**
   */
  async answerQuestion(
    sliceId: string,
    answer: string,
  ): Promise<
    | { ok: true; questionId: string; nextStep: string }
    | { ok: false; reason: string }
  > {
    const text = (answer ?? '').trim();
    if (!text) {
      return { ok: false, reason: '答案为空' };
    }

    // 找这片待答的问题 —— 认问题 id 与认切片 id 都支持。
    let pending: QuestionRecord[];
    try {
      pending = await this.questions.listPending(sliceId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `读待答问题失败：${message}` };
    }

    if (pending.length === 0) {
      return { ok: false, reason: `切片 "${sliceId}" 没有待答的问题` };
    }
    // 多于一个待答问题时不能猜 —— 让人明确指定。
    if (pending.length > 1) {
      return {
        ok: false,
        reason:
          `切片 "${sliceId}" 有 ${pending.length} 个待答问题，无法确定回答哪一个` +
          `（${pending.map((q) => q.id).join(', ')}）`,
      };
    }

    const question = pending[0];
    try {
      await this.questions.answer(question.id, text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `记录答案失败：${message}` };
    }

    // 事件流（C4）：驾驶舱里的操作**也是「人做的决定」** ——
    // 追溯链要能回答「当时是谁在浏览器里回答了这个问题」。
    //
    // actor 与 via 是**两个维度**：actor 说「人做的」，via 说「在哪儿做的」。
    await this.events.append(sliceId, 'question.answered', 'human', {
      sliceId,
      questionId: question.id,
      answer: text,
      answeredBy: 'human',
      via: 'web',
    });

    return {
      ok: true,
      questionId: question.id,
      nextStep:
        `答案已记录。续跑请在终端执行：zelto answer ${question.id} "${text}"`,
    };
  }

  /**
   * **拉闸** —— 与 `zelto halt` 同一套实现（ADR-020）。
   *
   * 驾驶舱只提供「刹车」，不提供「油门」——
   * `resume` 会改切片状态机、走重试预算、可能触发 gate，
   * 那是「推进」动作，不是「接管」动作（ADR-084 §1）。
   */
  async haltBatch(
    scope: string,
    reason: string,
  ): Promise<
    | { ok: true; halt: { id: string; scope: string; requestedAt: string; reason: string } }
    | { ok: false; reason: string }
  > {
    const haltScope = (scope ?? '').trim() || 'all';
    const haltReason = (reason ?? '').trim() || '人工拉闸';

    let req;
    try {
      req = await this.halts.request(haltScope, 'human', haltReason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `拉闸失败：${message}` };
    }

    await this.events.append('batch', 'batch.halted', 'human', {
      scope: haltScope,
      reason: haltReason,
      haltId: req.id,
      requestedAt: req.requestedAt,
      via: 'web',
    });

    return {
      ok: true,
      halt: {
        id: req.id,
        scope: req.scope,
        requestedAt: req.requestedAt,
        reason: req.reason,
      },
    };
  }

  // ── ADR-086：驾驶舱装上油门 ─────────────────────────────────────────
  //
  // 下面四个动作的共同纪律（ADR-084 §2 延续）：
  // **Web 侧不重写判定，只调 core** ——
  //   - freeze / gate / resume → 直接调 `core/lifecycle/` 的编排
  //   - run                  → 拉起 CLI 进程（判定在 CLI 二进制里）
  // 两条路都保证「浏览器里点的」与「终端里跑的」结论一致（C3）。

  /** 编排层需要的上下文 —— actor 与 via 是两个维度（ADR-084 §4）。 */
  private lifecycleContext(): LifecycleContext {
    return {
      repoRoot: this.repoRoot,
      store: this.store,
      events: this.events,
      actor: 'human',
      via: 'web',
    };
  }

  /**
   * **冻结** —— 与 `zelto freeze` 同一份编排（ADR-086）。
   *
   * 编排住在 `core/lifecycle/freeze.ts` —— CLI 与 Web 调同一份。
   */
  async freezeSlice(
    sliceId: string,
    options: { refreeze?: boolean } = {},
  ): Promise<{
    ok: boolean;
    reason: string;
    details: string[];
    advisories: string[];
    facts?: Record<string, unknown>;
    notFound?: boolean;
  }> {
    // 切片不存在 → 404，不是 500。
    //
    // 为什么要在调 core **之前**查：`store.read()` 抛 ENOENT，
    // 那个异常一路冒到 router 就成了「服务器内部错误」——
    // 但人的动作是错的（点了不存在的切片），不是服务器坏了。
    // 500 会把人引去查日志，404 才能让人意识到「点错了」。
    if (!(await this.store.exists(sliceId))) {
      return {
        ok: false,
        reason: `切片 "${sliceId}" 不存在`,
        details: [],
        advisories: [],
        notFound: true,
      };
    }

    const outcome = await freezeSlice(this.lifecycleContext(), sliceId, {
      ...(options.refreeze ? { refreeze: true } : {}),
    });
    return {
      ok: outcome.ok,
      reason: outcome.reason,
      details: outcome.details,
      advisories: outcome.advisories,
      ...(outcome.facts ? { facts: outcome.facts } : {}),
    };
  }

  /**
   * **门禁②** —— 与 `zelto gate` 同一份编排（ADR-086）。
   *
   * 编排住在 `core/lifecycle/gate.ts` —— CLI 与 Web 调同一份。
   */
  async runGate(
    sliceId: string,
    options: { only?: string; retry?: number; dryRun?: boolean } = {},
  ): Promise<{
    ok: boolean;
    reason: string;
    details: string[];
    advisories: string[];
    facts?: Record<string, unknown>;
    notFound?: boolean;
  }> {
    if (!(await this.store.exists(sliceId))) {
      return {
        ok: false,
        reason: `切片 "${sliceId}" 不存在`,
        details: [],
        advisories: [],
        notFound: true,
      };
    }

    const config = loadConfigAt(this.repoRoot);
    const gateRoot = this.worktrees.exists(sliceId)
      ? this.worktrees.pathFor(sliceId)
      : undefined;

    const outcome = await runGate(
      this.lifecycleContext(),
      sliceId,
      {
        commands: config.gate.commands.map((c) => ({ name: c.name, run: c.run })),
        ...(config.gate.profiles ? { profiles: config.gate.profiles } : {}),
        timeoutSec: config.gate.timeoutSec,
        retryMax: config.gate.retry.max,
        ...(config.gate.acceptance ? { acceptance: config.gate.acceptance } : {}),
        ...(config.gate.submoduleCheck !== undefined
          ? { submoduleCheck: config.gate.submoduleCheck }
          : {}),
        ...(gateRoot ? { gateRoot } : {}),
        requestSign: true,
      },
      {
        ...(options.only ? { only: options.only } : {}),
        ...(options.retry !== undefined ? { retry: options.retry } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
      },
    );

    return {
      ok: outcome.ok,
      reason: outcome.reason,
      details: outcome.details,
      advisories: outcome.advisories,
      ...(outcome.facts ? { facts: outcome.facts } : {}),
    };
  }

  /**
   * **续跑停机切片** —— 与 `zelto resume` 同一份编排（ADR-086）。
   */
  async resumeSlice(
    sliceId: string,
    options: { skip?: boolean; abandon?: boolean; resetRetry?: boolean } = {},
  ): Promise<{
    ok: boolean;
    reason: string;
    details: string[];
    advisories: string[];
    facts?: Record<string, unknown>;
    notFound?: boolean;
  }> {
    if (!(await this.store.exists(sliceId))) {
      return {
        ok: false,
        reason: `切片 "${sliceId}" 不存在`,
        details: [],
        advisories: [],
        notFound: true,
      };
    }

    const outcome = await resumeSlice(this.lifecycleContext(), sliceId, options);
    return {
      ok: outcome.ok,
      reason: outcome.reason,
      details: outcome.details,
      advisories: outcome.advisories,
      ...(outcome.facts ? { facts: outcome.facts } : {}),
    };
  }

  /**
   * **开跑** —— 拉起 CLI 进程（ADR-086 §3）。
   *
   * **不是**在 Web 侧重实现 run：run 必须用 executor adapter，
   * 而 `core/` 不许 import `adapters/`（C2）。
   * 所以 Web 端拉起 **CLI 二进制本身**（`zelto run <id> --detach`）：
   * 同一份准入判定、同一份写集预检、同一份事件（C3）。
   *
   * **fire-and-forget**：HTTP 请求**不挂着** agent 会话 ——
   * agent 跑在独立的监督进程里（ADR-084 §1.1 要的就是这个）。
   */
  async runSlice(
    sliceId: string,
    options: { hotfix?: boolean; confirmHotfix?: boolean } = {},
  ): Promise<{
    ok: boolean;
    reason: string;
    taskId?: string;
    supervisorPid?: number;
    nextStep?: string;
  }> {
    // 同时在跑的 detached 任务数有上限 —— 点错一下就可能同时拉起多个 agent，
    // 而每个 agent 都在烧 token。这不是安全漏洞，是**成本失控**的闸门。
    const running = await this.countRunningDetachedTasks();
    const limit = this.maxConcurrentRuns();
    if (running >= limit) {
      return {
        ok: false,
        reason:
          `已有 ${running} 个后台运行在进行中（上限 ${limit}）—— ` +
          `请等它们跑完，或先在终端里 zelto status 看进度。`,
      };
    }

    const launch = await launchRun(this.repoRoot, sliceId, {
      ...options,
      ...(this.launchTimeoutMs() !== undefined ? { launchTimeoutMs: this.launchTimeoutMs() } : {}),
    });
    if (!launch.ok) {
      return { ok: false, reason: launch.reason ?? '发起运行失败' };
    }

    return {
      ok: true,
      reason: '已在后台起跑',
      ...(launch.taskId ? { taskId: launch.taskId } : {}),
      ...(launch.supervisorPid ? { supervisorPid: launch.supervisorPid } : {}),
      // 下一步说清楚：进度在驾驶舱上看，合并要显式跑 merge。
      nextStep:
        '进度会实时显示在本页。跑完后会生成签字请求 —— ' +
        '签字不等于合并，合入主干需另跑 zelto merge <slice-id>',
    };
  }

  /**
   * 当前有多少个 detached 运行在进行中。
   *
   * 判据是**任务文件 + 进程存活**（不是切片状态）——
   * 切片状态在 agent 跑完后才变，任务文件才是「这一轮还在跑」的凭据。
   */
  private async countRunningDetachedTasks(): Promise<number> {
    const tasksDir = join(this.zeltoDir, 'tasks');
    let entries: string[];
    try {
      entries = readdirSync(tasksDir);
    } catch {
      // 没有任务目录 = 没有任何后台运行
      return 0;
    }

    let count = 0;
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      let task: { status?: string; supervisorPid?: number };
      try {
        task = JSON.parse(readFileSync(join(tasksDir, file), 'utf-8')) as {
          status?: string;
          supervisorPid?: number;
        };
      } catch {
        // 任务文件读不出来 —— 跳过（它自己都坏了，算不算在跑说不上）
        continue;
      }
      if (task.status !== 'running') continue;
      if (typeof task.supervisorPid === 'number' && task.supervisorPid > 0) {
        if (isProcessAlive(task.supervisorPid)) {
          count++;
          continue;
        }
        // pid 在但进程没了 —— 那一轮已经死了，不算在跑
        continue;
      }
      // 拿不到 pid 时只能信任务文件 —— 但那可能是残留记录。
      // 宁可多算一个（拒绝启动），也不要少算（超限烧 token）。
      count++;
    }
    return count;
  }

  /**
   * 同时在跑的 detached 任务上限。
   *
   * 默认 1 —— 驾驶舱里点错一下就多烧一轮 token，
   * 所以默认保守。人可以在 `.zelto/config.yaml` 里调大。
   */
  private maxConcurrentRuns(): number {
    try {
      const config = loadConfigAt(this.repoRoot);
      const raw = config.web?.maxConcurrentRuns;
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) {
        return Math.floor(raw);
      }
    } catch {
      // 读不到配置 —— 用默认值
    }
    return 1;
  }

  /**
   * 拉起 `zelto run --detach` 的等待上限（毫秒）。
   *
   * 人可以在 `.zelto/config.yaml` 的 `web.launchTimeoutMs` 里调。
   * 默认见 `DEFAULT_LAUNCH_TIMEOUT_MS`（2 分钟）。
   */
  private launchTimeoutMs(): number | undefined {
    try {
      const config = loadConfigAt(this.repoRoot);
      const raw = config.web?.launchTimeoutMs;
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1000) {
        return Math.floor(raw);
      }
    } catch {
      // 读不到配置 —— 用默认值
    }
    return undefined;
  }
}

/**
 * 读工程名 —— `.zelto/project-map.json` 优先，退回目录名。
 *
 * 为什么不复用 `core/project/scanner.ts`：那是**扫描**（要遍历整棵树），
 * 驾驶舱每次轮询都要工程名，不能为此扫一遍仓库。
 * 这里只是读一个已经写好的字段 + 一个 `basename()`。
 */
function readProjectName(repoRoot: string): string | null {
  const mapPath = join(repoRoot, '.zelto', 'project-map.json');
  if (existsSync(mapPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mapPath, 'utf-8').replace(/^\uFEFF/, '')) as {
        projectName?: unknown;
      };
      if (typeof parsed.projectName === 'string' && parsed.projectName.trim()) {
        return parsed.projectName.trim();
      }
    } catch {
      // 文件坏了就退回目录名 —— 名字不是判定，不必 fail closed
    }
  }
  const dirName = basename(repoRoot);
  return dirName || null;
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
  repoRoot: string,
): Promise<SliceSummary> {
  const runs = slice.runs ?? [];
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;

  const requirements = toStringList(slice.trace?.requirements);
  const contracts = toStringList(slice.trace?.contracts);
  const tests = toStringList(slice.trace?.tests);

  // 被动活性（D-30）：running 片才查，非 running 直接 finished。
  // 读会话/任务文件 + kill(pid,0)，判定走 core/activity（C3，不在 Web 侧另立判据）。
  let liveness: SliceSummary['liveness'] = slice.state === 'running' ? null : 'finished';
  let liveReason: string | null = slice.state === 'running' ? null : '没有在跑';
  let idleMs: number | null = null;
  let lastActivityAt: string | null = null;
  let progressLine: string | null = null;
  let progressAt: string | null = null;
  let elapsedMs: number | null = null;
  let elapsedIdleMs: number | null = null;
  if (slice.state === 'running') {
    try {
      const rec = readSliceLivenessRecord(repoRoot, slice.id);
      const live = await classifyLivenessAsync(rec, { isProcessAlive, isProcessTreeAlive });
      liveness = live.state;
      liveReason = live.reason;
      idleMs = live.idleMs;
      lastActivityAt = live.lastActivityAt;
      // 进度：最后一条输出 + 从启动算起的已运行时长。
      // 输出是「在推进」的证据，已运行时长是「还在跑」的量度 ——
      // 二者都是文件里已有的事实，不在这里做新判定（C3）。
      progressLine = lastOutputLine(rec);
      progressAt = rec?.lastOutputAt ?? null;
      const startedAt = rec?.startedAt ? Date.parse(rec.startedAt) : Number.NaN;
      if (Number.isFinite(startedAt)) {
        elapsedMs = Math.max(0, Date.now() - startedAt);
      }
      // 输出静默时长（ADR-074）：有输出 → 距最后一条输出的时间；没输出 → 等于已运行时长
      const progressMs = progressAt ? Date.parse(progressAt) : Number.NaN;
      if (Number.isFinite(progressMs)) {
        elapsedIdleMs = Math.max(0, Date.now() - progressMs);
      } else if (elapsedMs !== null) {
        elapsedIdleMs = elapsedMs;
      }
    } catch {
      liveness = null;
    }
  }
  let recoveries = 0;
  let escalated = false;
  try {
    const r = readRecoveries(repoRoot, slice.id);
    recoveries = r.count;
    escalated = r.escalated;
  } catch { /* 没有计数文件就是 0 */ }

  const { spent: spentUsd, measured: costMeasured, measurement: costMeasurement } =
    await budget.getSpentDetail(slice.id);
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
    spentUsd,
    /** 是否测到过成本证据；false = 没记账，界面不能显示成 $0 */
    costMeasured,
    /** 三态：unmeasured（压根没查）/ zero（查过但没测到）/ measured（测到了） */
    costMeasurement,
    liveness,
    liveReason,
    idleMs,
    lastActivityAt,
    recoveries,
    escalated,
    progressLine,
    progressAt,
    elapsedMs,
    elapsedIdleMs,
  };
}

/** 追溯三元组的元素统一成字符串数组。 */
function toStringList(value: unknown[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
}

/**
 * 两条事件是否「完全重复」—— 用于「最近事件」的去重。
 *
 * 比较 payload 用 JSON 序列化：事件 payload 都是小的扁对象，
 * 深比较器不值得为它写一套。键顺序由写入方保证（同一个写点写出的
 * 重复事件 key 顺序一致）—— 顺序不同视为不同事件，宁可多显示一条，
 * 也不把有差异的事件折叠掉。
 */
function sameEvent(
  a: { slice: string; type: string; actor: string; payload: unknown },
  b: { slice: string; type: string; actor: string; payload: unknown },
): boolean {
  if (a.slice !== b.slice || a.type !== b.type || a.actor !== b.actor) return false;
  try {
    return JSON.stringify(a.payload) === JSON.stringify(b.payload);
  } catch {
    return false;
  }
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
