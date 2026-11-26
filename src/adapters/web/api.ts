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
import { classifySliceKindAsync, type SliceKind } from '../../core/slice/baseline-kind.js';
import { EventStream, type EventEnvelope } from '../../core/events/stream.js';
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
import { resolveSliceOwnership, branchOfVersion, readVersionPlans } from '../../core/version/branch.js';
// ADR-126：产物证据（`Refs-Slice:` trailer 在版本分支上）——
// 补上 ADR-114 那列恒为 0 的「状态文件是否进分支」给不出的信息。
import { defaultArtifactProbe } from '../../core/project/artifact-evidence.js';
import type { Version, VersionPlan } from '../../core/version/types.js';
import { HaltStore } from '../../core/halt/index.js';
import { QuestionStore, type QuestionRecord } from '../../core/question/index.js';
// ADR-112：驾驶舱按「根」扫描 —— 版本集成目录里的切片不许看不见
import {
  discoverCockpitRoots,
  isRootScope,
  type CockpitRoot,
  type CockpitScope,
} from '../../core/project/cockpit-roots.js';
// ADR-114：分支可见性 —— 「完成」是在盘上完成，还是在版本分支里完成
import { annotateBranchEvidenceAsync } from '../../core/project/branch-evidence.js';
// 执行目录脉络：仓库根 / 版本目录 / 切片执行目录 / 额外工作区
import {
  discoverWorktrees,
  normalizeDir,
  readGitWorktrees,
  resolveTrunkAsync,
  type WorktreeEntry,
} from '../../core/project/worktree-map.js';
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

export interface SliceSummary {
  id: string;
  title: string;
  state: string;
  type: string | null;
  updatedAt: string;
  createdAt: string;
  /**
   * 这片是**基线切片**还是**开发切片**。
   *
   * 为什么前端需要知道：基线切片描述**现状**（接管既有项目时登记的），
   * 开发切片是**待办的活**。两者都可能是 `completed`，
   * 混在一个计数里就说谎 —— 实测（nimrtc-v14）8 片 completed 里
   * 有 3 片是基线（`v0-cmake` / `v0-src-log` / `v1-cmake`），
   * 那轮实际只开发了 5 片。
   *
   * 判定在 `core/slice/baseline-kind.ts`（C3：纯判定，读文件不触网）。
   */
  kind: SliceKind;
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
  /** 看门狗已自愈次数（.zelto/activity/recoveries/<id>.jsonl，折叠计数） */
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
  /**
   * ── ADR-112：这一行来自哪个「根」──
   *
   * 这条总览行的状态取自哪一个 `.zelto/`：
   * `root` = 仓库根，`version` = 版本集成目录。
   *
   * 同一片可能同时存在于多个根（基线切片实测在根 / v1 / v2 / v3 都有副本）。
   * 合并规则见 `listSlices`：`updatedAt` 较晚的那份决定这一行的事实，
   * 但它出现过的**所有根**都记在 `roots` 里 —— 「这片在哪些地方有记录」
   * 是事实，不因合并而消失。
   *
   * 前端**写操作**（签字 / 门禁 / 冻结 / 开跑）要靠 `scope + label`
   * 路由回这个根 —— 落到错的根 = 签了根上那份过期副本。
   */
  scope: CockpitScope;
  /** 版本 label（`scope === 'version'` 时非空） */
  label: string | null;
  /** 这一片出现过的所有根（版本 label；仓库根记为 `root`）—— 合并的证据 */
  roots: string[];
  /**
   * ── ADR-114：分支可见性 ──
   *
   * `true` = 这一片的状态文件已**提交进它所属那个根的 git 跟踪**
   * （等价地：已合进版本分支 / 主干）。`false` = 只在盘上
   * （`.zelto/` 在 .gitignore 里，状态文件没进版本分支 —— 换台机器就看不到）。
   *
   * 为什么必须说：实测 nimrtc-v14 的 v3 目录里 15 片全是 completed，
   * 但 `version/v3` 分支只跟踪了 3 片基线 —— 其余 12 片「完成了」
   * 这件事只存在于那台机器的磁盘上。驾驶舱不说这一点，
   * 人看到的就是「15 片全完成」，而版本分支里没有证据。
   *
   * 判据只读 git（C3：确定性、不触网）。
   */
  onBranch: boolean | null;
  /** 提交形态的状态（与盘上 `state` 对照）—— 不跟踪时 `null` */
  committedState: string | null;
  /**
   * ── running 片到底还活着没有（D-30 活性的「可能自愈」档）──
   *
   * `liveness === 'dead'` 是**确定**死了（进程没了）；`stale` 只是「很久没动静」——
   * 最常见的原因是看门狗会把它自愈（重跑 / 续跑），所以 stale **不是**停机
   * （`stall.class` 仍为 null，`/api/stalls` 也不报它）。
   *
   * 但看门狗追赶有限（`recoveries` 计到上限就 `escalated` = 交还给人）。
   * 于是会出现：进程早就没了、看门狗已经放弃、状态文件却还停在 running ——
   * 它不是停机类的任何一档（`/api/stalls` 看不见它），只有活性/自愈计数
   * 两条线索拼起来才知道「这片要人来收」。
   *
   * 这里的判定只做**文件事实的拼装**（活性 + 自愈上限），不另立停机判据；
   * 前端根据它把这类片在总览里单独说出来，而不是让它混在「在跑」里。
   * 非 running 片恒为 false。
   */
  watchdogGaveUp: boolean;
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

/**
 * 一个「根」上的 zelto 状态 —— ADR-112。
 *
 * 每个根（仓库根 / 版本集成目录）各自有一整套 store：
 * 切片、事件、签字请求、审计、预算、worktree 全部是**这个根的**事实。
 * 写操作必须落回这些 store，不能跨根。
 */
interface SliceWorkspace {
  root: CockpitRoot;
  /** `.zelto` 目录 */
  zeltoDir: string;
  store: SliceStore;
  events: EventStream;
  signs: SignManager;
  audit: AuditTrail;
  worktrees: WorktreeManager;
  budget: BudgetCollector;
}

/** 定位一个根（写操作与详情的路由凭据）。 */
interface SliceLocation {
  scope?: CockpitScope;
  label?: string | null;
}

export class WebApi {
  private readonly repoRoot: string;
  private readonly zeltoDir: string;
  /** 所有根（仓库根永远第一个）—— 只在这里**发现**，进程内不变 */
  private readonly workspaces: SliceWorkspace[];
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
    // ADR-112：扫描仓库根 + 每个版本集成目录。
    //
    // 发现只做一次（进程内根集合不变）；每个根各建一套 store。
    // 传 repoRoot 没变时仓库根那份与改造前**逐字一致** ——
    // 老调用方（不传 scope/label）看到的仍是以前那份状态。
    this.workspaces = discoverCockpitRoots(repoRoot).map((root) => {
      const dir = join(root.dir, '.zelto');
      const store = new SliceStore(join(dir, 'slices'));
      const events = new EventStream(join(dir, 'events'));
      return {
        root,
        zeltoDir: dir,
        store,
        events,
        signs: new SignManager(dir, events, store),
        audit: new AuditTrail(events),
        // 切片 worktree 仍按仓库根解析 —— worktree 是仓库的，不是某个根私有的
        worktrees: new WorktreeManager(repoRoot),
        // BudgetCollector 要这个根的 zeltoDir 才能读它自己的 config.yaml
        budget: new BudgetCollector(events, dir),
      };
    });
    const rootWs = this.workspaces[0];
    this.metricsCollector = new MetricsCollector(rootWs.events);
    // 这三个 store 各自往 baseDir 下再拼一层子目录
    // （versions/、design/、requirements/），所以传 .zelto 根而不是子目录
    //
    // 需求 / 设计 / 版本计划**只读仓库根**（ADR-112 边界）：
    // 版本目录里的那些是同步副本，不是真源。
    this.versions = new VersionStore(zeltoDir);
    this.designs = new DesignStore(zeltoDir);
    this.requirements = new RequirementStore(zeltoDir);
    // ADR-084：拉闸与提问的 store —— 与 CLI 侧同一套实现
    this.halts = new HaltStore(zeltoDir);
    this.questions = new QuestionStore({ baseDir: join(zeltoDir, 'questions') });
  }

