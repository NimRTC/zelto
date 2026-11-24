// 运行时守卫 — 把「写集预约」从纸面约定变成 agent 跑起来时真的拦得住的东西（C9）
//
// 之前写集只被用来做两件事：准入时判断切片之间会不会撞车，合并时判断工件冲突。
// 也就是说「这个切片只允许写这些路径」从来只是一句承诺 —— agent 想写哪就写哪，
// 门禁看到的是提交之后的成品，不是过程。ADR-014 把这件事补上：
//
//   1. 取写集预约 —— 落在 .zelto/locks/<sliceId>.json，agent 跑的时候 hook 读它
//   2. 装 PreToolUse 钩子 —— 每一次写文件之前判定一次，越界当场拒绝
//   3. 运行后审计 —— 拿 git 的真实改动再对一次写集，兜住静态分析漏掉的写
//
// 判定本身是确定性的（C3）：不调模型、不触网，hook 只做路径匹配。
// 这不是操作系统沙箱 —— 真正的隔离需要特权进程，zelto 不做那件事（ADR-014 §6）。
//
// C1: 状态只落在文件里
// C4: 取预约、放预约、审计结论都写 append-only 事件

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  type ManagedFile,
  type SpecIntegrity,
  type WriteAuditResult,
  type WriteReservation,
  ReservationStore,
  auditWorktreeWrites,
  hashFile,
  listChangedPaths,
  LOCKS_DIR,
} from '../../core/sched/index.js';
import { events } from './shared.js';
import { handleWriteSetViolation } from './run-support.js';
import {
  CLAUDE_SETTINGS_RELATIVE,
  CURSOR_HOOKS_RELATIVE,
  type ClaudeHookOptions,
  buildPreToolHookExec,
  installClaudeCodeHook,
  installCodexHook,
  installCursorHook,
  removeClaudeCodeHook,
  removeCodexHook,
  removeCursorHook,
} from './hook-install.js';

/** zelto 装进 worktree 的 Claude Code 设置文件（相对 worktree 的路径） */
export const MANAGED_SETTINGS_PATH = CLAUDE_SETTINGS_RELATIVE.replace(/\\/g, '/');
/** zelto 装进 worktree 的 Cursor 钩子文件（相对 worktree 的路径） */
export const MANAGED_CURSOR_HOOKS_PATH = CURSOR_HOOKS_RELATIVE.replace(/\\/g, '/');
/** zelto 装进 worktree 的 Codex 钩子文件（相对 worktree 的路径） */
export const MANAGED_CODEX_HOOKS_PATH = 'codex/hooks.json';

/**
 * 守卫要装哪种 harness 的钩子。
 *
 * Claude Code 是默认（保持旧行为）；Cursor / Codex 走各自的信封。
 * 装错 harness = hook 收不到自己认识的格式 → 判不了 →
 * 在 Cursor 的 fail-open 默认下**放行一切**（闸门形同虚设）。
 */
export type GuardHarness = 'claude-code' | 'cursor' | 'codex';

