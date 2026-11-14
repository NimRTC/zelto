// 事实收集 —— `zelto sign --review` 的 CLI 层输入（ADR-070 §5.1）
//
// 本模块是整个流程里唯一允许读 `.zelto` 文件、跑 git 的模块：
//   - 切片摘要与 trace：读 `.zelto/slices/<id>.json`
//   - 事件事实：读 `.zelto/events/<id>/events.jsonl`，过滤
//     `gate.result` / `budget.spent` / `stall.classified` / `policy.violation`
//   - 改动统计：`git diff HEAD --numstat`（git 调用不能进 core/，C2）
//   - 产物证据：复用 artifact-evidence.ts 的判据（collectTrunkSnapshot +
//     judgeArtifactEvidence，语义见 ADR-059/061）。该模块在本工作树中
//     尚未落地，判据按同语义内联在此，接口与语义保持一致。
//
// 只收集、不判定 —— 判定全部委托给 `core/sign-review/evaluate.ts` 的
// `evaluateSignChecks`（C3：纯函数、确定性、可复现）。

import { execFileSync } from 'node:child_process';
import { events, store, existingWorktreePath } from '../commands/shared.js';
import { parseTestRunnerStats } from '../../core/gate/acceptance.js';
import type { EventEnvelope } from '../../core/events/stream.js';
import type { ArtifactEvidence, SignReviewFacts } from '../../core/sign-review/types.js';

/**
 * 收集一片切片的签字复查事实。
 *
 * 读 slice 文件、事件流、跑 git，全部是只读动作（C1/C4：不写状态、不追加事件）。
 * 返回 `SignReviewFacts` —— 已算好的事实，不含任何判定。
 *
 * 事件文件缺失（新切片无事件目录）时不崩：按空处理，gate/cost/stall 段
 * 标「无记录」，由 evaluate 侧判失败并明示证据缺失。
 */
export async function collectSignReviewFacts(sliceId: string): Promise<SignReviewFacts> {
  const slice = await store.read(sliceId);
  const allEvents = await events.read(sliceId);

  const gateResultEvents = allEvents.filter((e) => e.type === 'gate.result');
  const budgetEvents = allEvents.filter((e) => e.type === 'budget.spent');
  const stallEvents = allEvents.filter((e) => e.type === 'stall.classified');
  const violationEvents = allEvents.filter((e) => e.type === 'policy.violation');

  const gate = collectGateFacts(gateResultEvents);
  const diff = collectDiffFacts(sliceId);
  const artifact = collectArtifactFacts(slice.writes);

  return {
    sliceId,
    sliceState: slice.state,
    trace: {
      requirements: traceEntriesToStrings(slice.trace?.requirements),
      contracts: traceEntriesToStrings(slice.trace?.contracts),
      tests: traceEntriesToStrings(slice.trace?.tests),
    },
    gate,
    diff,
    cost: { totalUsd: sumBudget(budgetEvents) },
    stall: collectStallFacts(stallEvents),
    writeSetAudit: collectWriteSetAudit(violationEvents, gateResultEvents),
    artifact,
  };
}

// ─── trace ───────────────────────────────────────────────────────────────────

/**
 * 把 trace 条目归一化成字符串数组。
 *
 * 真实切片文件里 trace.requirements 的条目是对象（`{ text, ref, kind }`），
 * 老格式是字符串。`SignReviewFacts.trace` 的契约是 `string[]` ——
 * 这里把对象收敛成 `ref ?? text`，字符串原样透传。
 */
function traceEntriesToStrings(items: unknown[] | undefined): string[] {
  if (!Array.isArray(items)) return [];
  return items.map((it): string => {
    if (typeof it === 'string') return it;
    if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>;
      if (typeof o.ref === 'string' && o.ref) return o.ref;
      if (typeof o.text === 'string' && o.text) return o.text;
    }
    return String(it);
  });
}

// ─── gate ────────────────────────────────────────────────────────────────────

/** `gate.result` 事件 payload 里用到的字段形态（与 core/gate/types.ts 对齐） */
interface GateResultPayloadLike {
  passed?: boolean;
  acceptance?: {
    status?: string;
    path?: string | null;
    command?: string | null;
    durationMs?: number;
  };
  results?: Array<{
    command?: string;
    passed?: boolean;
    stdout?: string;
  }>;
}