  /** 仓库根那份（老行为 —— 不传 scope 时的默认落点）。 */
  private get rootWs(): SliceWorkspace {
    return this.workspaces[0];
  }

  /**
   * 扫到的根清单 —— 「驾驶舱到底看了哪些地方」本身就是要给人看的信息。
   *
   * 看不见的根 = 人不知道版本目录也在跑；不知道就无从去那里签字。
   */
  listRoots(): Array<{ scope: CockpitScope; label: string | null; dir: string }> {
    return this.workspaces.map((ws) => ({
      scope: ws.root.scope,
      label: ws.root.label,
      dir: ws.root.dir,
    }));
  }

  /**
   * 执行目录脉络 —— 「这场仗分成哪几条战线、每条各在哪」（驾驶舱工作区视图）。
   *
   * 与 `listRoots` 的区别：`listRoots` 只回答「驾驶舱读了哪些 `.zelto`」；
   * 这里回答「**同一个仓库**在盘上有几份检出 —— 哪份是仓库根、
   * 哪份是版本集成目录、哪份是切片执行目录、哪份是 git 额外工作区」，
   * 并给每条战线附上属于它的切片行（scope/label 相同）。
   *
   * 切片状态只从 `.zelto` 根读（ADR-112 的边界不变）；
   * 执行目录里的 `.zelto/slices/` 是基线快照，不当状态用 ——
   * 只按 id 把「跑在这条战线上的那片」的状态**借自**它真正所在的根。
   */
  async worktreeMap(): Promise<{
    repoRoot: string;
    entries: Array<WorktreeEntry & { slices: SliceSummary[]; version: string | null }>;
  }> {
    const [gitWorktrees, trunk, slices, plans] = await Promise.all([
      readGitWorktrees(this.repoRoot),
      resolveTrunkAsync(this.repoRoot),
      this.listSlices(),
      Promise.resolve(readVersionPlans(join(this.zeltoDir, 'versions'))),
    ]);
    const entries = discoverWorktrees(this.repoRoot, gitWorktrees, trunk);

    // 版本 label → 计划里的版本状态（只呈现，不判定）
    const versionStatus = new Map<string, string>();
    for (const plan of plans) for (const v of plan.versions) versionStatus.set(v.version, v.status);

    const byRoot = new Map<string, SliceSummary[]>();
    for (const row of slices) {
      const key = `${row.scope}|${row.label ?? ''}`;
      const list = byRoot.get(key) ?? [];
      list.push(row);
      byRoot.set(key, list);
    }

    // 切片执行目录 → 它的切片行：按 id 在全部根里找（执行目录不带自己的状态）
    const sliceRowById = new Map<string, SliceSummary>();
    for (const row of slices) if (!sliceRowById.has(row.id)) sliceRowById.set(row.id, row);

    // 版本目录 → 计划里点名的切片 id（计划的 `slices` 字段）。
    // 为什么需要：版本目录自己的 `.zelto/slices/` 是**基线快照** ——
    // 实测 v4 的快照只有 v0/v1 三片基线，而 v4 真正要跑的是三条已冻结的切片。
    // 而且版本目录里的切片调 `zelto set --label` 改 label 时，盘上的
    // `.zelto/slices/<id>.json` 在**仓库根**（状态只从根读）—— 于是
    // `scope|label` 分组里 v4 一行都落不到。计划是唯一写明了归属的地方。
    const planSlices = new Map<string, string[]>();
    for (const plan of plans) {
      for (const v of plan.versions) {
        const ids = (v.slices ?? [])
          .map((s: unknown) => (typeof s === 'string' ? s : (s as { id?: unknown } | null)?.id))
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ids.length > 0) planSlices.set(v.version, ids);
      }
    }
    const rowFor = (id: string): SliceSummary | null => sliceRowById.get(id) ?? null;