/**
 * 开工时的基线快照（D-29）：worktree 建出来那一刻就已经脏的路径。
 *
 * 主仓工作区里本来就有 `-dirty`（例如 nimrtc 的 msquic 嵌套 submodule
 * 被改过），worktree 继承了这份脏。快照只读 `git status`，不调模型、
 * 不触网（C3）。返回相对 worktree 的正斜杠路径。
 *
 * ── 读不到时**不能**假装干净（D-61）────────────────────────────
 *
 * 原来的写法是 `catch { return []; }` —— 读不到就返回空数组，
 * 语义上是「这个 worktree 一开始是干净的」。
 *
 * **但「读不到」和「干净」是两件事。**
 *
 * 实测（nimrtc-zelto v3-weaknet-verdict，2026-11-17）：
 * worktree 建在大仓库上，`git status --porcelain --untracked-files=all`
 * 跑了 **60 秒还没完** → 撞上 `timeout: 60_000` → 抛异常
 * → 快照返回 `[]` → 审计以为「预置脏不存在」
 * → 那个本来就脏的规格副本被判成「agent 越界写入」
 * → 整轮作废（agent 一个字节都没碰它）。
 *
 * 同一片重跑一次，那次 git status 1.2 秒就完了 —— 快照正常，
 * 结果那一轮什么毛病都没有。**同一个工程、同一个文件，
 * 两次运行结论相反。**
 *
 * 这比「读不到」本身严重：**判定的输入不可复现**。
 *
 * 修法：**读不到就明确说读不到**，别装作干净。
 * `snapshotBaselineChanged` 失败时抛出去，让调用方决定怎么办 ——
 * 而调用方（装守卫）**拒绝开工**：基线不明的运行，
 * 审计结论必然不可信（要么误判越界，要么漏判越界）。
 *
 * 「不阻断开工」是错的取舍：宁可这一轮不跑，
 * 也不要跑出一轮**结论随缘**的判定。
 */
export function snapshotBaselineChanged(worktreePath: string): string[] {
  try {
    // D-63：不用 `git status --porcelain --untracked-files=all`。
    //
    // 实测（nimrtc-zelto，2026-11-18，刚建出来的 worktree）：
    //   status --untracked-files=all → 224 秒
    //   diff + ls-files --others     →  13 秒（冷）/ 0.6 秒（热）
    //
    // 224 秒比任何合理超时都长 —— 快照直接被超时打断，
    // 整轮开工被拒（「基线不明就不开工」，D-61）。
    //
    // 病根在 `--untracked-files=all`：它要逐个 stat 每一个未跟踪文件，
    // 而 nimrtc 带两个大 submodule，冷缓存下遍历整棵树要几分钟。
    // `git ls-files --others --exclude-standard` 走索引与目录项，
    // 同样语义下快 17 倍。
    //
    // 语义等价：`listChangedPaths` 用 diff + diff --cached + ls-files 三条
    // 命令覆盖 porcelain 的全部状态（已改/已暂存/已删/未跟踪）。
    return listChangedPaths(worktreePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `无法取得 worktree 的基线快照（读工作区改动失败）：${message}\n` +
        `  worktree：${worktreePath}\n` +
        `  这一轮不开工 —— 基线不明的话，运行后的写集审计分不清\n` +
        `  「这个文件本来就是脏的」与「agent 越界改了它」，\n` +
        `  结论会随 git status 的快慢变化。`,
    );
  }
}

export interface RuntimeGuardOptions {
  /** 切片 id */
  sliceId: string;
  /** 该切片允许写入的路径（glob / 目录前缀） */
  writes: string[];
  /** agent 实际工作目录（worktree）绝对路径；null 表示在项目根执行 */
  worktree: string | null;
  /** 主仓库根绝对路径 —— policy / 预约 / 事件流都在这里 */
  projectRoot: string;
  /** 建分支时的基点 commit；审计时把已提交的改动也算进来 */
  baseCommit?: string | null;
  /**
   * zelto 自己写进 worktree 的文件（相对 worktree 的路径）。
   *
   * 这些文件不是 agent 写的：规格副本、验收目录副本、约束包镜像。
   * 审计时它们不能算成「agent 越界写入」；但内容被改动就是篡改
   * —— 改了规格副本等于自动改规格，改了钩子设置等于关掉门禁。
   */
  managedPaths?: string[];
  /**
   * 规格完整性锚（ADR-106 §2）。
   *
   * 规格文件在写集里时，它不再受「托管文件哈希」保护 ——
   * 但它受**「冻结需求仍在」**保护：agent 可以改规格的措辞，
   * 不能删掉/改写验收标准本身。
   *
   * 这里给的是**锚本身**（冻结时提取到的需求文本），
   * 由调用方在 agent 开工前从**冻结版规格**里提取好。
   * 审计时再从 worktree 里被改过的规格重新提取、逐条比对。
   *
   * 不给 → 不做这道校验（没有锚就没有判据）。
   */
  specIntegrity?: SpecIntegrity | null;
  /**
   * 装哪种 harness 的钩子。
   *
   * 默认 `'claude-code'` —— 保持旧行为不变。
   * Cursor 侧必须是 `'cursor'`：它的钩子配置在 `.cursor/hooks.json`，
   * 信封是 `{permission, user_message, agent_message}`，
   * 跟 Claude Code 的 `.claude/settings.local.json` 完全不同。
   */
  harness?: GuardHarness;
}