/**
 * 从 `gate.result` 事件里取验收事实（ADR-033/051）。
 *
 * 主路径：`acceptance.status` 明确给出结论（`passed` / `failed`）——
 * 项目配了 `gate.acceptance` 段，切片级验收的结论直接可读。
 *
 * 回退路径（第二轮修复）：`acceptance.status` 为 `skipped` 或缺失时 ——
 * 项目没配 `gate.acceptance` 段，真正跑过的验收是 `spec.gateCommands`
 * 里名字含 `acceptance` 的命令（如 `acceptance-cli`）。回退扫描
 * `results[]`，有一条 passed 且 stdout 能解析出 `pass > 0`（复用
 * `parseTestRunnerStats`），即判 ran/passed；pass/total 从该命令的
 * stdout 解析（ADR-033/051 + v2-sign-review-fix）。
 *
 * 没有 gate.result 事件 → 判「没跑过」。解析不到统计 → 按 0/0 ——
 * 查不到就是查不到，不冒充数字（ADR-059 哲学）。
 */
function collectGateFacts(gateResultEvents: EventEnvelope[]): SignReviewFacts['gate'] {
  const latest = gateResultEvents.length > 0 ? gateResultEvents[gateResultEvents.length - 1] : null;
  if (!latest) {
    return { acceptanceRan: false, acceptancePassed: false, passCount: 0, totalCount: 0 };
  }

  const payload = latest.payload as GateResultPayloadLike;
  const status = payload.acceptance?.status;

  // 主路径：显式验收配置给出了结论（passed / failed）
  if (status === 'passed' || status === 'failed') {
    const ran = true;
    const passed = status === 'passed';

    let passCount = 0;
    let totalCount = 0;
    if (Array.isArray(payload.results)) {
      const accResult = payload.results.find((r) => r.command === 'acceptance');
      if (accResult && typeof accResult.stdout === 'string') {
        const stats = parseTestRunnerStats(accResult.stdout);
        if (stats.known) {
          passCount = stats.pass;
          totalCount = stats.pass + stats.fail + stats.todo + stats.skipped;
        }
      }
    }

    return { acceptanceRan: ran, acceptancePassed: passed, passCount, totalCount };
  }

  // 回退路径：acceptance 缺失或 skipped —— 扫描 spec.gateCommands 的验收命令
  return collectAcceptanceFromResults(payload.results);
}

/**
 * 回退路径：在 `gate.result.results[]` 里找名字含 `acceptance` 的命令。
 *
 * 判据只有一条：passed=true 且 stdout 能解析出 `pass > 0`（复用
 * `parseTestRunnerStats`）。找到就采用该命令解析出的 pass/total；
 * 一条都找不到 → 没跑过（0/0）—— 不把「跑过但解析不到统计」冒充成通过。
 */
function collectAcceptanceFromResults(
  results: GateResultPayloadLike['results'],
): SignReviewFacts['gate'] {
  if (!Array.isArray(results)) {
    return { acceptanceRan: false, acceptancePassed: false, passCount: 0, totalCount: 0 };
  }
  for (const r of results) {
    if (typeof r.command !== 'string' || !r.command.includes('acceptance')) continue;
    if (r.passed !== true) continue;
    if (typeof r.stdout !== 'string') continue;
    const stats = parseTestRunnerStats(r.stdout);
    if (stats.known && stats.pass > 0) {
      return {
        acceptanceRan: true,
        acceptancePassed: true,
        passCount: stats.pass,
        totalCount: stats.pass + stats.fail + stats.todo + stats.skipped,
      };
    }
  }
  return { acceptanceRan: false, acceptancePassed: false, passCount: 0, totalCount: 0 };
}

// ─── cost ────────────────────────────────────────────────────────────────────

/** 把 `budget.spent` 事件的 amount 全部加起来（ADR-035）。 */
function sumBudget(budgetEvents: EventEnvelope[]): number {
  let total = 0;
  for (const e of budgetEvents) {
    if (typeof e.payload.amount === 'number' && Number.isFinite(e.payload.amount)) {
      total += e.payload.amount;
    }
  }
  return total;
}

// ─── stall ───────────────────────────────────────────────────────────────────

/**
 * 从 `stall.classified` 事件取停机事实（ADR-041）。
 *
 * 取最新一条的分类。没有停机事件 → 没停过。
 */
function collectStallFacts(stallEvents: EventEnvelope[]): SignReviewFacts['stall'] {
  const latest = stallEvents.length > 0 ? stallEvents[stallEvents.length - 1] : null;
  const stallClass = latest && typeof latest.payload.class === 'string' ? latest.payload.class : null;
  return { stalled: stallClass !== null, stallClass };
}

// ─── write-set audit ─────────────────────────────────────────────────────────