    return {
      repoRoot: this.repoRoot,
      entries: entries.map((entry) => {
        let rows: SliceSummary[] = [];
        if (entry.kind === 'root') rows = byRoot.get('root|') ?? [];
        else if (entry.kind === 'version' && entry.label) {
          rows = byRoot.get(`version|${entry.label}`) ?? [];
          // 计划点名的切片不在 scope|label 分组里（label 没改 / 状态在根）→
          // 按计划 id 补上，按计划顺序排前面。重复 id 不补。
          const have = new Set(rows.map((r) => r.id));
          const planned = (planSlices.get(entry.label) ?? [])
            .filter((id) => !have.has(id))
            .map(rowFor)
            .filter((r): r is SliceSummary => r !== null);
          rows = [...planned, ...rows];
        } else if (entry.kind === 'slice' && entry.label) {
          const hit = sliceRowById.get(entry.label);
          rows = hit ? [hit] : [];
        }
        return {
          ...entry,
          slices: rows,
          version: entry.kind === 'version' && entry.label ? versionStatus.get(entry.label) ?? null : null,
        };
      }),
    };
  }

  /** 按 scope + label 找根；找不到返回 null（不猜）。 */  private findWorkspace(loc: SliceLocation): SliceWorkspace | null {
    if (isRootScope(loc.scope, loc.label)) return this.rootWs;
    return (
      this.workspaces.find(
        (ws) => ws.root.scope === loc.scope && ws.root.label === loc.label,
      ) ?? null
    );
  }

  /**
   * 从一堆候选里解析出「这片真正所在的根」—— 不传 scope 时用。
   *
   * 不进缓存：根扫描本就是一次参数下发的动作，驾驶舱调用频率低。
   */
  private async resolveWorkspace(id: string, loc: SliceLocation = {}): Promise<SliceWorkspace | null> {
    if (loc.scope !== undefined) return this.findWorkspace(loc);
    // 默认：仓库根里有就落在仓库根（老行为的延伸）；没有就按合并结论找
    if (await this.rootWs.store.exists(id)) return this.rootWs;
    const merged = await this.listSlices();
    const hit = merged.find((s) => s.id === id);
    if (!hit) return null;
    return this.findWorkspace({ scope: hit.scope, label: hit.label });
  }

  /** 切片总览列表 —— 扫所有根，按 id 合并。 */
  async listSlices(): Promise<SliceSummary[]> {
    // 并发读，不是串行。
    //
    // 为什么：实测 130 片串行读要 297ms，并发只要 26ms（快 11 倍）——
    // 串行时每个 `await` 都在等一次磁盘往返，而那些往返之间 CPU 全闲着。
    // 这个端点是驾驶舱首屏的必经之路（总览页要看「正在运行」那一节），
    // 慢在这里 = 首屏白屏。
    //
    // ADR-112：多个根之间也并发 —— 根的数量 = 1 + 版本数（个位数）。
    const perRoot = await Promise.all(
      this.workspaces.map((ws) => this.listSlicesInRoot(ws)),
    );
    // ADR-114 的分支证据要问 git —— 用**异步**探针：
    // 同步 spawn 会把事件循环卡住（实测几十行 × 3 次调用合计阻塞 93 秒，
    // 期间 /api/health 都排队），而驾驶舱的每一次请求都落在这条路径上。
    //
    // ZD-045：git 的启动开销在 Windows 上 30–200ms 且会抖 —— 每条请求
    // 各自问一遍，换页一次就要几十次 spawn。按「行身份 + 状态 + updatedAt」
    // 做指纹缓存：任何一行变了就整批重算（宁可多算一次，不许显示旧证据）。
    const merged = mergeSliceSummaries(perRoot);
    const evidence = await this.branchEvidenceFor(merged);
    return merged.map((row, i) => ({ ...row, ...evidence[i] }));
  }

  /**
   * 分支证据（ADR-114）+ 指纹缓存（ZD-045）。
   *
   * 指纹只取「这一行的身份 + 当前状态 + 更新时间」：状态文件变了
   * `updatedAt` 必变；切片增删，行集合必变。**缓存只省 git 进程**，
   * 盘上那份事实每次都重新读 —— 两者不能混成一个缓存。
   */
  private evidenceCache: {
    key: string;
    rows: Array<{ onBranch: boolean | null; committedState: string | null }>;
  } | null = null;
  private evidenceInflight: Promise<Array<{ onBranch: boolean | null; committedState: string | null }>> | null =
    null;

  private branchEvidenceFor(
    rows: SliceSummary[],
  ): Promise<Array<{ onBranch: boolean | null; committedState: string | null }>> {
    const key = rows
      .map((r) => `${r.scope}|${r.label ?? ''}|${r.id}|${r.state}|${r.updatedAt}`)
      .join('\n');
    if (this.evidenceCache?.key === key) return Promise.resolve(this.evidenceCache.rows);
    // 同一时刻只跑一批 —— 几个端点同时被拉时（总览 + 计划对照），
    // 不能让它们各自去 spawn 一遍 git。
    if (this.evidenceInflight) return this.evidenceInflight;
    const run = annotateBranchEvidenceAsync(this.workspaces, rows)
      .then((annotated) => {
        const out = annotated.map(({ onBranch, committedState }) => ({ onBranch, committedState }));
        this.evidenceCache = { key, rows: out };
        return out;
      })
      .finally(() => {
        if (this.evidenceInflight === run) this.evidenceInflight = null;
      });
    this.evidenceInflight = run;
    return run;
  }

  /** 单个根的切片总览 —— 分根读，一片坏不挡住其它。 */
  private async listSlicesInRoot(ws: SliceWorkspace): Promise<SliceSummary[]> {
    const ids = await ws.store.list();
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const slice = await ws.store.read(id);
          return await withRoot(
            await toSummary(slice, ws.budget, this.repoRoot, () => ws.events.read(id)),
            ws.root,
          );
        } catch {
          // 状态文件坏了 —— 跳过，不让一片坏的挡住整个列表
          //
          // 但**必须说出来**：原来这里静默吞掉，导致「磁盘上 130 片、
          // 界面显示 113 片」而没人知道少了 17 片。片子的存在本身是
          // 追溯链的一环 —— 它消失了，人就查不到它了。
          const where = ws.root.label ? `（版本目录 ${ws.root.label}）` : '（仓库根）';
          console.error(`[zelto web] 跳过状态文件读不出的切片：${id}${where}`);
          return null;
        }
      }),
    );
    return results.filter((s): s is SliceSummary => s !== null);
  }

  /** 切片详情 —— 含签字复查的事实与判定。 */
  async getSlice(id: string, loc: SliceLocation = {}): Promise<SliceDetail | null> {
    const ws = await this.resolveWorkspace(id, loc);
    if (!ws) return null;
    const slice = await ws.store.read(id);
    const facts = await this.collectFacts(ws, id);
    const checks = evaluateSignChecks(facts);
    const summaryBase = withRoot(
      await toSummary(slice, ws.budget, this.repoRoot, () => ws.events.read(id)),
      ws.root,
    );
    // 走与列表同一个证据缓存 —— 详情页不该再去 spawn 一遍 git
    const [evidence] = await this.branchEvidenceFor([summaryBase]);
    const summary: SliceSummary = evidence ? { ...summaryBase, ...evidence } : summaryBase;
    return {
      slice,
      summary,
      facts,
      checks,
      trace: facts.trace,
      writes: slice.writes ?? [],
    };
  }

  /** 这片在哪些根里有记录（版本 label；仓库根记为 `root`）。 */
  private async rootsOf(id: string): Promise<string[]> {
    const present: string[] = [];
    for (const ws of this.workspaces) {
      if (await ws.store.exists(id)) present.push(rootLabelOf(ws.root));
    }
    return present;
  }

  /**
   * 收集签字复查事实 —— 与 CLI 走**同一个** core 实现（ADR-072 §5.1）。
   */
  private async collectFacts(ws: SliceWorkspace, id: string): Promise<SignReviewFacts> {
    return collectSignReviewFacts(id, {
      readSlice: (sliceId) => ws.store.read(sliceId),
      readEvents: (sliceId) => ws.events.read(sliceId),
      worktreePath: (sliceId) =>
        ws.worktrees.exists(sliceId) ? ws.worktrees.pathFor(sliceId) : null,
      repoRoot: ws.root.dir,
    });
  }

  /** 某片的事件流。 */
  async sliceEvents(id: string, limit?: number, loc: SliceLocation = {}): Promise<unknown[]> {
    const ws = await this.resolveWorkspace(id, loc);
    if (!ws) return [];
    const list = await ws.events.read(id);
    const trimmed = limit && limit > 0 ? list.slice(-limit) : list;
    return trimmed;
  }

  /** 某片的审计报告。 */
  async sliceAudit(id: string, loc: SliceLocation = {}): Promise<unknown> {
    const ws = await this.resolveWorkspace(id, loc);
    if (!ws) return { entries: [] };
    return ws.audit.forSlice(id);
  }

  /**
   * 全项目度量报告（ADR-010 §5.3 的 `/api/metrics`）。
   *
   * 走 `core/metrics/collector.ts` 的 `generateReport()` ——
   * 与 CLI `zelto summary --metrics` 同一份计算，不另写一套。
   */
  async metrics(): Promise<unknown> {
    const ids = await this.rootWs.store.list();
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
    // ADR-112：每个根各自列停机 —— 版本目录里的停机片同样等人处理
    for (const ws of this.workspaces) {
      for (const id of await ws.store.list()) {
        try {
          const slice = await ws.store.read(id);
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
            scope: ws.root.scope,
            label: ws.root.label,
          });
        } catch {
          // 状态文件坏了 —— 跳过
        }
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
    const rawLimit = await this.rootWs.budget.getLimit('');
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
    // ADR-112：每个根的事件各读各的，按时间合并 —— 根之间互不覆盖
    for (const ws of this.workspaces) {
      for (const sliceId of listEventSlicesIn(ws.zeltoDir)) {
        const list = await ws.events.read(sliceId);
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

  /** 签字请求清单。 */
  async listSignRequests(status?: string, loc: SliceLocation = {}): Promise<unknown[]> {
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
    if (loc.scope !== undefined) {
      return (await this.findWorkspace(loc))?.signs.list(valid) ?? [];
    }
    // 不传 scope：所有根的待签请求合并（ADR-112）——
    // 版本目录里等人的签字请求不能因为「不在根上」就看不见。
    //
    // 每条请求带上 `scope + label`，前端据此把签字路由回正确的根。
    const perRoot = await Promise.all(
      this.workspaces.map(async (ws) =>
        (await ws.signs.list(valid)).map((req) => ({
          ...req,
          scope: ws.root.scope,
          label: ws.root.label,
        })),
      ),
    );
    return perRoot.flat();
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
      // ADR-112：驾驶舱实际扫了哪些根 —— 看不见的根就是「查不到的状态」
      roots: this.listRoots(),
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

    // ── 基线切片 vs 开发切片（分开数）──────────────────────────────
    //
    // 为什么必须分开：基线切片描述**现状**（接管既有项目时登记的），
    // 开发切片是**待办的活**。两者都可能是 `completed`。
    //
    // 实测（nimrtc-v14，2026-11-25）：8 片 completed 里 3 片是基线
    // （`v0-cmake` / `v0-src-log` / `v1-cmake`）—— 那轮实际只开发了 5 片。
    // 混在一起数，人看到「8 个切片都完成了」，而实际在开发的是 5 片。
    //
    // `byState` 保留**全量**（含基线）—— 它是「盘上有多少片这个状态」的事实，
    // 去掉基线会让「磁盘上 8 片 completed」这个事实查不出来。
    // 分开计数是**加**上去的维度，不是替换。
    const devSlices = slices.filter((s) => s.kind === 'development');
    const baselineSlices = slices.filter((s) => s.kind === 'baseline');

    const byState: Record<string, number> = {};
    for (const s of slices) {
      byState[s.state] = (byState[s.state] ?? 0) + 1;
    }
    const devByState: Record<string, number> = {};
    for (const s of devSlices) {
      devByState[s.state] = (devByState[s.state] ?? 0) + 1;
    }

    // ADR-112：待签请求跨根合并 —— 版本目录里的那条同样要出现在概况里。
    // 每条带 scope/label，前端据此路由签字。
    const pendingByRoot = await Promise.all(
      this.workspaces.map(async (ws) =>
        (await ws.signs.list('pending')).map((req) => ({
          ...req,
          scope: ws.root.scope,
          label: ws.root.label,
        })),
      ),
    );
    const pending = pendingByRoot.flat();
    const stalled = slices.filter((s) => s.stalled);

    const spentUsd = slices.reduce((sum, s) => sum + s.spentUsd, 0);
    const rawLimit = await this.rootWs.budget.getLimit('');
    const unlimited = rawLimit === UNLIMITED_BUDGET;
    const limitUsd = unlimited ? null : rawLimit;
    const exhausted = !unlimited && spentUsd >= rawLimit;

    // ── 分根的切片分布（ADR-112）──────────────────────────────────
    //
    // 为什么单列：合并后的总数会让人以为「都在一个地方」。
    // 实际上「这 15 片在 v3 目录里」是一个**要人去做决定**的事实 ——
    // 签字、门禁、开跑都得去那个目录（或经驾驶舱路由过去）。
    const byRoot = this.workspaces.map((ws) => {
      const mine = slices.filter((s) => s.scope === ws.root.scope && s.label === ws.root.label);
      return {
        scope: ws.root.scope,
        label: ws.root.label,
        dir: ws.root.dir,
        total: mine.length,
        byState: mine.reduce<Record<string, number>>((acc, s) => {
          acc[s.state] = (acc[s.state] ?? 0) + 1;
          return acc;
        }, {}),
      };
    });

    return {
      totalSlices: slices.length,
      byState,
      // ── 开发切片（不含基线）—— 「这轮做了多少」的诚实口径 ──
      development: {
        total: devSlices.length,
        byState: devByState,
        completed: devByState.completed ?? 0,
      },
      // ── 基线切片（描述现状，不改代码）—— 单独报，别混进完成度 ──
      baseline: {
        total: baselineSlices.length,
        ids: baselineSlices.map((s) => s.id),
      },
      pendingSignCount: pending.length,
      pendingSigns: pending.map((p) => ({
        id: p.id,
        sliceId: p.sliceId,
        requestedAt: p.requestedAt,
        // ADR-112：签字路由要靠它 —— 请求在哪个根，就签哪个根
        scope: p.scope,
        label: p.label,
      })),
      /** 分根的切片分布 —— 合并总数之外，说清「哪片在哪个目录里」 */
      roots: byRoot,
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
        /**
         * 看门狗已经放弃、状态却停在 running 的片（D-30 / `watchdogGaveUp`）。
         *
         * 为什么要单列：这类片**不是**停机类的任一档（`stall.class` 为 null，
         * `/api/stalls` 与 `stalledCount` 都看不见它），却也不该算「在跑」。
         * 不给前端这一条，总览页的「正在运行」就会把一具尸体算成活的
         * （实测 nimrtc-v14：两片进程没了、自愈 7 次 / 上报过，界面毫无提示）。
         */
        gaveUp: slices.filter((s) => s.watchdogGaveUp).map((s) => ({
          id: s.id,
          liveness: s.liveness,
          recoveries: s.recoveries,
          escalated: s.escalated,
          lastActivityAt: s.lastActivityAt,
          reason: s.liveReason,
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
   * ── ADR-114：计划 vs 实际的对照表 ──
   *
   * 人问的是「**这一版**还差什么」，驾驶舱原来只能回答「盘上有多少片
   * 什么状态」。实测（nimrtc-v14，2026-11-25）两者的差是：版本计划里
   * 16 项全是 `draft`、盘上 15 片全是 `completed`、而版本分支只跟踪了
   * 3 片基线 —— 三个口径没有任何一处并排呈现过。
   *
   * 这里把三个口径并排：
   *   - **计划**：`.zelto/versions/<id>.json`（版本目录里有就用版本目录的，
   *     否则用仓库根的）—— 只读，不判定；
   *   - **盘上**：合并后的切片行（含 ADR-114 的 `onBranch`）；
   *   - **版本分支**：`onBranch === true` 的片数。
   *
   * 只**呈现差异**，不给结论（「计划过期」「某片没做完」都是人要判的）。
   */
  async planCoverage(): Promise<unknown> {
    const slices = await this.listSlices();
    const byId = new Map(slices.map((s) => [s.id, s]));

    // 版本计划：仓库根 + 每个版本目录，按计划 id 取「最近更新的那份」。
    const candidates: Array<{ scope: CockpitScope; label: string | null; plan: VersionPlan }> = [];
    const seenPlans = new Set<string>();
    const planDirs: Array<{ scope: CockpitScope; label: string | null; zeltoDir: string }> = [
      { scope: 'root', label: null, zeltoDir: this.zeltoDir },
      ...this.workspaces.slice(1).map((ws) => ({ scope: ws.root.scope, label: ws.root.label, zeltoDir: ws.zeltoDir })),
    ];
    for (const d of planDirs) {
      for (const plan of readVersionPlans(join(d.zeltoDir, 'versions'))) {
        const key = `${plan.id}\n${d.scope}\n${d.label ?? ''}`;
        if (seenPlans.has(key)) continue;
        seenPlans.add(key);
        candidates.push({ scope: d.scope, label: d.label, plan });
      }
    }

    const plans = [];
    for (const { scope, label, plan } of candidates) {
      // ── ADR-126：产物证据（每个版本分支问一次 git）────────────────────
      //
      // ADR-114 的 `onBranch`（状态文件是否进分支）**恒为 0** ——
      // `.zelto/` 整体在 .gitignore 里，状态文件永远不进版本分支。
      // 这一列没有信息量，还给出误导性结论（读起来像「这版什么都没做完」）。
      //
      // 产物证据问的是**另一件事**：「这个切片 id 在所属版本的分支上
      // 有没有出现过 `Refs-Slice:` trailer」—— 那是提交约定（AGENTS.md），
      // 不依赖 `.zelto/` 是否进 git。
      //
      // 每个版本问一次 git（一次 `git log` 读全量 trailer），不逐片问。
      const artifactByVersion = new Map<string, Map<string, { hash: string; subject: string }> | null>();
      for (const v of plan.versions) {
        const branch = branchOfVersion(v);
        const found = await defaultArtifactProbe.findSliceCommits(
          this.repoRoot,
          branch,
          v.slices.map((s) => s.id),
        );
        artifactByVersion.set(v.version, found);
      }

      plans.push({
        id: plan.id,
        title: plan.title,
        status: plan.status,
        scope,
        label,
        versions: plan.versions.map((v) => {
          const artifacts = artifactByVersion.get(v.version) ?? null;
          const rows = v.slices.map((s) => {
            const actual = byId.get(s.id) ?? null;
            const hit = artifacts?.get(s.id) ?? null;
            return {
            id: s.id,
            title: s.title,
            plannedState: s.state ?? 'draft',
            /** 盘上找不到（计划里有、没有切片文件） */
            onDisk: actual !== null,
            actualState: actual?.state ?? null,
            /** 这一行事实的所在根（ADR-112 路由凭据） */
            scope: actual?.scope ?? null,
            label: actual?.label ?? null,
            /** ADR-114：状态文件是否已进所属根的 git 跟踪 */
            onBranch: actual?.onBranch ?? null,
            committedState: actual?.committedState ?? null,
            /**
             * ADR-126：产物证据 —— 这一片在**所属版本的分支**上有没有
             * 留下过 `Refs-Slice:` 标记的提交。
             *
             * 与 `onBranch` 的区别：`onBranch` 问的是「状态文件进 git 了没」
             * （`.zelto/` 被忽略 → 恒为 false）；这一项问的是「产物在分支上了没」
             * —— 那才是「这版做完没有」的真凭据。
             */
            artifactOnBranch: artifacts === null ? null : hit !== null,
            artifactCommit: hit?.hash ?? null,
            artifactSubject: hit?.subject ?? null,
          };
        });
        return {
          version: v.version,
          description: v.description,
          dependsOn: v.dependsOn,
          status: v.status,
          branch: branchOfVersion(v),
          baseCommit: v.baseCommit ?? null,
          slices: rows,
          /**
           * 计数口径（**分开数，不合成一个「完成度」**）：
           * - planned：计划里这一版的片数
           * - onDisk：盘上有状态文件的片数
           * - completed：盘上 completed 的片数
           * - onBranch：已完成且状态文件已进版本分支的片数
           *   （`.zelto/` 在 .gitignore 里 → 这一项通常恒为 0，
           *   保留是为了不丢掉 ADR-114 已有的事实）
           * - artifactOnBranch：**产物提交**在所属版本分支上的片数
           *   （ADR-126）—— 这才是「这版做完没有」的可查证凭据
           *
           * 「计划 10 片里 7 片在分支上完成」与「盘上 10 片全 completed
           * 但分支只跟踪 0 片」是两种事实，合成一个百分比会抹掉差别。
           */
          counts: {
            planned: rows.length,
            onDisk: rows.filter((r) => r.onDisk).length,
            completed: rows.filter((r) => r.actualState === 'completed').length,
            onBranch: rows.filter((r) => r.actualState === 'completed' && r.onBranch === true).length,
            artifactOnBranch: rows.filter((r) => r.artifactOnBranch === true).length,
          },
        };
        }),
      });
    }

    return { plans };
  }

  /**
   * 找到「持有这条签字请求的那个根」—— ADR-112 的路由。
   *
   * 传了 scope 就只看那个根（找不到就是找不到，**不跨根猜**）；
   * 没传就按根的顺序找第一个有这条请求的根。
   *
   * 为什么不传 scope 时也按「最近写的」合并判断：
   * 签字请求的 id 是唯一的，同一 id 不会出现在两个根里 ——
   * 找到即唯一，不存在需要挑「哪份更新」的情形。
   */
  private async workspaceHoldingSign(
    signId: string,
    loc: SliceLocation,
  ): Promise<SliceWorkspace | null> {
    const candidates = loc.scope !== undefined ? [this.findWorkspace(loc)] : this.workspaces;
    for (const ws of candidates) {
      if (!ws) continue;
      try {
        await ws.signs.get(signId);
        return ws;
      } catch {
        // 这个根没有这条请求 —— 看下一个
      }
    }
    return null;
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
    loc: SliceLocation = {},
  ): Promise<
    | { ok: true; request: unknown; checks: SignCheck[] }
    | { ok: false; reason: string; checks: SignCheck[]; error?: string }
  > {
    const ws = await this.workspaceHoldingSign(signId, loc);
    if (!ws) {
      return { ok: false, reason: `签字请求不存在：${signId}`, checks: [] };
    }
    const request = await ws.signs.get(signId);

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

    // 服务端重算判定 —— 前端传什么都不作数。
    // ADR-112：事实必须从**签字请求所在的那个根**收集 ——
    // 拿根上那份过期副本算出来的是另一片的事实。
    let checks: SignCheck[];
    try {
      const facts = await this.collectFacts(ws, request.sliceId);
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
      const approved = await ws.signs.approve(signId, 'human', null);
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
  async rejectSign(signId: string, comment?: string | null, loc: SliceLocation = {}): Promise<
    | { ok: true; request: unknown }
    | { ok: false; reason: string }
  > {
    // ADR-112：拒签落在请求所在的根
    const ws = await this.workspaceHoldingSign(signId, loc);
    if (!ws) return { ok: false, reason: `签字请求不存在：${signId}` };
    const request = await ws.signs.get(signId);

    if (request.status !== 'pending') {
      return { ok: false, reason: `签字请求已是 ${request.status} 状态，不能再拒绝` };
    }

    try {
      const rejected = await ws.signs.reject(signId, 'human', comment ?? null);
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
    loc: SliceLocation = {},
  ): Promise<
    | { ok: true; questionId: string; nextStep: string }
    | { ok: false; reason: string }
  > {
    const text = (answer ?? '').trim();
    if (!text) {
      return { ok: false, reason: '答案为空' };
    }

    // ADR-112：答案与事件落回切片所在的根
    const ws = (await this.resolveWorkspace(sliceId, loc)) ?? this.rootWs;

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
    await ws.events.append(sliceId, 'question.answered', 'human', {
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

    await this.rootWs.events.append('batch', 'batch.halted', 'human', {
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
  private lifecycleContext(ws: SliceWorkspace): LifecycleContext {
    return {
      // ADR-112：编排必须跑在**切片所在的那个根**上 ——
      // 规格、验收目录、事件流、写集预检全是这个根的事实。
      repoRoot: ws.root.dir,
      store: ws.store,
      events: ws.events,
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
    loc: SliceLocation = {},
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
    //
    // ADR-112：存在性要在**切片所属的那个根**上查 ——
    // 根上有、版本目录里没有，与「点错了」是两件事。
    const ws = await this.resolveWorkspace(sliceId, loc);
    if (!ws || !(await ws.store.exists(sliceId))) {
      return {
        ok: false,
        reason: `切片 "${sliceId}" 不存在`,
        details: [],
        advisories: [],
        notFound: true,
      };
    }

    const outcome = await freezeSlice(this.lifecycleContext(ws), sliceId, {
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
    options: { only?: string; retry?: number; dryRun?: boolean; full?: boolean } = {},
    loc: SliceLocation = {},
  ): Promise<{
    ok: boolean;
    reason: string;
    details: string[];
    advisories: string[];
    facts?: Record<string, unknown>;
    notFound?: boolean;
  }> {
    // ADR-112：门禁跑在切片所属的那个根（规格 / 验收 / 事件都是它的）
    const ws = await this.resolveWorkspace(sliceId, loc);
    if (!ws || !(await ws.store.exists(sliceId))) {
      return {
        ok: false,
        reason: `切片 "${sliceId}" 不存在`,
        details: [],
        advisories: [],
        notFound: true,
      };
    }

    const config = loadConfigAt(ws.root.dir);
    const gateRoot = ws.worktrees.exists(sliceId)
      ? ws.worktrees.pathFor(sliceId)
      : undefined;

    const outcome = await runGate(
      this.lifecycleContext(ws),
      sliceId,
      {
        commands: config.gate.commands.map((c) => ({ name: c.name, run: c.run })),
        ...(config.gate.profiles ? { profiles: config.gate.profiles } : {}),
        timeoutSec: config.gate.timeoutSec,
        retryMax: config.gate.retry.max,
        ...(config.gate.acceptance ? { acceptance: config.gate.acceptance } : {}),
        // 门禁作用域（ADR-097）—— Web 与 CLI 用同一套规则，
        // 否则「网页上验过的」与「命令行验过的」口径不一致。
        ...(config.gate.scope ? { scope: config.gate.scope } : {}),
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
        // `--full`（ADR-097）—— 人显式要求跑全量，不做作用域收窄。
        ...(options.full ? { full: true } : {}),
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
    loc: SliceLocation = {},
  ): Promise<{
    ok: boolean;
    reason: string;
    details: string[];
    advisories: string[];
    facts?: Record<string, unknown>;
    notFound?: boolean;
  }> {
    // ADR-112：续跑落在切片所属的那个根
    const ws = await this.resolveWorkspace(sliceId, loc);
    if (!ws || !(await ws.store.exists(sliceId))) {
      return {
        ok: false,
        reason: `切片 "${sliceId}" 不存在`,
        details: [],
        advisories: [],
        notFound: true,
      };
    }

    const outcome = await resumeSlice(this.lifecycleContext(ws), sliceId, options);
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
    loc: SliceLocation = {},
  ): Promise<{
    ok: boolean;
    reason: string;
    taskId?: string;
    supervisorPid?: number;
    nextStep?: string;
  }> {
    // ADR-112：开跑要拉起**切片所在那个根**的 CLI ——
    // CLI 的 cwd 决定了它读哪份 `.zelto/`。在仓库根拉起版本目录的切片，
    // 等于让 CLI 去根上找一片不存在的切片。
    const ws = await this.resolveWorkspace(sliceId, loc);
    if (!ws || !(await ws.store.exists(sliceId))) {
      return { ok: false, reason: `切片 "${sliceId}" 不存在` };
    }

    // 同时在跑的 detached 任务数有上限 —— 点错一下就可能同时拉起多个 agent，
    // 而每个 agent 都在烧 token。这不是安全漏洞，是**成本失控**的闸门。
    //
    // 计数按这个根的 tasks 目录算：不同根的 agent 是不同的进程，
    // 但上限是**这台机器**的烧钱闸门，所以按所有根求和。
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

    const launch = await launchRun(ws.root.dir, sliceId, {
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
    // ADR-112：每个根各有自己的 tasks 目录 —— 加起来才是全机在跑数
    let count = 0;
    for (const ws of this.workspaces) {
      const tasksDir = join(ws.zeltoDir, 'tasks');
      let entries: string[];
      try {
        entries = readdirSync(tasksDir);
      } catch {
        // 这个根没有任务目录 = 它没有任何后台运行
        continue;
      }

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
 * 一个根的「名字」—— 仓库根记为 `root`，版本目录用 label。
 *
 * 合并时的证据字段（`roots`）与稳定排序都用它。
 */
function rootLabelOf(root: CockpitRoot): string {
  return root.label ?? 'root';
}

/** 把一条总览行标注上它来自哪个根（以及它出现过的其它根）。 */
function withRoot(
  summary: Omit<SliceSummary, 'scope' | 'label' | 'roots' | 'onBranch' | 'committedState'>,
  root: CockpitRoot,
  otherRoots: string[] = [],
): SliceSummary {
  const here = rootLabelOf(root);
  const roots = [here, ...otherRoots.filter((r) => r !== here)];
  // onBranch / committedState 由调用方（需要 git 事实的那层）补上 ——
  // 这里只填占位，保证「单根行」与「合并行」形状一致。
  return { ...summary, scope: root.scope, label: root.label, roots, onBranch: null, committedState: null };
}

/**
 * 把各根的总览行按 id 合并成一份列表（ADR-112 决策二）。
 *
 * 同一片在多个根里都有时（基线切片实测在根 / v1 / v2 / v3 都有副本），
 * 只留**一行**，事实取「`updatedAt` 较晚」的那份 —— 那是最近被真正动过的一份。
 * 同一时刻（复制产生的副本时间戳相同）→ 先出现的根胜出（`root` 在前，
 * 版本按 label 字典序）—— 保证**确定性**，同一棵树两次扫描结论一致。
 *
 * `roots` 字段记录这一片出现过的**所有根** —— 合并的是「取哪份」，不是
 * 「抹掉别的根有过它」这件事。
 */
function mergeSliceSummaries(perRoot: SliceSummary[][]): SliceSummary[] {
  const byId = new Map<string, SliceSummary>();
  for (const list of perRoot) {
    for (const s of list) {
      const prev = byId.get(s.id);
      if (!prev) {
        byId.set(s.id, s);
        continue;
      }
      const newer = s.updatedAt > prev.updatedAt ? s : prev;
      const roots = Array.from(new Set([...prev.roots, ...s.roots]));
      byId.set(s.id, { ...newer, roots });
    }
  }
  // 稳定排序：updatedAt 倒序；同刻按 id 字典序（Array.sort 在 V8 上稳定，但显式更保险）
  return Array.from(byId.values()).sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 一个根的事件目录下有哪些切片的事件流（ADR-112）。
 *
 * 直接扫 `<zeltoDir>/events`：事件流是追溯的唯一证据载体（C4），
 * 「最近事件」该照事件目录说话，而不是照「哪些切片还有状态文件」说话。
 * 只取**真有** `events.jsonl` 的目录，空目录不当成切片。
 */
function listEventSlicesIn(zeltoDir: string): string[] {
  const dir = join(zeltoDir, 'events');
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
    baseline?: boolean;
  },
  budget: BudgetCollector,
  repoRoot: string,
  loadEvents: () => Promise<EventEnvelope[]>,
): Promise<Omit<SliceSummary, 'scope' | 'label' | 'roots' | 'onBranch' | 'committedState'>> {
  const runs = slice.runs ?? [];
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;

  // 基线还是开发 —— 判定在 core（C3）。事件流只在真需要时才读
  // （`classifySliceKindAsync` 自己管这个）。
  const kind = await classifySliceKindAsync(
    { id: slice.id, state: slice.state, baseline: slice.baseline },
    loadEvents,
  );

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
    kind,
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
    watchdogGaveUp: slice.state === 'running' && (liveness === 'dead' || liveness === 'stale'),
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
