// Worktree manager — 每个切片一个独立 git worktree
//
// C1: 元数据由 git 自身（.git/worktrees/）承担，不引入数据库
// C2/C6: 只用 Node 内置模块，不依赖 adapters/
// C3: 全部为本地确定性操作，不调模型、不触网

import { execFileSync } from 'node:child_process';
import { existsSync, cpSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs';
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
  /**
   * 是否把 git submodule 一并初始化到 worktree 里（默认 true）。
   *
   * 依赖 submodule 的工程（vendor 目录是 gitlink 而不是签入的源码树）
   * 在没有这一步时，worktree 里那些目录是**空的** —— 于是配置阶段就报
   * 「找不到 googletest」，agent 花几十分钟去排查一个本该一开始就有的东西。
   * 关掉它只为了「只读审阅」这类不编译的场景。
   */
  initSubmodules?: boolean;
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
      // 复用已有 worktree：submodule 可能还没初始化过（上一轮跑挂了、
      // 或 worktree 是早于 ADR-044 创建的），补一次同步。
      if (options.initSubmodules !== false) {
        this.syncSubmodules(target);
      }
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
 * 把 submodule 初始化进 worktree。
 *
 * 为什么必须有这一步（ADR-044）：`git worktree add` **不会**把 submodule
 * 的内容带过去 —— 那些目录在 worktree 里是空的（gitlink 只记录一个
 * commit 指针，源码树住在 submodule 自己的仓库里）。
 *
 * 后果不是「少个依赖」，而是**门禁必然失败**：配置阶段就报
 * 「找不到 googletest」，而且报错信息指向源码缺失，跟「隔离目录没同步
 * vendor」毫无关系。nimrtc-zelto 的 `v1-exception-handling` 切片上，
 * agent 为此从主仓手工拷了一份 googletest/msquic 进去，白白花掉几十分钟，
 * 还把 vendor 目录改成了「非 submodule 的普通目录」。
 *
 * 只初始化**主仓已经初始化过的** submodule：本地已有的 objects 复用，
 * 不触网。缺的那个跳过（不是每个工程都需要 vendor 全套）。
 */
  syncSubmodules(worktreePath: string): { initialized: string[]; skipped: string[] } {
    const initialized: string[] = [];
    const skipped: string[] = [];

    let submodules: Array<{ name: string; path: string }> = [];
    try {
      const raw = this.git(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], undefined, true);
      submodules = raw
        .split('\n')
        .map((line) => {
          const idx = line.indexOf(' ');
          if (idx === -1) return null;
          // key 形如 `submodule.<name>.path`，name 与 path **不一定相同**
          // （.gitmodules 里的 section 名是 name，path 是它实际落盘的位置）。
          const key = line.slice(0, idx).trim();
          const name = key.replace(/^submodule\./, '').replace(/\.path$/, '');
          const path = line.slice(idx + 1).trim();
          return name && path ? { name, path } : null;
        })
        .filter((s): s is { name: string; path: string } => s !== null);
    } catch {
      // 没有 .gitmodules 或读不出来 → 没有 submodule 要同步
      return { initialized, skipped };
    }

    for (const sub of submodules) {
      // 主仓里这个 submodule 有三种形态：
      //   a) `.git` 是**文件**（指向 module git 目录）→ 正常初始化的 submodule
      //   b) `.git` 是**目录**（独立嵌套克隆）→ 有些工程这么做
      //   c) **没有** `.git`，但有内容（源码被当普通文件提交）
      // 三种都要处理，否则 worktree 里那个目录是空的。
      const mainSubPath = join(this.repoRoot, sub.path);
      const gitLink = join(mainSubPath, '.git');
      const hasGitLink = existsSync(gitLink);
      const hasContent = this.hasDirectoryContent(mainSubPath);

      if (!hasGitLink) {
        if (hasContent) {
          // c) 主仓里已经有源码 → 直接复制过去（离线、且保留内容一致）
          this.copyDirectory(mainSubPath, join(worktreePath, sub.path));
          initialized.push(sub.path);
        } else {
          // 主仓里既没有 .git 也没有内容 → 没本地 objects，跳过（不触网拉）
          skipped.push(sub.path);
        }
        continue;
      }

      // submodule 自己的 git 目录。按优先级找三处：
      //   1. `<主仓>/<path>/.git` 是**目录** → 独立嵌套克隆，就用它自己
      //   2. `<主仓>/.git/modules/<name>/` → git 的标准布局（按 name）
      //   3. `<主仓>/.git/modules/<path>/` → 兜底（历史上有工具按 path 放）
      //
      // 1 和 2/3 是**互斥**的两种布局：`.git` 指向 module git 目录时，
      // module git 目录就在 `.git/modules/` 下；`.git` 本身就是目录时，
      // `.git/modules/` 下**没有**对应目录。
      const nestedGitDir = this.isDirectory(gitLink) ? gitLink : null;
      const moduleGitDir = nestedGitDir ?? [
        join(this.repoRoot, '.git', 'modules', ...sub.name.split('/')),
        join(this.repoRoot, '.git', 'modules', ...sub.path.split('/')),
      ].find((dir) => existsSync(dir));
      if (!moduleGitDir) {
        skipped.push(sub.path);
        continue;
      }

      try {
        this.git(
          [
            '-c', 'protocol.file.allow=always',
            // 把克隆源指向主仓里已存在的 module git 目录：
            //   - 不触网（用的是本地 objects）
            //   - 不受 `protocol.file.allow` 限制（本地路径克隆默认被禁）
            // 注意配置键用的是 submodule 的 **name**（.gitmodules 的 section 名），
            // 不是 path —— 两者相同时看不出差别，不同时就改错了 submodule。
            '-c', `submodule.${sub.name}.url=${moduleGitDir}`,
            'submodule', 'update', '--init', '--recursive', sub.path,
          ],
          undefined,
          false,
          worktreePath,
        );
        initialized.push(sub.path);
      } catch {
        skipped.push(sub.path);
      }
    }

    return { initialized, skipped };
  }

  /**
   * 把 submodule 检出到**主仓记录的指针**上，而不是共享 module git 目录的 HEAD。
   *
   * 为什么必须显式检出（ADR-047）：
   *
   * `git submodule update --init` 的语义是「检出到 **index 里记录的** commit」
   * —— 这本身是对的。但当克隆源是共享的 module git 目录时，
   * `git clone <该目录>` 会把**该目录当前的 HEAD** 克隆成新仓库的 HEAD，
   * 而 `submodule update` 之后再 checkout 到记录的 commit。
   *
   * 问题在于：主仓的 module git 目录的 HEAD **不一定**等于主仓工作区里
   * 那个 submodule 的 HEAD。nimrtc-zelto 上就是这种情况：
   *
   *   - 主仓 index 记录：`22244de5`（v1.6.1）
   *   - 主仓工作区 submodule：`22244de5`（一致）
   *   - 共享 module git 目录 HEAD：`a8b2545e`（heads/main）—— 不一致
   *
   * 于是 worktree 里检出的 submodule 与主仓工作区里的**不是同一个 commit**，
   * `git status` 报 `M src/third_party/libopus/src` —— 审计把它当成
   * 「agent 越界改了 vendor」。
   *
   * 而 agent 根本没碰它 —— 它是 zelto 自己同步 submodule 时引入的差异。
   * 这个差异会让门禁判定「写集越界」，把一片本来合格的切片挡下来。
   *
   * 所以：同步完 submodule 之后，显式把每个 submodule 检出到
   * **主仓工作区里那个 submodule 当前的 HEAD**（与主仓 index 一致的那个）。
   */
  alignSubmodulesToMainRepo(worktreePath: string): string[] {
    const aligned: string[] = [];

    let submodules: Array<{ name: string; path: string }> = [];
    try {
      const raw = this.git(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], undefined, true);
      submodules = raw
        .split('\n')
        .map((line) => {
          const idx = line.indexOf(' ');
          if (idx === -1) return null;
          const key = line.slice(0, idx).trim();
          const name = key.replace(/^submodule\./, '').replace(/\.path$/, '');
          const path = line.slice(idx + 1).trim();
          return name && path ? { name, path } : null;
        })
        .filter((s): s is { name: string; path: string } => s !== null);
    } catch {
      return aligned;
    }

    for (const sub of submodules) {
      const mainSub = join(this.repoRoot, sub.path);
      const wtSub = join(worktreePath, sub.path);
      // 主仓工作区里这个 submodule 不是 git 仓库（源码当普通文件提交）→ 无从对齐
      if (!existsSync(join(mainSub, '.git'))) continue;
      if (!existsSync(wtSub)) continue;

      // 目标 commit：**worktree 自己的 index** 里记录的 gitlink。
      // worktree 是从主仓同一个 commit 建出来的，所以它 index 里记的
      // 就是主仓要的那一个 —— 这比「主仓工作区当前在哪个 commit」更准
      // （主仓工作区可能被人工切过）。
      let target: string | null = null;
      try {
        const recorded = this.git(['ls-files', '-s', '--', sub.path], undefined, true, worktreePath).trim();
        const match = recorded.match(/^160000 ([0-9a-f]{40})/);
        if (match) target = match[1];
      } catch {
        target = null;
      }
      if (!target) continue;

      // worktree 里那个 submodule 当前实际在哪个 commit
      const wtHead = this.submoduleHead(wtSub);
      if (wtHead === target) continue;

      try {
        this.git(['checkout', '--force', target], undefined, false, wtSub);
        aligned.push(sub.path);
      } catch {
        // 对不齐就留着 —— git status 会显示差异，审计会报出来（不静默）
      }
    }

    return aligned;
  }

  /**
   * 求一个 submodule 工作区当前实际检出的 commit。
   *
   * `git rev-parse HEAD` 在 submodule 里会顺着 `.git` 文件指到
   * **共享的** module git 目录 —— 那里的 HEAD 未必是这个工作区检出的
   * commit（共享目录被别的操作改过就会漂）。
   *
   * 独立嵌套克隆（`.git` 是目录）没有这个问题，直接问它自己。
   */
  private submoduleHead(subPath: string): string | null {
    try {
      return this.git(['rev-parse', 'HEAD'], undefined, true, subPath).trim() || null;
    } catch {
      return null;
    }
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
   * - submodule（vendor 源码树；`git worktree add` 不会带过来）
   * - 规格文件（复制，覆盖可能未提交的版本）
   * - 验收测试目录（复制）
   * - node_modules（平台连接，共享主仓库依赖）
   */
  syncContext(info: WorktreeInfo, options: CreateWorktreeOptions): void {
    if (options.initSubmodules !== false) {
      this.syncSubmodules(info.path);
      // 检出到主仓记录的指针（ADR-047）—— 否则 worktree 里的 submodule
      // 与主仓工作区里的不是同一个 commit，`git status` 报 vendor 被改，
      // 审计把它算成「agent 越界写入」。
      this.alignSubmodulesToMainRepo(info.path);
    }
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

  /** 目录里有没有实际内容（排除只有 `.git` 的空 submodule 目录）。 */
  private hasDirectoryContent(dir: string): boolean {
    try {
      return readdirSync(dir).some((name) => name !== '.git');
    } catch {
      return false;
    }
  }

  /** 路径是不是一个目录。 */
  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  /** 复制一个目录的内容（目标已存在就跳过已存在的部分）。 */
  private copyDirectory(source: string, dest: string): void {
    if (!existsSync(source)) return;
    try {
      mkdirSync(dest, { recursive: true });
      cpSync(source, dest, { recursive: true, force: true, errorOnExist: false });
    } catch {
      // 复制失败不阻断 —— 门禁会因缺依赖报错，信息更明确
    }
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
