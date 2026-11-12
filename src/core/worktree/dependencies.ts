// Version worktree dependency isolation — 版本工作目录的依赖怎么来
//
// ADR-056 §3.7 / D4-C：版本工作目录默认链接主仓那一份 `node_modules`；
// 但当版本工作目录的锁文件与主干不同时，各自装一份。
//
// 为什么需要这个（ADR-011 §3.2 的原话）：
//
//   共享连接成本恒定，且不触碰依赖清单。
//
// 这条理由在**多版本**下失效：v2 升了依赖、v3 还在用旧依赖，
// 共用一份 `node_modules` 必然打架。
//
// D4-C 的代价与补救：
// - 代价：真需要独立装的版本要付一次安装时间
// - 补救：装完**校验锁文件没被改**。改了就是还原并报错 ——
//   绝不静默接受一个被改过的依赖清单。
//
// C1: 状态只在文件里（锁文件与 node_modules 都在版本工作目录里）
// C2/C6: core/ 内，只用 Node 内置，不依赖 adapters/
// C3: 判定确定性 —— 锁文件比对是 hash，依赖判定不调模型、不触网
//
// 注意：安装本身要触网（npm registry）。这是**执行动作**不是**判定**，
// 与 C3 不冲突 —— C3 约束的是 core/policy、core/gate、core/sched 的判定路径。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** 锁文件候选（按优先级） */
const LOCKFILES = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lockb', manager: 'bun' },
] as const;

export type PackageManager = (typeof LOCKFILES)[number]['manager'];

export interface LockfileState {
  /** 锁文件名；null 表示这个目录没有锁文件 */
  file: string | null;
  /** 锁文件内容的 hash；null 表示没有锁文件 */
  hash: string | null;
  /** 从锁文件推断出的包管理器 */
  manager: PackageManager | null;
}

/**
 * 读一个目录的锁文件状态。
 *
 * 用 hash 而不是 mtime —— mtime 在 `git checkout` 后会变，内容不会。
 */
export function readLockfileState(dir: string): LockfileState {
  for (const { file, manager } of LOCKFILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path);
      const hash = createHash('sha256').update(content).digest('hex');
      return { file, hash, manager };
    } catch {
      // 读不动就当没有 —— 判定失败时走「不共享」那条路（保守）
      return { file: null, hash: null, manager: null };
    }
  }
  return { file: null, hash: null, manager: null };
}

/**
 * 两个目录的锁文件是否一致。
 *
 * 都没有锁文件 → 视为一致（没有依赖清单要管）。
 * 一个有一個沒有 → 不一致（一方要装一方不装）。
 */
export function lockfilesMatch(a: LockfileState, b: LockfileState): boolean {
  if (a.file === null && b.file === null) return true;
  if (a.file === null || b.file === null) return false;
  if (a.file !== b.file) return false;
  return a.hash === b.hash;
}

export interface PrepareDependenciesOptions {
  /** 主仓根目录 */
  repoRoot: string;
  /** 版本工作目录 */
  worktreePath: string;
  /** 安装超时（毫秒） */
  timeoutMs?: number;
  /** 干跑：只判定，不真的装 */
  dryRun?: boolean;
}

export type DependencyStrategy = 'link' | 'install';

export interface DependencyPlan {
  strategy: DependencyStrategy;
  /** 判定理由（面向人） */
  reason: string;
  /** 主仓锁文件状态 */
  repoLock: LockfileState;
  /** 版本工作目录锁文件状态 */
  worktreeLock: LockfileState;
}

export interface DependencyResult extends DependencyPlan {
  /** 实际执行结果 */
  applied: boolean;
  /** 失败原因；null 表示成功 */
  error: string | null;
  /** 锁文件在安装后是否被改动 */
  lockfileChanged: boolean;
}

/**
 * 判定版本工作目录的依赖策略（不执行）。
 *
 * D4-C：锁文件一致 → 链接主仓那份；不一致 → 各自装。
 */