/**
 * 从 `policy.violation` 事件取写集审计结论（ADR-014）。
 *
 * 审计结论已经落在事件流里（runtime-guard.ts 的 reportAuditResult），
 * 控制面读事件即可，不重跑审计（ADR-070 §5.2）。没有 violation 事件 =
 * 没有记录到越界 = 空清单。
 *
 * 陈旧结论消解（第二轮修复）：越界之后可能扩了写集、重跑了门禁并最终
 * 通过 —— 早先记下的越界就成了过时结论。判据：最新一条通过
 * （passed=true）的 `gate.result` 事件时间晚于最新一条 `policy.violation`
 * 事件，则越界已在扩写集/重跑后解决，violations 清空；否则保留原结论
 * （fail closed —— 不知道解决没解决，就不替人撤销越界记录）。
 */
function collectWriteSetAudit(
  violationEvents: EventEnvelope[],
  gateResultEvents: EventEnvelope[],
): SignReviewFacts['writeSetAudit'] {
  if (violationEvents.length === 0) return { violations: [] };
  const latestViolation = violationEvents[violationEvents.length - 1];

  // 最新一条通过（passed=true）的 gate.result —— 按文件顺序取最后一条
  let latestPassedGate: EventEnvelope | null = null;
  for (const e of gateResultEvents) {
    if (e.payload.passed === true) latestPassedGate = e;
  }
  if (latestPassedGate && isTimestampAfter(latestPassedGate.ts, latestViolation.ts)) {
    return { violations: [] };
  }

  const violations = latestViolation.payload.violations;
  if (!Array.isArray(violations)) return { violations: [] };
  return { violations: violations.filter((v): v is string => typeof v === 'string') };
}

/** 两条 ISO 时间戳谁更晚。同格式 ISO 字符串比较已等价；解析失败退化字符串比较。 */
function isTimestampAfter(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta > tb;
  return a > b;
}

// ─── diff ────────────────────────────────────────────────────────────────────

/**
 * 跑 `git diff HEAD --numstat` 取改动统计。
 *
 * 有切片 worktree 时在 worktree 里跑（agent 的未提交改动在那里）；
 * 否则在当前目录跑。git 失败（非 git 仓库 / 无提交）→ 按 0 处理，不抛错
 * （与产物证据的 `unknown` 同哲学：读不到就说读不到）。
 */
function collectDiffFacts(sliceId: string): SignReviewFacts['diff'] {
  const worktreePath = existingWorktreePath(sliceId);
  const cwd = worktreePath ?? process.cwd();

  let filesChanged = 0;
  let addedLines = 0;
  let deletedLines = 0;

  try {
    const out = execFileSync('git', ['diff', 'HEAD', '--numstat'], {
      cwd,
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      // git 在非仓库目录会把整页 usage 打到 stderr —— 那不该漏到用户终端。
      // stdout 仍走管道（要拿返回值），stderr 丢弃（读不到就说读不到，不刷屏）。
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      const cols = line.trim().split('\t');
      if (cols.length < 3) continue;
      const add = cols[0] === '-' ? 0 : Number.parseInt(cols[0], 10) || 0;
      const del = cols[1] === '-' ? 0 : Number.parseInt(cols[1], 10) || 0;
      filesChanged += 1;
      addedLines += add;
      deletedLines += del;
    }
  } catch {
    // 非 git 仓库 / 没有 HEAD —— 查不到就按 0
  }

  return { filesChanged, addedLines, deletedLines };
}

// ─── artifact ────────────────────────────────────────────────────────────────

/**
 * 产物证据（ADR-059/061）—— 判据与 artifact-evidence.ts 一致。
 *
 * `judgeArtifactEvidence` 返回三态字符串；这里包成 `SignReviewFacts.artifact`
 * 的对象形态。git 读不到（空快照）时退为 `unknown`，由 collectTrunkSnapshot
 * 的空快照特判保证。
 */
function collectArtifactFacts(writes: string[]): ArtifactEvidence {
  const snapshot = collectTrunkSnapshot(process.cwd());
  const status = judgeArtifactEvidence(writes, snapshot);
  if (status === 'in-trunk') {
    const present = writes
      .map((w) => judgeWrite(w, snapshot))
      .find((v) => v.concrete && v.present);
    return { status, path: present?.path ?? null, hash: null, note: null };
  }
  if (status === 'not-in-trunk') {
    const missing = writes
      .map((w) => judgeWrite(w, snapshot))
      .find((v) => v.concrete && !v.present);
    return { status, path: missing?.path ?? null, hash: null, note: null };
  }
  return {
    status,
    path: null,
    hash: null,
    note: '产物证据未知：HEAD 读不到，或写集里没有可逐个核对的具体路径',
  };
}

// ── 主干树快照与产物判据（内联，语义同 artifact-evidence.ts）───────────────

/**
 * 主干树快照 —— 一次 `ls-tree`，多片复用。
 *
 * **必须关掉 `core.quotePath`**：git 默认对非 ASCII 路径加引号
 * （`"docs/zelto-\345\234\272..."`），加引号后的路径跟真实路径对不上，
 * 于是所有中文路径都会被误判成「不在主干」。
 */
interface TrunkSnapshot {
  /** HEAD 里的所有文件路径 */
  files: Set<string>;
  /** HEAD 里的所有目录路径（带尾斜杠） */
  dirs: Set<string>;
}

function collectTrunkSnapshot(repoRoot: string = process.cwd()): TrunkSnapshot {
  const files = new Set<string>();
  const dirs = new Set<string>();
  try {
    const out = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'HEAD'],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        // 同 collectDiffFacts：git 探测失败时的 stderr 不进用户终端。
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    for (const raw of out.split('\n')) {
      const f = raw.trim();
      if (!f) continue;
      files.add(f);
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
    }
  } catch {
    // 不是 git 仓库 / 没有 HEAD —— 快照是空的。
    // 空的快照会让所有具体路径判成 not-in-trunk，
    // 那比「查不到」更糟 —— 所以下面判据里对空快照特殊处理。
    return { files: new Set(), dirs: new Set() };
  }
  return { files, dirs };
}