export interface RuntimeGuard {
  sliceId: string;
  /** 预约本身 */
  reservation: WriteReservation;
  /** 装钩子的根目录（worktree，没有则项目根） */
  hookRoot: string;
  /** hook 的 exec 形式（给 SDK 的 hooks 选项用） */
  exec: { command: string; args: string[] };
  /**
   * zelto 自己写进 worktree 的文件（相对 worktree 的路径）。
   *
   * 这些文件不是 agent 写的（规格副本、约束包、bundle）——
   * 报「做成了什么」时不该把它们算成 agent 的成果。
   */
  managedPaths: string[];
  /**
   * 运行开始时 worktree 就已经脏的路径（D-29 预置脏）。
   *
   * 同样不是 agent 这一轮写的 —— 报进展时要排除。
   */
  baselineChanged: string[];
  /** 运行后的写集审计；没有 worktree 时返回 null（无从审计） */
  audit(): WriteAuditResult | null;
  /** 释放预约并撤掉 zelto 装的那条钩子 */
  release(): Promise<void>;
}

/** 预约文件所在的目录（绝对路径）。 */
export function reservationDir(projectRoot: string): string {
  return resolve(projectRoot, LOCKS_DIR);
}

/** 读取安装钩子之前 `.claude/settings.local.json` 的原始内容。 */
function readOriginalSettings(root: string): string | null {
  const path = join(root, CLAUDE_SETTINGS_RELATIVE);
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** 读取安装钩子之前 `.cursor/hooks.json` 的原始内容。 */
function readOriginalCursorHooks(root: string): string | null {
  const path = join(root, CURSOR_HOOKS_RELATIVE);
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 某个 harness 的钩子配置落在哪个相对路径下。
 *
 * 托管文件清单要覆盖它 —— agent 改了钩子文件就等于**关掉了门禁**，
 * 那是一种越界写入，审计时必须认出来。
 */
function managedHookPath(harness: GuardHarness): string {
  switch (harness) {
    case 'cursor':
      return MANAGED_CURSOR_HOOKS_PATH;
    case 'codex':
      return MANAGED_CODEX_HOOKS_PATH;
    default:
      return MANAGED_SETTINGS_PATH;
  }
}

/**
 * 取写集预约 + 装 PreToolUse 钩子。
 *
 * 钩子装在 agent 真正工作的那个目录里（worktree），因为 Claude Code 只读
 * 当前工作目录下的 `.claude/settings.local.json`；但它读到的预约和策略
 * 都在主仓库 —— 命令行里显式给了 `--project-root`。
 */
export async function installRuntimeGuard(
  options: RuntimeGuardOptions,
): Promise<RuntimeGuard> {
  const projectRoot = resolve(options.projectRoot);
  const hookRoot = options.worktree ? resolve(options.worktree) : projectRoot;

  // D-29 基线快照：worktree 建出来那一刻就已经脏的路径（主仓继承的 -dirty）。
  // 必须在 agent 开工前拍 —— 之后再拍就分不清谁写的了。
  //
  // **在取预约之前拍**（D-61）：快照失败会抛（读不到 ≠ 干净）。
  // 若放在取预约之后，一次抛错就会留下一个**没人释放的预约**
  // → 下一片撞写集冲突 → 整个队列卡住。
  // 先拍快照：拍不到就什么都没开始，不留残局。
  const baselineChanged = options.worktree ? snapshotBaselineChanged(hookRoot) : [];

  const store = new ReservationStore(reservationDir(projectRoot));
  const reservation = await store.acquire(options.sliceId, {
    writes: options.writes,
    worktree: options.worktree,
    projectRoot,
    replace: true,
  });

  // 装钩子之前先留一份原始设置 —— 运行结束时要还原回去
  const harness: GuardHarness = options.harness ?? 'claude-code';
  const originalSettings =
    harness === 'claude-code' ? readOriginalSettings(hookRoot) : readOriginalCursorHooks(hookRoot);

  const hookOptions: ClaudeHookOptions = {
    root: hookRoot,
    projectRoot,
    sliceId: options.sliceId,
    worktree: options.worktree,
  };
  const installed =
    harness === 'cursor'
      ? installCursorHook(hookOptions)
      : harness === 'codex'
        ? installCodexHook(hookOptions)
        : installClaudeCodeHook(hookOptions);
  const exec = buildPreToolHookExec(hookOptions);
  if (harness !== 'claude-code') {
    // 判定内核靠 `--harness` 知道该按哪套信封解输入。
    // Claude Code 是默认（不带 `--harness` 就是 claude-code），
    // Cursor / Codex 必须显式带上 —— 否则 hook 会按 Claude 的格式去读
    // Cursor 的载荷，读不到路径 → 判不出写入目标 → 判定失效。
    exec.args.push('--harness', harness);
  }

  if (!installed.installed) {
    // 钩子没装上 = 运行时拦不住越界写。运行后的审计还在，但过程里没人拦 ——
    // 必须让人看见。
    console.error(`  ⚠️  PreToolUse 钩子安装失败: ${installed.message}`);
    console.error(`     运行期间不会有运行时拦截，只剩运行后的写集审计。`);
  }

  // 托管文件的内容哈希：运行后比对，agent 改了这个文件就是关掉了门禁
  const managed: ManagedFile[] = [];
  for (const rel of options.managedPaths ?? []) {
    const path = rel.replace(/\\/g, '/');
    const hash = hashFile(join(hookRoot, path));
    if (hash) managed.push({ path, hash });
  }
  if (installed.installed) {
    const hash = hashFile(join(hookRoot, managedHookPath(harness)));
    if (hash) managed.push({ path: managedHookPath(harness), hash });
  }

  await events.append(options.sliceId, 'reservation.acquired', 'zelto', {
    sliceId: options.sliceId,
    writes: options.writes,
    worktree: options.worktree,
    projectRoot,
    pid: reservation.pid,
    hookInstalled: installed.installed,
    hookCommand: exec.args.join(' '),
    baselineChanged,
  });

  let released = false;

  return {
    sliceId: options.sliceId,
    reservation,
    hookRoot,
    exec,
    managedPaths: managed.map((m) => m.path),
    baselineChanged,

    audit(): WriteAuditResult | null {
      // 没有 worktree 就没有隔离，也就没有「这次运行改了什么」可查 ——
      // 此时拿主仓库的 git status 去比对写集只会得到一堆假阳性。
      if (!options.worktree) return null;
      return auditWorktreeWrites(hookRoot, options.writes, {
        baseCommit: options.baseCommit ?? null,
        managed,
        baselineChanged,
        // ADR-106 §2：规格在写集里 → 不托管，但「冻结需求仍在」是硬约束。
        specIntegrity: options.specIntegrity ?? null,
        // ADR-067 D3：只把本片自己产出的提交算进审计范围。
        // 分支上别的提交（基点错位带进来的、运行期间被人合进来的）
        // 不是本片 agent 写的，不该算成「本片的越界写入」。
        sliceId: options.sliceId,
      });
    },

    async release(): Promise<void> {
      if (released) return;
      released = true;

      // 撤钩子并还原原始设置
      if (harness === 'cursor') removeCursorHook(hookRoot);
      else if (harness === 'codex') removeCodexHook(hookRoot);
      else removeClaudeCodeHook(hookRoot);

      const settingsPath = join(hookRoot, managedHookPath(harness));
      if (originalSettings !== null) {
        try {
          writeFileSync(settingsPath, originalSettings, 'utf-8');
        } catch {
          // 还原失败不阻断：钩子已经撤掉了
        }
      } else if (existsSync(settingsPath)) {
        // 原本没有这个文件：把 zelto 留下的空壳删掉
        try {
          const raw = readFileSync(settingsPath, 'utf-8');
          const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
          const hooks = parsed.hooks ?? {};
          if (Object.keys(hooks).length === 0) {
            rmSync(settingsPath, { force: true });
          }
        } catch {
          // 解析不了就留着，别乱删
        }
      }

      await store.release(options.sliceId);
      await events.append(options.sliceId, 'reservation.released', 'zelto', {
        sliceId: options.sliceId,
        writes: options.writes,
        worktree: options.worktree,
      });
    },
  };
}

/**
 * 释放一批守卫。
 *
 * 释放失败不阻断 —— 预约文件留在盘上时，下一次 `zelto reservation reap`
 * 会按 pid 判定它是不是僵尸预约并清理掉。
 */
export async function releaseGuards(guards: Map<string, RuntimeGuard>): Promise<void> {
  for (const guard of guards.values()) {
    try {
      await guard.release();
    } catch {
      // 忽略：残留的预约会被 reap 清理
    }
  }
}

/**
 * 把审计结论落成事件。
 *
 * 越界写入与托管文件被篡改都要留痕 —— 事后的追溯靠的就是这条事件。
 */
export async function reportAuditResult(
  sliceId: string,
  result: WriteAuditResult,
): Promise<void> {
  if (result.error) {
    await events.append(sliceId, 'policy.violation', 'zelto', {
      sliceId,
      kind: 'audit-error',
      error: result.error,
    });
    return;
  }

  // D-69：追溯链有断节（有提交没写明归属）。
  //
  // 这些提交的改动**已经纳入审计范围**（按「疑似本片」处理），
  // 所以边界是确定的 —— 这里只留痕，**不拦下**。
  //
  // 拦下的是 `result.error` 那条路（提交历史读不出来 → 边界未知）。
  if (result.coverageGap) {
    await events.append(sliceId, 'policy.violation', 'zelto', {
      sliceId,
      kind: 'audit-coverage-gap',
      error: result.coverageGap,
      changed: result.changed,
    });
    // 不 return —— 还要继续看 violations（可能有真越界）
  }

  if (result.violations.length > 0 || result.tampered.length > 0) {
    await events.append(sliceId, 'policy.violation', 'zelto', {
      sliceId,
      kind: result.tampered.length > 0 ? 'managed-file-tampered' : 'write-outside-write-set',
      violations: result.violations,
      tampered: result.tampered,
      changed: result.changed,
    });
  }
}

/**
 * 写集审计的结论。
 *
 * 返回结论而不是直接打印 —— 打印的措辞按路径不同（单片 / 并行 / 后台），
 * 判定只有这一处。措辞集中在 `run-messages.ts`，三条路径共用。
 */
export interface WriteSetVerdict {
  /** 边界守住了吗 */
  ok: boolean;
  /** 越界写入的文件 */
  violations: string[];
  /** 被篡改的托管文件 */
  tampered: string[];
  /** 审计本身失败（读不到 git 状态之类） */
  error?: string;
}

/**
 * 运行结束后对写集做一次审计，并决定放不放行。
 *
 * 放行 = 可以进 gate②、可以自动生成签字请求。
 * 不放行 = 有人越界了（或审计本身失败），必须由人来看。
 *
 * 没有 worktree 时无从审计（不在 git 仓库里，隔离本身就不存在），
 * 这种情况下不做审计，也不假装审计过。
 */
export async function enforceWriteSet(
  sliceId: string,
  guard: RuntimeGuard | null,
  /**
   * 额外写进 `run.aborted` 事件 payload 的字段（惰性求值）。
   *
   * 为什么要传进来：`handleWriteSetViolation` 在**越界被拦下**的那一刻
   * 写 `run.aborted` 事件 —— 那正是最需要「做成了什么」的时刻
   * （实测 v2-input-binder：agent 越界写了一个文件，其余活儿基本做完了，
   * 事件里却只有 violations，人只能重跑）。
   *
   * 事件流是追溯的唯一载体（ADR-004），所以这个信息不能只留在终端输出。
   *
   * 之所以是**函数**而不是对象：审计结果算完之后才写事件，
   * 而「做成了什么」要在审计之后才采集（采集要跑验收，会动工作区 ——
   * 放在审计前面跑，验收的产物会被算成越界写入）。
   * 惰性求值保证它只在真的要写事件时才跑，且**跑在审计之后**。
   *
   * 回调会收到**审计判定的越界文件** —— 「什么把这一轮废了」
   * 要用审计的结论，不能自己重算一遍（审计处理了托管文件、预置脏、
   * submodule 假脏等一堆细节，重算必然对不上）。
   */
  extraPayload?: (violations: string[]) => Promise<Record<string, unknown> | null>,
): Promise<WriteSetVerdict> {
  const pass: WriteSetVerdict = { ok: true, violations: [], tampered: [] };
  if (!guard) return pass;

  const result = guard.audit();
  // 没有 worktree —— 无从审计，不假装审计过
  if (!result) return pass;

  if (result.error) {
    await reportAuditResult(sliceId, result);
    // 审计失败 = 边界无法确认 —— 这一轮同样不算数。
    // 不退回 frozen 的话切片会卡在 running（run/merge/resume 全堵死），
    // 人只能 abandon —— 那等于「审计读不到 git 状态就把切片废了」，不合理。
    await handleWriteSetViolation(sliceId, {
      violations: [],
      tampered: [],
      reason: 'write-set audit failed',
      ...(await resolveExtraPayload(extraPayload, [])),
    });
    return { ok: false, violations: [], tampered: [], error: result.error };
  }

  // D-69：追溯链有断节（有提交没写明归属）—— **不拦下**。
  //
  // 这些提交的改动已经按「疑似本片」纳入审计范围，边界是确定的；
  // 拦下来只会把一次成功的运行误判成越界。
  // 真正需要 fail closed 的是上一条（`result.error`：提交历史读不出来）。
  //
  // 留痕在 reportAuditResult 里已经做了。

  if (result.violations.length === 0 && result.tampered.length === 0) return pass;

  await reportAuditResult(sliceId, result);

  // 退回 frozen，让切片可以重跑 —— 否则它会永远卡在 running（见
  // `handleWriteSetViolation` 的注释）。人扩完写集就能直接重跑。
  await handleWriteSetViolation(sliceId, {
    violations: result.violations,
    tampered: result.tampered,
    ...(await resolveExtraPayload(extraPayload, result.violations)),
  });

  return {
    ok: false,
    violations: result.violations,
    tampered: result.tampered,
  };
}

/**
 * 求值额外的事件 payload。
 *
 * 求值失败**不阻断**：附加信息是补充，不是判据 ——
 * 采集不到就少写一个字段，不能因此让整条审计路径失败。
 */
async function resolveExtraPayload(
  fn: ((violations: string[]) => Promise<Record<string, unknown> | null>) | undefined,
  violations: string[],
): Promise<Record<string, unknown>> {
  if (!fn) return {};
  try {
    return (await fn(violations)) ?? {};
  } catch {
    return {};
  }
}