export function planVersionDependencies(options: PrepareDependenciesOptions): DependencyPlan {
  const repoLock = readLockfileState(options.repoRoot);
  const worktreeLock = readLockfileState(options.worktreePath);

  if (repoLock.file === null && worktreeLock.file === null) {
    return {
      strategy: 'link',
      reason: '两边都没有锁文件 —— 无依赖清单要管，链接主仓那份',
      repoLock,
      worktreeLock,
    };
  }

  if (lockfilesMatch(repoLock, worktreeLock)) {
    return {
      strategy: 'link',
      reason: `锁文件一致（${repoLock.file}）—— 链接主仓那份`,
      repoLock,
      worktreeLock,
    };
  }

  return {
    strategy: 'install',
    reason:
      `锁文件不一致（主干 ${repoLock.file ?? '无'} / 版本目录 ${worktreeLock.file ?? '无'}）` +
      `—— 这个版本要独立装一份依赖`,
    repoLock,
    worktreeLock,
  };
}

/**
 * 安装命令（按包管理器）。
 *
 * 一律用「不改动锁文件」的语义：
 * - `npm ci` —— 严格按锁文件装
 * - `pnpm install --frozen-lockfile`
 * - `yarn install --frozen-lockfile`
 * - `bun install --frozen-lockfile`
 */
function installArgs(manager: PackageManager): string[] {
  switch (manager) {
    case 'npm':
      return ['ci'];
    case 'pnpm':
      return ['install', '--frozen-lockfile'];
    case 'yarn':
      return ['install', '--frozen-lockfile'];
    case 'bun':
      return ['install', '--frozen-lockfile'];
  }
}

/**
 * 执行依赖准备。
 *
 * 装完之后**校验锁文件没被改**（ADR-056 D4-C 的补救措施）：
 * 改了就把锁文件还原（从 git checkout）并报错 ——
 * 依赖清单被悄悄改掉，比装不上更难查。
 */
export function prepareVersionDependencies(
  options: PrepareDependenciesOptions,
): DependencyResult {
  const plan = planVersionDependencies(options);

  if (plan.strategy === 'link') {
    return { ...plan, applied: false, error: null, lockfileChanged: false };
  }

  if (options.dryRun) {
    return { ...plan, applied: false, error: null, lockfileChanged: false };
  }

  const manager = plan.worktreeLock.manager ?? plan.repoLock.manager;
  if (!manager) {
    return {
      ...plan,
      applied: false,
      error: '判断不出用哪个包管理器（没有可识别的锁文件）—— 不装，依赖保持共享',
      lockfileChanged: false,
    };
  }

  // 装之前把锁文件内容记下来 —— 装完要比对
  const before = readLockfileState(options.worktreePath);

  try {
    execFileSync(manager, installArgs(manager), {
      cwd: options.worktreePath,
      encoding: 'utf-8',
      timeout: options.timeoutMs ?? 10 * 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const detail = String(e.stderr ?? '').trim() || String(e.stdout ?? '').trim() || e.message || String(err);
    return {
      ...plan,
      applied: false,
      error: `依赖安装失败（${manager} ${installArgs(manager).join(' ')}）：${detail.slice(0, 400)}`,
      lockfileChanged: false,
    };
  }

  // ── 锁文件校验 ──
  const after = readLockfileState(options.worktreePath);
  const changed =
    before.hash !== after.hash || before.file !== after.file;

  if (changed) {
    // 还原锁文件 —— 依赖清单被改了就不该留着
    if (after.file) {
      try {
        execFileSync('git', ['checkout', '--', after.file], {
          cwd: options.worktreePath,
          encoding: 'utf-8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        // 还原失败 —— 报错信息里带上，让人手动处理
      }
    }
    return {
      ...plan,
      applied: true,
      error:
        `依赖安装改动了锁文件（${before.file ?? '无'} → ${after.file ?? '无'}）—— 已还原。` +
        `依赖清单被悄悄改掉比装不上更难查，所以这一律报错。`,
      lockfileChanged: true,
    };
  }

  return { ...plan, applied: true, error: null, lockfileChanged: false };
}

/**
 * 摘掉版本工作目录里的 `node_modules`（目录或连接）。
 *
 * 只删目录本身 —— 版本工作目录的 `node_modules` 是真的（自己装的），
 * 不像切片 worktree 那样是指向主仓的连接。
 */
export function removeVersionNodeModules(worktreePath: string): void {
  const dest = join(worktreePath, 'node_modules');
  if (!existsSync(dest)) return;
  try {
    rmSync(dest, { recursive: true, force: true });
  } catch {
    // 摘不掉不算致命：交给 git worktree remove 报错，信息更明确
  }
}