/** 一个写集条目的判定结果 */
interface WriteVerdict {
  /** 归一化后的写集路径 */
  path: string;
  /** 是否是「具体路径」（能逐个核对） */
  concrete: boolean;
  /** 是否在 HEAD 的树里 */
  present: boolean;
}

/** 一个写集条目的解析结果 */
interface ParsedWrite {
  /** 归一化后的路径（自然语言后缀已切掉） */
  path: string;
  /** 原条目里带不带自然语言后缀（带后缀 = 描述集合，不可核对） */
  prose: boolean;
}

function parseWrite(raw: string): ParsedWrite {
  let w = String(raw).trim();
  // 去掉 markdown 反引号与引号
  w = w.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '');
  // 切掉自然语言后缀（`src/x.ts（以及 ...）` → `src/x.ts`）
  const cut = w.search(/[（(]/);
  const prose = cut > 0;
  if (prose) w = w.slice(0, cut);
  return { path: w.trim(), prose };
}

/**
 * 这个写集条目是不是「具体路径」—— 能逐个核对。
 *
 * 不能核对的三类：glob、目录（带尾斜杠的由目录判据处理）、自然语言描述。
 */
function isConcreteWrite(write: string): boolean {
  if (!write) return false;
  if (/[*?{}[\]]/.test(write)) return false;
  if (/\s/.test(write)) return false;
  return true;
}

/**
 * 逐条判定写集条目在不在主干（ADR-059 §5.2）。
 *
 * 目录写集：看这个目录在主干里有没有内容；自然语言条目：不可核对。
 */
function judgeWrite(write: string, snapshot: TrunkSnapshot): WriteVerdict {
  const parsed = parseWrite(write);
  if (!parsed.path) return { path: parsed.path, concrete: false, present: false };

  // 带自然语言后缀 → 描述的是集合，不是单个文件 → 不核对
  if (parsed.prose) return { path: parsed.path, concrete: false, present: false };

  if (parsed.path.endsWith('/')) {
    // 目录写集
    const dir = parsed.path;
    if (snapshot.dirs.has(dir)) return { path: parsed.path, concrete: true, present: true };
    return { path: parsed.path, concrete: true, present: false };
  }

  if (!isConcreteWrite(parsed.path)) return { path: parsed.path, concrete: false, present: false };

  return { path: parsed.path, concrete: true, present: snapshot.files.has(parsed.path) };
}

/**
 * 汇总一片切片的产物证据（三态 `in-trunk | not-in-trunk | unknown`）。
 *
 * **空快照特判**：HEAD 读不出来时（不是 git 仓库 / 没有提交），
 * 所有具体路径都会判成「不在」。那是假阴性 —— 直接返回 `unknown`。
 */
function judgeArtifactEvidence(
  writes: string[],
  snapshot: TrunkSnapshot,
): 'in-trunk' | 'not-in-trunk' | 'unknown' {
  if (snapshot.files.size === 0) return 'unknown';

  const verdicts = writes.map((w) => judgeWrite(w, snapshot));
  const concrete = verdicts.filter((v) => v.concrete);
  if (concrete.length === 0) return 'unknown';

  return concrete.every((v) => v.present) ? 'in-trunk' : 'not-in-trunk';
}
