// Worktree manager — 每个切片一个独立 git worktree
//
// C1: 元数据由 git 自身（.git/worktrees/）承担，不引入数据库
// C2/C6: 只用 Node 内置模块，不依赖 adapters/
// C3: 全部为本地确定性操作，不调模型、不触网

import { execFileSync } from 'node:child_process';
import { existsSync, cpSync, mkdirSync, rmSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

/** worktree 根目录（相对仓库根） */
export const WORKTREE_BASE_DIR = join('.zelto', 'worktrees');

export interface WorktreeInfo {
  /** 切片 id */
  sliceId: string;
  /** worktree 绝对路径 */
  path: string;
  /** 相对仓库根的路径 */
  relativePath: string;
  /** 分支名 */
  branch: string;
  /** 建分支时的基点 commit */
  baseCommit: string | null;
}

export interface CreateWorktreeOptions {
  /** 分支名，默认 `slice/<sliceId>` */
  branch?: string;
  /** 基点 commit，默认当前 HEAD */
  baseCommit?: string | null;
  /** 需要同步进 worktree 的规格文件路径（相对仓库根） */
  specPath?: string | null;
  /** 需要同步进 worktree 的验收测试目录（相对仓库根） */
  acceptanceDir?: string | null;
}

export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly command?: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/**
 * 管理 git worktree 的创建、查询与移除。
 * 所有路径约定：`<repoRoot>/.zelto/worktrees/<sliceId>`，分支 `slice/<sliceId>`。
 */
export class WorktreeManager {
  private readonly repoRoot: string;

  constructor(repoRoot: string = process.cwd()) {
    this.repoRoot = repoRoot;
  }

  /** worktree 的绝对路径（不要求已存在） */
  pathFor(sliceId: string): string {
    return join(this.repoRoot, WORKTREE_BASE_DIR, sliceId);
  }

  /** worktree 的相对仓库根路径 */
  relativePathFor(sliceId: string): string {
    return join(WORKTREE_BASE_DIR, sliceId);
  }

  /** 分支名 */
  branchFor(sliceId: string): string {
    return `slice/${sliceId}`;
  }

  /** 该切片是否已有 worktree 目录 */
  exists(sliceId: string): boolean {
    return existsSync(this.pathFor(sliceId));
  }

  /**
   * 仓库根是否在 git 版本控制之下。
   *
   * 不在 git 仓库里时无法创建 worktree —— 调用方据此降级为「在当前目录执行」，
   * 而不是让整条命令失败。
   */
  isGitRepo(): boolean {
    try {
      const out = this.git(['rev-parse', '--is-inside-work-tree'], undefined, true).trim();
      return out === 'true';
    } catch {
      return false;
    }
  }

  /**
   * 创建（或复用）某个切片的 worktree。
   * 已存在时直接返回现有信息，不重复创建。
   */
  async create(sliceId: string, options: CreateWorktreeOptions = {}): Promise<WorktreeInfo> {
    const branch = options.branch ?? this.branchFor(sliceId);
    const target = this.pathFor(sliceId);

    if (existsSync(target)) {
      return {
        sliceId,
        path: target,
        relativePath: this.relativePathFor(sliceId),
        branch,
        baseCommit: this.currentCommit(target),
      };
    }

    const baseCommit = options.baseCommit ?? this.headCommit();

    mkdirSync(join(this.repoRoot, WORKTREE_BASE_DIR), { recursive: true });

    const branchExists = this.branchExists(branch);
    const args = branchExists
      ? ['worktree', 'add', target, branch]
      : ['worktree', 'add', '-b', branch, target, baseCommit];

    this.git(args, '创建 worktree 失败');

    const info: WorktreeInfo = {
      sliceId,
      path: target,
      relativePath: this.relativePathFor(sliceId),
      branch,
      baseCommit,
    };

    this.syncContext(info, options);
    return info;
  }

  /**
   * 列出仓库中所有 worktree。
   *
   * 注意：不能依赖 `path.relative(repoRoot, worktreePath)` 做匹配——Windows 上
   * `os.tmpdir()` 等路径可能返回 8.3 短名（如 `ADMINI~1`），而 git 始终报告长名，
   * 二者 `relative` 之后不再具有前缀关系。这里改为按路径中的 `.zelto/worktrees/`
   * 标记定位，git 的 `worktree list` 本就只列出当前仓库的 worktree。
   */
  async list(): Promise<WorktreeInfo[]> {
    let output = '';
    try {
      output = this.git(['worktree', 'list', '--porcelain'], undefined, true);
    } catch {
      return [];
    }

    const results: WorktreeInfo[] = [];
    let current: { path: string; branch: string; head: string } | null = null;

    const marker = `/${WORKTREE_BASE_DIR.replace(/\\/g, '/')}/`;

    const flush = () => {
      if (!current) return;
      const normalized = current.path.replace(/\\/g, '/');
      const idx = normalized.lastIndexOf(marker);
      if (idx !== -1) {
        const sliceId = normalized.slice(idx + marker.length);
        if (sliceId) {
          results.push({
            sliceId,
            path: current.path,
            relativePath: join(WORKTREE_BASE_DIR, sliceId),
            branch: current.branch.replace('refs/heads/', ''),
            baseCommit: current.head,
          });
        }
      }
      current = null;
    };

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        current = { path: line.slice('worktree '.length).trim(), branch: '', head: '' };
      } else if (line.startsWith('HEAD ') && current) {
        current.head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ') && current) {
        current.branch = line.slice('branch '.length).trim();
      }
    }
    flush();

    return results;
  }

  /**
   * 移除 worktree。失败时抛出 WorktreeError，不静默吞掉。
   *
   * `node_modules` 是指向主仓库的连接（junction/符号链接），会让 Windows 的路径
   * 超出 MAX_PATH，导致 `git worktree remove` 报 "Filename too long"。
   * 因此移除前先摘掉这个连接。
   */
  async remove(sliceId: string, options: { force?: boolean } = {}): Promise<void> {
    const target = this.pathFor(sliceId);
    if (!existsSync(target)) {
      // 目录已不在，但仍需清理 git 侧的登记
      this.git(['worktree', 'prune'], '清理 worktree 登记失败');
      return;
    }

    // 先摘掉 node_modules 连接 —— 否则 Windows 上路径过长，git 删不掉目录
    this.unlinkNodeModules(target);

    const args = ['worktree', 'remove'];
    if (options.force) args.push('--force');
    args.push(target);

    this.git(args, `移除 worktree 失败: ${relative(this.repoRoot, target)}`);
    this.git(['worktree', 'prune'], '清理 worktree 登记失败');
  }

  // ─── 上下文同步 ──────────────────────────────────────────────────────────

  /**
   * 把执行所需的上下文同步进 worktree：
   * - 规格文件（复制，覆盖可能未提交的版本）
   * - 验收测试目录（复制）
   * - node_modules（平台连接，共享主仓库依赖）
   */
  syncContext(info: WorktreeInfo, options: CreateWorktreeOptions): void {
    if (options.specPath) {
      this.copyIntoWorktree(info.path, options.specPath, true);
    }
    if (options.acceptanceDir) {
      this.copyIntoWorktree(info.path, options.acceptanceDir, true);
    }
    this.linkNodeModules(info.path);
  }

  private copyIntoWorktree(worktreePath: string, relativePath: string, overwrite: boolean): void {
    const source = join(this.repoRoot, relativePath);
    if (!existsSync(source)) return;

    const dest = join(worktreePath, relativePath);
    if (existsSync(dest)) {
      if (!overwrite) return;
      rmSync(dest, { recursive: true, force: true });
    }
    mkdirSync(join(dest, '..'), { recursive: true });
    cpSync(source, dest, { recursive: true });
  }

  private linkNodeModules(worktreePath: string): void {
    const source = join(this.repoRoot, 'node_modules');
    const dest = join(worktreePath, 'node_modules');
    if (!existsSync(source)) return;
    if (existsSync(dest)) return;

    mkdirSync(worktreePath, { recursive: true });
    // Windows 用 junction（不需要管理员权限），POSIX 用目录符号链接
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      symlinkSync(isAbsolute(source) ? source : source, dest, type);
    } catch {
      // 共享失败不阻断：门禁会因缺依赖报错，信息更明确
    }
  }

  /**
   * 摘掉 worktree 里的 node_modules 连接。
   *
   * 只删连接本身，不递归删除其指向的内容——junction 用 `rmdir` 删除，
   * 符号链接用 `unlink` 删除，两者都不会触碰主仓库的 node_modules。
   */
  private unlinkNodeModules(worktreePath: string): void {
    const dest = join(worktreePath, 'node_modules');
    if (!existsSync(dest)) return;

    try {
      if (process.platform === 'win32') {
        // junction 是目录重解析点，用 rmdir（不递归）删除
        rmSync(dest, { recursive: false, force: true });
      } else {
        // POSIX 符号链接用 unlink
        unlinkSync(dest);
      }
    } catch {
      // 摘不掉不算致命：交给 git worktree remove 报错，信息更明确
    }
  }

  // ─── git 辅助 ────────────────────────────────────────────────────────────

  private headCommit(): string {
    return this.git(['rev-parse', 'HEAD'], '读取 HEAD 失败').trim();
  }

  private currentCommit(cwd: string): string | null {
    try {
      return this.git(['rev-parse', 'HEAD'], undefined, true, cwd).trim();
    } catch {
      return null;
    }
  }

  private branchExists(branch: string): boolean {
    try {
      this.git(['rev-parse', '--verify', `refs/heads/${branch}`], undefined, true);
      return true;
    } catch {
      return false;
    }
  }

  private git(args: string[], errorMessage?: string, soft = false, cwd?: string): string {
    try {
      return execFileSync('git', args, {
        cwd: cwd ?? this.repoRoot,
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (soft) throw err;
      const stderr = (err as { stderr?: Buffer | string }).stderr;
      const detail = stderr ? String(stderr).trim() : (err instanceof Error ? err.message : String(err));
      throw new WorktreeError(`${errorMessage ?? 'git 命令失败'}: ${detail}`, args.join(' '), detail);
    }
  }
}

/** 判断路径是否已存在且是目录 */
export function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
