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
import { join, resolve } from 'node:path';
import {
  type ManagedFile,
  type WriteAuditResult,
  type WriteReservation,
  ReservationStore,
  auditWorktreeWrites,
  hashFile,
  LOCKS_DIR,
} from '../../core/sched/index.js';
import { events } from './shared.js';
import { handleWriteSetViolation } from './run-support.js';
import {
  CLAUDE_SETTINGS_RELATIVE,
  type ClaudeHookOptions,
  buildPreToolHookExec,
  installClaudeCodeHook,
  removeClaudeCodeHook,
} from './hook-install.js';

/** zelto 装进 worktree 的 Claude Code 设置文件（相对 worktree 的路径） */
export const MANAGED_SETTINGS_PATH = CLAUDE_SETTINGS_RELATIVE.replace(/\\/g, '/');

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
}

export interface RuntimeGuard {
  sliceId: string;
  /** 预约本身 */
  reservation: WriteReservation;
  /** 装钩子的根目录（worktree，没有则项目根） */
  hookRoot: string;
  /** hook 的 exec 形式（给 SDK 的 hooks 选项用） */
  exec: { command: string; args: string[] };
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

  const store = new ReservationStore(reservationDir(projectRoot));
  const reservation = await store.acquire(options.sliceId, {
    writes: options.writes,
    worktree: options.worktree,
    projectRoot,
    replace: true,
  });

  // 装钩子之前先留一份原始设置 —— 运行结束时要还原回去
  const originalSettings = readOriginalSettings(hookRoot);

  const hookOptions: ClaudeHookOptions = {
    root: hookRoot,
    projectRoot,
    sliceId: options.sliceId,
    worktree: options.worktree,
  };
  const installed = installClaudeCodeHook(hookOptions);
  const exec = buildPreToolHookExec(hookOptions);

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
    const hash = hashFile(join(hookRoot, MANAGED_SETTINGS_PATH));
    if (hash) managed.push({ path: MANAGED_SETTINGS_PATH, hash });
  }

  await events.append(options.sliceId, 'reservation.acquired', 'zelto', {
    sliceId: options.sliceId,
    writes: options.writes,
    worktree: options.worktree,
    projectRoot,
    pid: reservation.pid,
    hookInstalled: installed.installed,
    hookCommand: exec.args.join(' '),
  });

  let released = false;

  return {
    sliceId: options.sliceId,
    reservation,
    hookRoot,
    exec,

    audit(): WriteAuditResult | null {
      // 没有 worktree 就没有隔离，也就没有「这次运行改了什么」可查 ——
      // 此时拿主仓库的 git status 去比对写集只会得到一堆假阳性。
      if (!options.worktree) return null;
      return auditWorktreeWrites(hookRoot, options.writes, {
        baseCommit: options.baseCommit ?? null,
        managed,
      });
    },

    async release(): Promise<void> {
      if (released) return;
      released = true;

      // 撤钩子并还原原始设置
      removeClaudeCodeHook(hookRoot);
      const settingsPath = join(hookRoot, CLAUDE_SETTINGS_RELATIVE);
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
): Promise<boolean> {
  if (!guard) return true;

  const result = guard.audit();
  // 没有 worktree —— 无从审计，不假装审计过
  if (!result) return true;

  if (result.error) {
    await reportAuditResult(sliceId, result);
    console.error(`\n⚠️  写集审计失败，无法确认边界: ${result.error}`);
    return false;
  }

  if (result.violations.length === 0 && result.tampered.length === 0) return true;

  await reportAuditResult(sliceId, result);
  console.error(`\n❌ 写集越界（${sliceId}）—— 不进 gate，需要人来处理:`);
  for (const p of result.violations) {
    console.error(`   - ${p}（不在写集内）`);
  }
  for (const p of result.tampered) {
    console.error(`   - ${p}（zelto 托管的文件被改动了 —— 门禁可能已被绕过）`);
  }
  console.error(`   事件流：.zelto/events/${sliceId}/events.jsonl`);

  // 退回 frozen，让切片可以重跑 —— 否则它会永远卡在 running（见
  // `handleWriteSetViolation` 的注释）。人扩完写集就能直接重跑。
  await handleWriteSetViolation(sliceId, {
    violations: result.violations,
    tampered: result.tampered,
  });
  console.error(`   切片已退回 frozen：扩写集后重跑 zelto run ${sliceId}`);

  return false;
}
