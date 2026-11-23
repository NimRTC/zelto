// Worktree manager — 每个切片一个独立 git worktree
//
// C1: 元数据由 git 自身（.git/worktrees/）承担，不引入数据库
// C2/C6: 只用 Node 内置模块，不依赖 adapters/
// C3: 全部为本地确定性操作，不调模型、不触网

import { execFileSync } from 'node:child_process';
import { existsSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs';
import { join, relative, isAbsolute, dirname, resolve } from 'node:path';
import { resolveWithin } from '../io/path-safe.js';

/** worktree 根目录（相对仓库根） */
export const WORKTREE_BASE_DIR = join('.zelto', 'worktrees');

/**
 * 版本工作目录 base（相对仓库根）。
 *
 * 刻意与 `WORKTREE_BASE_DIR` 分开（ADR-056 §3.1）：`list()` 按路径里的
 * `.zelto/worktrees/` 标记反解 sliceId，版本目录混进去会被误认成切片
 * worktree，进而被切片清理逻辑误删。另起一个 base 就不用改那个解析。
 */
export const VERSION_WORKTREE_BASE_DIR = join('.zelto', 'version-worktrees');

/**
 * submodule 同步的单次超时（毫秒）。
 *
 * 15 秒的来历（实测于 nimrtc v1.4，2026-11-20）：
 * 本地克隆源同步 14 个 submodule 共约 **1 秒**；而 Web 驾驶舱只给
 * `zelto run --detach` **30 秒**（`adapters/web/throttle.ts`）。
 * 15 秒给慢盘留了足够余量，同时保证「本地缺 commit」这种异常
 * 在总预算内**明确失败**，而不是把开跑拖到超时被杀。
 */
export const DEFAULT_SUBMODULE_TIMEOUT_MS = 15_000;

/**
 * 工作目录的种类。
 *
 * - `slice` —— 切片的执行目录（ADR-011），`.zelto/worktrees/<sliceId>`
 * - `version` —— 版本的集成目录（ADR-056），`.zelto/version-worktrees/<label>`
 */
export type WorktreeKind = 'slice' | 'version';

export interface WorktreeInfo {
  /** 切片 id（版本工作目录里是版本 label） */
  sliceId: string;
  /** worktree 绝对路径 */
  path: string;
  /** 相对仓库根的路径 */
  relativePath: string;
  /** 分支名 */
  branch: string;
  /** 建分支时的基点 commit */
  baseCommit: string | null;
  /** 工作目录种类（ADR-056） */
  kind: WorktreeKind;
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

  /**
   * submodule 同步的**超时**（毫秒，单个 submodule）。
   *
   * 为什么要有：submodule 同步在「本地缺目标 commit」时会去联网 fetch，
   * 而 fetch 可能挂住（SSH 等密码、网络不通、代理超时）。挂住 = 开跑
   * 无限期卡住，而 Web 驾驶舱只给 30 秒（见 `adapters/web/throttle.ts`），
   * 于是 Web 端先把 CLI 杀了，切片卡在 `running` —— 一个 agent 都没起，
   * 人只看到一句「发起运行超时」（实测：nimrtc v1.4 演练，2026-11-20）。
   *
   * 默认 15 秒：本地克隆源同步 14 个 submodule 实测总共约 1 秒，
   * 15 秒已经宽松到足以覆盖慢盘；本地没有的 commit 应该在 15 秒内
   * **明确失败**，而不是挂到天荒地老。
   */
  submoduleTimeoutMs?: number;

  /**
   * 生成物清单 —— 建 worktree 时要跑的命令（ADR-095 §3.2）。
   *
   * 用途：生成「不进版本库」的构建产物（证书、protobuf、代码生成…）。
   * 没传 = 不做任何准备（不产生行为变化）。
   */
  prepareCommands?: Array<{ run: string; timeoutSec?: number }>;
}

/**
 * 准备阶段的结果（ADR-095 §3.2）。
 *
 * 现在只有「全成功」这一种可能 —— 失败会抛 `WorktreeError`。
 * 保留这个形状是为了将来能加「部分失败但仍放行」的模式（比如某条命令
 * 是可选的优化项）而不改调用方的类型。
 */
export interface PrepareResult {
  /** 跑成功的命令（按顺序）。 */
  ran: string[];
  /** 失败的那条命令及其原因（没有失败则为空）。 */
  failed?: { run: string; reason: string };
}

/**
 * 准备阶段的单条命令默认超时（秒）。
 *
 * 120 秒的来历（ADR-095 §3.2）：生成物脚本通常是秒级（生成证书、跑
 * codegen），120 秒给足余量而不至于挂死。
 *
 * 与 `DEFAULT_SUBMODULE_TIMEOUT_MS`（15 秒）不同 —— 那条是**本地**操作
 * （克隆 + checkout），15 秒实测够用；这里的命令**可能**要做重活
 * （装依赖、跑 protoc），不能按本地操作的量级给。
 */
export const DEFAULT_PREPARE_TIMEOUT_SEC = 120;

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

  /**
   * 缓存的 git **common dir**（共享的那个 `.git`）。
   *
   * 为什么要缓存：`.git` 在**主仓**里是目录，在 **worktree** 里是**文件**
   * （内容形如 `gitdir: D:/repo/.git/worktrees/<name>`）。zelto 的
   * `run` 常常是在**版本工作目录**（`.zelto/version-worktrees/<label>/`）
   * 里跑的 —— 那里的 `.git` 是文件，于是 `<repoRoot>/.git/modules/...`
   * 这个路径**根本不存在**。
   *
   * 病灶（实测 nimrtc-v14 v1-ice-recovery，2026-11-23）：
   *   `zelto run v1-ice-recovery` 在版本工作目录里跑 →
   *   `syncSubmodules` 找不到任何 module git 目录 → 14 个 submodule 全部
   *   `skipped`（worktree 里 vendor 全空）→
   *   `alignSubmodulesToMainRepo` 去问「commit 在不在」时问错了仓库
   *   （空目录没有 `.git`，git 向上找到**顶层仓库**而不是 submodule）→
   *   回答「没有 ac01707f」→ 抛错「无法创建隔离 worktree」。
   *
   *   而那个 commit **确实存在**（在 `.git/worktrees/v3/modules/...` 里）。
   *
   * 所以这里必须用 `git rev-parse --git-common-dir` 问 git 自己
   * 「共享的 git 目录在哪」，而不是假设 `.git` 是目录。
   */
  private commonDirCache: string | null = null;

  /**
   * 移除 worktree 时的重试间隔（毫秒）。
   *
   * 可被测试改小 —— 生产值 3s 是为了让 Windows 上的文件句柄有时间释放。
   */
  removeRetryDelayMs = 3_000;

  /**
   * submodule 同步的单次超时（毫秒）。
   *
   * 可被测试改小。生产值见 `DEFAULT_SUBMODULE_TIMEOUT_MS`。
   */
  submoduleTimeoutMsOverride: number | undefined;

  /**
   * 最近一次 submodule 同步里**失败**的条目（路径 + 原因）。
   *
   * 为什么要有：同步失败原本被 `catch {}` 吞掉，只留下一个 `skipped` 列表
   * ——而那个列表在调用方也没人读。于是「worktree 里少了 12 个 vendor」
   * 这件事**完全不显形**，等到门禁报「找不到 googletest」时，
   * 人看到的是源码缺失，跟「隔离目录没同步 vendor」毫无关系。
   *
   * 现在失败原因留在这里，调用方能把它说成人话。
   */
  submoduleFailures: Array<{ path: string; reason: string }> = [];

  constructor(repoRoot: string = process.cwd()) {
    this.repoRoot = repoRoot;
  }

  /** 这次同步用哪个超时。 */
  private submoduleTimeoutMs(): number {
    return this.submoduleTimeoutMsOverride ?? DEFAULT_SUBMODULE_TIMEOUT_MS;
  }

  /**
   * 这个仓库的 **git common dir** —— 所有 worktree 共享的那个 `.git`。
   *
   * 为什么必须问 git 而不是自己拼（实测 nimrtc-v14 v1-ice-recovery，2026-11-23）：
   *   `.git` 在主仓里是**目录**，在 worktree 里是**文件**（内容是
   *   `gitdir: D:/repo/.git/worktrees/<name>`）。zelto 的 `run` 常常跑在
   *   **版本工作目录**里，那里的 `.git` 是文件 ——
   *   于是 `<repoRoot>/.git/modules/...` 这种拼法**根本不存在**。
   *
   * `git rev-parse --git-common-dir` 回答的正是「共享的 git 目录在哪」，
   * 主仓与 worktree 都能给出正确答案（worktree 返回主仓的 `.git`）。
   *
   * 拿不到时（不在 git 仓库里 / git 不可用）→ 返回 null，
   * 调用方退回「`<repoRoot>/.git` 是目录」的老假设。
   */
  private gitCommonDir(): string | null {
    if (this.commonDirCache !== null) return this.commonDirCache || null;
    try {
      const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: this.repoRoot,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      this.commonDirCache = out || null;
      return this.commonDirCache;
    } catch {
      this.commonDirCache = '';
      return null;
    }
  }

  /**
   * 某个 submodule 的 **module git 目录**（git 内部存放它对象库的地方）。
   *
   * 候选按优先级：
   *   1. `<repoRoot>/<sub.path>/.git` 是**目录** → 独立嵌套克隆，就用它自己
   *   2. `<repoRoot>/<sub.path>/.git` 是**文件** → 读它写的 `gitdir:` 指针
   *      （这才是**这个工作区里那个 submodule 真正指向的对象库**）
   *   3. `<commonDir>/modules/<name>/` → git 的标准布局（按 name）
   *   4. `<commonDir>/modules/<path>/` → 兜底（历史上有工具按 path 放）
   *   5. `<gitDir>/modules/<name|path>/` → worktree 自己的 git 目录下的 modules/
   *
   * 候选 2/3/5 是修掉「版本工作目录里跑 run 就全军覆没」的关键：
   *   `.git` 在主仓里是**目录**，在 worktree 里是**文件**。zelto 的 `run`
   *   常常跑在**版本工作目录**里 —— 那里的 `.git` 是文件，于是
   *   `<repoRoot>/.git/modules/...` 这种拼法**根本不存在**。
   *
   *   而 worktree 里那个 submodule 的 `.git` 指针指向的是
   *   `.git/worktrees/<name>/modules/...`（**这个 worktree 专属**的对象库），
   *   与主仓那份**不是同一个** —— 里面钉住的 commit 也可能不同。
   *
   * 找不到 → null（调用方记成 skipped，不静默）。
   */
  private moduleGitDirFor(sub: { name: string; path: string }, gitLink: string): string | null {
    // 1. `.git` 是目录 → 独立嵌套克隆
    if (this.isDirectory(gitLink)) return gitLink;

    // 2. `.git` 是文件 → 读它指向的 gitdir
    if (existsSync(gitLink)) {
      const pointed = this.resolveGitLinkPointer(gitLink);
      if (pointed) return pointed;
    }

    // 3/4/5. 共享的 common dir 与 worktree 自己的 git 目录
    const bases: string[] = [];
    const commonDir = this.gitCommonDir();
    if (commonDir) bases.push(join(commonDir, 'modules'));
    // 兜底：`<repoRoot>/.git` 是目录时的老路径（git 不可用时）
    bases.push(join(this.repoRoot, '.git', 'modules'));
    // worktree 自己的 git 目录下的 modules/
    const gitDir = this.gitDirOf(this.repoRoot);
    if (gitDir) bases.push(join(gitDir, 'modules'));

    for (const base of bases) {
      for (const key of [sub.name, sub.path]) {
        const dir = join(base, ...key.split('/'));
        if (existsSync(dir)) return dir;
      }
    }
    return null;
  }

  /**
   * 读 submodule 工作区里那个 `.git` **文件**，解析出它指向的 git 目录。
   *
   * `.git` 文件的内容形如 `gitdir: <path>`，路径可以是**相对**的
   * （相对于 `.git` 文件所在目录）。
   *
   * 为什么要读它（实测 nimrtc-v14 v1-ice-recovery，2026-11-23）：
   *   版本工作目录里那个 submodule 的 `.git` 指向
   *   `.git/worktrees/v3/modules/src/third_party/wolfssl/src` ——
   *   那是**这个 worktree 专属**的对象库，钉住的 commit 与主仓那份不同。
   *   靠猜路径猜不到，只能**问那个指针本身**。
   */
  private resolveGitLinkPointer(gitLink: string): string | null {
    try {
      const raw = readFileSync(gitLink, 'utf-8').trim();
      const m = raw.match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      const target = m[1].trim();
      if (!target) return null;
      const abs = isAbsolute(target) ? target : resolve(join(dirname(gitLink), target));
      return existsSync(abs) ? abs : null;
    } catch {
      return null;
    }
  }

  /**
   * 这个工作区的 **git dir**（worktree 自己那个，不是共享的 common dir）。
   *
   * worktree 的 git 目录在主仓里：`.git/worktrees/<name>`。
   * 它的 `modules/` 下住着**这个 worktree 专属**的 submodule 对象库。
   */
  private gitDirOf(worktreePath: string): string | null {
    try {
      const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--absolute-git-dir'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  /**
   * worktree 的绝对路径（不要求已存在）。
   *
   * 与 `versionPathFor` 同理：切片 id 会被拼进路径，
   * `join` 会归一化掉 `..`，于是 id 能把 worktree 指到 base 之外。
   * CLI 入口有 id 白名单，但 worktree 的 id 也可能来自版本计划里的
   * 切片定义（LLM 产出的 id），那条路不经过 CLI 白名单。
   *
   * 这里用 `resolveWithin` 兜底 —— 路径逃出去就当场抛错。
   */
  pathFor(sliceId: string): string {
    return resolveWithin(join(this.repoRoot, WORKTREE_BASE_DIR), sliceId);
  }

  /** worktree 的相对仓库根路径 */
  relativePathFor(sliceId: string): string {
    return join(WORKTREE_BASE_DIR, sliceId);
  }

  /** 分支名 */
  branchFor(sliceId: string): string {
    return `slice/${sliceId}`;
  }

  /**
   * 该切片是否已有 worktree 目录。
   *
   * id 不合法时返回 false（而不是抛错）：这是一个**判据**。
   */
  exists(sliceId: string): boolean {
    try {
      return existsSync(this.pathFor(sliceId));
    } catch {
      return false;
    }
  }

  // ─── 版本工作目录（ADR-056）───────────────────────────────────────────────

  /**
   * 版本工作目录的绝对路径。
   *
   * 与切片 worktree 分开落在 `.zelto/version-worktrees/<label>/`——
   * 见 `VERSION_WORKTREE_BASE_DIR` 的说明。
   *
   * 为什么要在这里再挡一次（防御纵深）：
   * label 会被拼进路径，而 `join` 会把 `..` **归一化掉**——
   * `join('.zelto/version-worktrees', '..')` 得到 `.zelto`，
   * 路径就逃出了 base。于是版本工作目录可能落在 `.zelto/` 本身
   * 甚至仓库根上，而 `createVersionWorktree` / `removeVersionWorktree`
   * 会对它做建目录、删目录的操作。
   *
   * 上游（CLI 边界）已经有 label 白名单，但那条路可以被绕过：
   * - `merge --target version/<label>` 的 label 是**从分支名反查**的
   * - `versionExists()` 只做存在性判断，label 从哪来都能走到这里
   *
   * 所以这里用 `resolveWithin` 兜底：路径逃出去就**当场抛错**，
   * 绝不建、也绝不删。
   */
  versionPathFor(label: string): string {
    return resolveWithin(
      join(this.repoRoot, VERSION_WORKTREE_BASE_DIR),
      label,
    );
  }

  /** 版本工作目录的相对仓库根路径 */
  versionRelativePathFor(label: string): string {
    return join(VERSION_WORKTREE_BASE_DIR, label);
  }

  /**
   * 该版本是否已有工作目录。
   *
   * label 不合法时返回 false（而不是抛错）：这是一个**判据**。
   */
  versionExists(label: string): boolean {
    try {
      return existsSync(this.versionPathFor(label));
    } catch {
      return false;
    }
  }

  /**
   * 创建（或复用）一个版本工作目录。
   *
   * 与切片 worktree 的区别（ADR-056 §3.1、§3.7）：
   * - 分支是 `version/<label>`，不是 `slice/<id>`
   * - 基点默认取**前置版本分支的 tip**（D2-A），否则取当前 HEAD
   * - `node_modules` **不**链接主仓那一份 —— 多版本各自升级依赖时会打架
   */
  async createVersionWorktree(
    label: string,
    options: { branch: string; baseCommit?: string | null } = { branch: '' },
  ): Promise<WorktreeInfo> {
    const branch = options.branch;
    const target = this.versionPathFor(label);
    const relativePath = this.versionRelativePathFor(label);

    if (existsSync(target)) {
      return {
        sliceId: label,
        path: target,
        relativePath,
        branch,
        baseCommit: this.currentCommit(target),
        kind: 'version',
      };
    }

    const baseCommit = options.baseCommit ?? this.headCommit();

    mkdirSync(join(this.repoRoot, VERSION_WORKTREE_BASE_DIR), { recursive: true });

    const branchExists = this.branchExists(branch);
    const args = branchExists
      ? ['worktree', 'add', target, branch]
      : ['worktree', 'add', '-b', branch, target, baseCommit];

    this.addWorktree(args, `创建版本工作目录失败: ${relativePath}`);

    const info: WorktreeInfo = {
      sliceId: label,
      path: target,
      relativePath,
      branch,
      baseCommit,
      kind: 'version',
    };

    // 版本工作目录也要 submodule —— 否则门禁在缺 vendor 的目录里跑
    this.syncSubmodules(target);
    this.alignSubmodulesToMainRepo(target);

    return info;
  }

  /**
   * 移除版本工作目录。
   *
   * 与 `remove()` 一样先把 `node_modules` 连接摘掉 —— Windows 上路径过长
   * 会让 `git worktree remove` 报 "Filename too long"。
   *
   * D-72：含 submodule 的 worktree 必须用 `--force` 移除 ——
   * git 会硬拒：`fatal: working trees containing submodules cannot be moved
   * or removed`。详见 `needsForceForSubmodules()`。
   */
  async removeVersionWorktree(label: string, options: { force?: boolean } = {}): Promise<void> {
    const target = this.versionPathFor(label);
    if (!existsSync(target)) {
      this.git(['worktree', 'prune'], '清理 worktree 登记失败');
      return;
    }

    this.unlinkNodeModules(target);

    const args = ['worktree', 'remove'];
    // D-72：含 submodule 的 worktree 只有 `--force` 能移除。
    // 人没给 `--force` 时也不能就此失败 —— 清理一个工作目录
    // 不该因为「里面有 submodule」而把人卡住（worktree 本来就要删）。
    if (options.force || this.needsForceForSubmodules(target)) args.push('--force');
    args.push(target);

    this.removeWithRetry(args, target, `移除版本工作目录失败: ${this.versionRelativePathFor(label)}`);
    this.git(['worktree', 'prune'], '清理 worktree 登记失败');
  }

  /**
   * 这个 worktree 里有没有 submodule（D-72）。
   *
   * 判据：**worktree 自己有没有 `.gitmodules`**。
   *
   * 为什么不用「主仓有没有」：主仓有 submodule 不代表这个 worktree 有 ——
   * worktree 检出的是某个 commit，那个 commit 可能还没有 submodule。
   * 反过来 worktree 有 `.gitmodules` 就说明它**一定**含 submodule
   * （至少登记了一个 gitlink）。
   *
   * 为什么不用「目录里有没有 submodule 工作区」：submodule 可能没初始化
   * （目录是空的），但 `.gitmodules` 仍在 —— 而 git 的硬拒看的是
   * **登记**（`.git/modules/` 与 index 里的 gitlink），不是工作区内容。
   * 所以判据要落在登记上：`.gitmodules` 存在 = 有登记 = 会被硬拒。
   */
  needsForceForSubmodules(worktreePath: string): boolean {
    return existsSync(join(worktreePath, '.gitmodules'));
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
      // 规格与验收目录**也**要补一次同步（D-47）。
      //
      // 为什么不能只在「创建时」同步一次：规格是会变的 ——
      // 人重写了规格（`zelto freeze --refreeze`）之后，主仓里的是新版，
      // 而 worktree 里还留着**创建那一刻的旧版快照**。
      //
      // 实测（nimrtc-zelto v2-ai-decision，2026-11-17）：
      //   worktree 05:12 创建（规格 4 条验收标准）
      //   → 09:04 人把规格重写成 9 条（更具体、更可验证）
      //   → 10:00 重跑 agent —— agent 读到的是 worktree 里的**旧 4 条**，
      //     于是照着旧规格实现，缺了 partial/barge_in/agent-control/
      //     framed/IASR/ILLM 六项
      //   → 冻结哈希算的是主仓的新规格（漂移告警正确地响了），
      //     但 agent 干活时依据的是旧规格
      //
      // **判据分裂**：门禁按新规格判，agent 按旧规格干 —— 拦住的不是
      // 「实现有 bug」，而是「实现的是另一个需求」。这种失败最难查，
      // 因为每一道闸门单独看都在正常工作。
      //
      // 所以：规格是 agent 的**输入**，输入必须在每次开跑前对齐到当前真源。
      if (options.specPath) {
        this.copyIntoWorktree(target, options.specPath, true);
      }
      // 验收目录要同步，但**不能覆盖 agent 已经写好的断言**。
      //
      // 归属划分（这一条是 D-47 修复里最容易搞错的地方）：
      //   - 规格文件 = **人的产出**，真源在主仓 → 同步时覆盖是对的；
      //   - 验收测试 = **agent 的产出**，真源在 worktree → 同步时覆盖会
      //     把 agent 写的真断言换回主仓的 `test.todo` 骨架。
      //
      // 后果很具体（实测 nimrtc-zelto v2-ai-decision）：
      //   agent 在 worktree 里把验收测试写成了 6 条真断言（0 个 todo），
      //   主仓里还是 4 条 `test.todo`。若这里无脑覆盖，
      //   重跑时 agent 看到的又是空骨架 —— 而**它上一轮写的真断言
      //   会当场消失**。那是拿 agent 的成果去换 agent 的成果。
      //
      // 合并时 `commitWorktreeChanges` 会把 worktree 的验收测试提交进分支，
      // 所以 agent 的断言最终会进主干 —— **主仓的 todo 会被替换掉**，
      // 不需要（也不应该）在同步阶段动手。
      //
      // 同步只做一件事：**补齐主仓有、worktree 没有的验收文件**。
      // 已有文件不动 —— 它要么是 agent 写的，要么是主仓的原版，
      // 两种都不该被「同步」覆盖。
      if (options.acceptanceDir) {
        this.copyMissingIntoWorktree(target, options.acceptanceDir);
      }
      // 生成物**也要**在复用时补一次（ADR-095 §3.4）。
      //
      // 为什么不能只在「创建时」准备：agent 上一轮跑挂了、或人手动清了
      // worktree 里的产物，产物就不在位了。而产物不在位 → 门禁②的 build
      // 阶段必然失败 —— 代价是 agent 的**整轮**时间。
      //
      // 判据：「每次 agent 开跑前，产物必须在位」。
      if (options.prepareCommands && options.prepareCommands.length > 0) {
        this.prepareArtifacts(target, options.prepareCommands);
      }
      return {
        sliceId,
        path: target,
        relativePath: this.relativePathFor(sliceId),
        branch,
        baseCommit: this.currentCommit(target),
        kind: 'slice',
      };
    }

    const baseCommit = options.baseCommit ?? this.headCommit();

    mkdirSync(join(this.repoRoot, WORKTREE_BASE_DIR), { recursive: true });

    const branchExists = this.branchExists(branch);
    const args = branchExists
      ? ['worktree', 'add', target, branch]
      : ['worktree', 'add', '-b', branch, target, baseCommit];

    this.addWorktree(args, '创建 worktree 失败');

    const info: WorktreeInfo = {
      sliceId,
      path: target,
      relativePath: this.relativePathFor(sliceId),
      branch,
      baseCommit,
      kind: 'slice',
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

    // 每次同步前清空 —— 这一份「上一次同步的结果」不能跨轮次残留，
    // 否则上轮的失败会在本轮被当成新失败报出来。
    this.submoduleFailures = [];

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

      if (!hasGitLink && !hasContent) {
        // 主仓里既没有 .git 也没有内容 → 本地没有副本。
        //
        // **但先问一次 module git 目录**（实测 nimrtc-v14 v1-ice-recovery，2026-11-23）：
        //   在**版本工作目录**里跑时，那个 submodule 可能压根没初始化过
        //   （目录存在但是空的，没有 `.git` 指针）——
        //   它的对象库却**已经在** `.git/worktrees/<name>/modules/...` 里了
        //   （那是被 `git submodule update` 初始化过的版本工作目录留下的）。
        //
        //   早先这里直接 `skipped` → worktree 里 vendor 全空 →
        //   门禁②的 build 阶段才炸，报错是「找不到头文件」（ADR-095 §2.3）。
        //
        //   所以：**先找 module git 目录，找得到就照样同步**（不触网，
        //   用本地 objects）；真找不到才跳过。
        const fallbackDir = this.moduleGitDirFor(sub, gitLink);
        if (!fallbackDir) {
          // 真的什么都没有（既没有工作树，也没有对象库）→ 跳过（不触网拉）。
          //
          // **但必须留痕**（D-73）：「少了哪个 vendor、为什么少」
          // 是人唯一能据此修好环境的线索。不留痕的话，
          // 「vendor 没同步上」这件事直到门禁报「找不到头文件」才显形。
          skipped.push(sub.path);
          this.submoduleFailures.push({
            path: sub.path,
            reason: '本地既没有 submodule 工作树，也没有 module git 目录（对象库）—— 无副本可同步',
          });
          continue;
        }
        // 有 module git 目录 → 走下面的同步路径（`hasGitLink` 为 false，
        // 但对象库在 → 能检出到钉死的 commit）。
        this.syncOneSubmodule(sub, fallbackDir, mainSubPath, worktreePath, initialized, skipped);
        continue;
      }

      if (!hasGitLink) {
        // c) 主仓里已经有源码 → 直接复制过去（离线、且保留内容一致）
        this.copyDirectory(mainSubPath, join(worktreePath, sub.path));
        initialized.push(sub.path);
        continue;
      }

      // submodule 自己的 git 目录。按优先级找几处 —— 见
      // `moduleGitDirFor()` 的说明（关键是**不能**假设 `<repoRoot>/.git` 是目录：
      // 在版本工作目录里它是文件）。
      const moduleGitDir = this.moduleGitDirFor(sub, gitLink);
      if (!moduleGitDir) {
        // 工作树在，但找不到它的 git 目录 → 没法离线同步。
        // 同样要留痕（D-73）。
        skipped.push(sub.path);
        this.submoduleFailures.push({
          path: sub.path,
          reason: 'submodule 工作树存在，但找不到它的 git 目录（.git 指针与 module git 目录都不在）',
        });
        continue;
      }

      this.syncOneSubmodule(sub, moduleGitDir, mainSubPath, worktreePath, initialized, skipped);
    }

    // 嵌套 submodule：主仓的 module git 目录做本地克隆源，不联网。
    this.syncNestedSubmodules(worktreePath, submodules.map((s) => s.path));

    return { initialized, skipped };
  }

  /**
   * 把一个 submodule 同步进 worktree（本地 objects，不触网）。
   *
   * 抽出来是因为两条路径汇到同一处：
   *   - 主仓里那个 submodule 有 `.git` 指针（正常初始化的）
   *   - 主仓里那个 submodule **没有** `.git`，但 module git 目录**存在**
   *     （版本工作目录里没初始化过的 submodule —— 见 `syncSubmodules` 的说明）
   */
  private syncOneSubmodule(
    sub: { name: string; path: string },
    moduleGitDir: string,
    mainSubPath: string,
    worktreePath: string,
    initialized: string[],
    skipped: string[],
  ): void {
    {
      // ── 钉死的 commit 本地有没有？先查，再动 ──────────────────────
      //
      // 病灶（实测 nimrtc-v14 v3-n4-d6-connectivity，2026-11-22）：
      //   `version/v3` 的树钉住了较老的子模块 commit（googletest `15460959`、
      //   libopus `22244de5`），而本地 module 仓库里只有较新的
      //   「carbon copy」commit（`05d7a9b`）。
      //
      //   于是 `submodule update --init --no-fetch` **失败**（本地缺 commit），
      //   失败被记成 `submoduleFailures` —— 而那只是一条**警告**。
      //   worktree 照样建好，vendor 目录是**空的**，
      //   然后门禁②的 build 阶段才炸，报错是「找不到 googletest」
      //   或「复制某个头文件失败」—— 跟真正的原因毫无关系（ADR-095 §2.3）。
      //
      // 为什么在**这里**查（而不是只在 align 阶段查）：
      //   update 失败在 align **之前**，align 根本没机会跑。
      //   所以「commit 存在性」的判据必须放在 update 之前。
      //
      // 判据：`git cat-file -e <sha>` —— 只读本地对象库，不触网（C3）。
      //
      // **在哪个目录里问**：问**主仓工作区里那个 submodule 的工作树**
      // （`<主仓>/<sub.path>`），不是 module git 目录本身。
      //
      // 为什么（实测踩坑，2026-11-22）：
      //   独立嵌套克隆（`.git` 是**目录**）的 module git 目录里有一条
      //   `core.worktree` —— 它是**相对路径**（`../../../../vendor/lib`），
      //   指回主仓工作区里那个 submodule。
      //   在 module git 目录里跑 `git cat-file` 时，git 会去 chdir 到那个
      //   相对路径 —— 从别的 cwd 进去就**找不到**了：
      //     fatal: cannot chdir to '../../../../vendor/lib': No such file or directory
      //   于是明明有那个 commit，却判成「没有」→ 误拦一个好的工程。
      //
      //   共享 module git 目录（`.git/modules/...`）没有这个问题，
      //   但从工作树问同样是对的 —— 所以统一问工作树。
      //
      // **主仓工作区里那个 submodule 是个空目录时**（版本工作目录里
      // 没初始化过 submodule 的那种情况）→ **问 module git 目录本身**。
      //
      // 为什么（实测 nimrtc-v14 v1-ice-recovery，2026-11-23）：
      //   空目录里没有 `.git`，git 会**向上**找到**顶层仓库**（版本工作目录
      //   自己那个 git dir），于是回答的是顶层仓库的答案 ——
      //   顶层仓库里当然没有那个 submodule 的 commit → **误判为缺失**。
      //   实测就是这么误报的：报「没有 ac01707f」，而那个 commit
      //   **确实存在**在 module git 目录里。
      //
      // 判据：那个目录里**有没有 `.git`**（有 = 真 submodule 工作区，
      // 问它；没有 = 空壳，问 module git 目录）。
      const pinned = this.pinnedCommitOf(sub.path);
      const mainSubIsReal = existsSync(join(mainSubPath, '.git'));
      const probePath = mainSubIsReal ? mainSubPath : moduleGitDir;
      if (pinned && !this.commitAvailable(probePath, pinned)) {
        // 本地缺这个 commit → **记下来并抛错**，不继续建一个空 vendor 的 worktree。
        //
        // 为什么是抛错而不是警告（ADR-095 §3.1）：worktree 建出来是**坏的**，
        // 门禁②**必然**失败。让它在建 worktree 的时候失败（早几分钟、
        // 错误信息直达），比在门禁的时候失败（信息被几千行编译输出淹没）
        // 好得多。
        //
        // 与 C9 同一原则：**依赖缺失时的正确动作是停下**，
        // 不是带着缺口继续跑。
        //
        // **为什么还要先记进 `submoduleFailures`**：D-73 立的契约是
        // 「同步失败必须被记下来 —— 否则『vendor 没同步上』完全不显形」。
        // 两条契约不冲突：记下来（留痕，事后可查）+ 抛错（当场停下）。
        // 只抛错的话，调用方拿不到「是哪个 vendor」的结构化信息。
        const reason = `本地 module git 目录里没有 index 记录的 commit ${pinned.slice(0, 8)}`;
        this.submoduleFailures.push({ path: sub.path, reason });

        throw new WorktreeError(
          missingSubmoduleCommitMessage(sub.path, pinned, this.repoRoot),
          `submodule update ${sub.path}`,
          reason,
        );
      }

      try {
        this.gitOffline(
          [
            '-c', 'protocol.file.allow=always',
            // 把克隆源指向主仓里已存在的 module git 目录：
            //   - 不触网（用的是本地 objects）
            //   - 不受 `protocol.file.allow` 限制（本地路径克隆默认被禁）
            // 注意配置键用的是 submodule 的 **name**（.gitmodules 的 section 名），
            // 不是 path —— 两者相同时看不出差别，不同时就改错了 submodule。
            '-c', `submodule.${sub.name}.url=${moduleGitDir}`,
            // ── 不用 `--recursive` ───────────────────────────────────
            // `--recursive` 会把**嵌套** submodule 也拉进来。而嵌套层的
            // 克隆源在主仓里没有对应的 module git 目录可指向 ——
            // git 只好按 `.gitmodules` 里写的 https URL **联网**克隆。
            //
            // 实测（nimrtc-zelto v2-input-binder，2026-11-17）：
            //   `git submodule update --init --recursive` 触发
            //   `git clone https://github.com/openssl/openssl ...`
            //   → 两个 clone 挂起 5 分钟以上（还在等网络），
            //     agent 迟迟起不来，worktree 里的 vendor 目录是空的。
            //
            // 后果有两条，都很重：
            //   1. **违反 C3**（`core/` 不触网）—— 判定路径居然在拉网络；
            //   2. **不确定的耗时** —— 门禁跑在 vendor 缺失的目录上，
            //      agent 只能干等，或者自己手工拷一份（把 vendor 改成
            //      「非 submodule 的普通目录」，破坏主仓的一致性）。
            //
            // 嵌套 submodule 由 `syncNestedSubmodules` 处理 ——
            // 从主仓的 module git 目录**本地克隆**（不触网）。
            //
            // ── `--no-fetch` 是这里的关键 ──────────────────────────────
            // 没有它，git 在「本地缺目标 commit」时会去 fetch 远程
            // （`.gitmodules` 里写的公网 URL）—— 违反 C3，且会挂住。
            // 加上它：本地有就用本地的，本地没有就**如实失败**，
            // 由调用方记成 skipped（并给出可执行的修法）。
            'submodule', 'update', '--init', '--no-fetch', sub.path,
          ],
          worktreePath,
          this.submoduleTimeoutMs(),
        );
        initialized.push(sub.path);
      } catch (err) {
        skipped.push(sub.path);
        // 记下原因 —— 「本地缺这个 commit」和「根本没有本地副本」是两种
        // 完全不同的问题，修法也不同。人不该只看到「少了个 vendor」。
        this.submoduleFailures.push({
          path: sub.path,
          reason: describeSubmoduleFailure(err),
        });
      }
    }
  }

  /**
   * 把**嵌套** submodule 从主仓的 module git 目录**本地克隆**到 worktree（不联网）。
   *
   * 为什么需要这一步：`git submodule update --init`（不带 `--recursive`）
   * 只处理顶层 submodule。嵌套层（msquic 的 openssl / quictls /
   * googletest 等）留在 worktree 里就是空目录 —— 门禁配置阶段就会报
   * 「找不到 googletest」。
   *
   * 为什么是**本地克隆**而不是 `submodule update --init --recursive`：
   *   嵌套 submodule 的克隆源在主仓里**有**对应的 module git 目录，
   *   但 git 自己不知道 —— 它只认 `.gitmodules` 里写的 https URL，
   *   于是去**联网**克隆（实测挂起 5 分钟以上，且违反 C3）。
   *
   * 我们把克隆源**显式指到主仓的 module git 目录**：
   *   - 不触网（用本地 objects）
   *   - 保留 submodule 结构（是真正的 gitlink，不是普通目录）
   *   - 与顶层 submodule 的处理方式一致
   *
   * 克隆源找不到时**跳过**（不报错）—— 缺依赖时门禁会报更明确的信息。
   */
  private syncNestedSubmodules(worktreePath: string, topLevelPaths: string[]): void {
    for (const topPath of topLevelPaths) {
      const mainTop = join(this.repoRoot, topPath);
      if (!existsSync(mainTop)) continue;

      // 顶层自己就是嵌套的根：它的 .gitmodules 里还有一层
      const nestedGitmodules = join(mainTop, '.gitmodules');
      if (!existsSync(nestedGitmodules)) continue;

      let nested: Array<{ name: string; path: string }> = [];
      try {
        const raw = this.git(
          ['config', '--file', nestedGitmodules, '--get-regexp', '^submodule\\..*\\.path$'],
          undefined,
          true,
          mainTop,
        );
        nested = raw
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
        continue;
      }

      for (const sub of nested) {
        const dest = join(worktreePath, topPath, sub.path);
        if (existsSync(dest) && this.hasDirectoryContent(dest)) continue;

        // ── 克隆源：主仓里的嵌套 module git 目录 ─────────────────────
        //
        // 布局是 git 的标准嵌套形态：
        //   `<主仓>/.git/modules/<顶层path>/modules/<嵌套path>`
        //
        // 实测（nimrtc-zelto v2-input-binder，2026-11-17）：
        //   顶层 = `src/third_party/msquic`，嵌套 = `submodules/googletest`
        //   → `.git/modules/src/third_party/msquic/modules/submodules/googletest`
        //
        // 注意**没有**多一层 `submodules/` —— 顶层路径本身已经贡献了
        // `msquic`，剩下的是 `modules/` + 嵌套的 path。
        // 早先这里拼成了 `.../modules/submodules/<name>`（多一层），
        // 两个候选都找不到 → 静默跳过 → worktree 里嵌套层仍是空目录。
        //
        // 候选按「共享 common dir」与「本 worktree 自己的 git dir」两处都试 ——
        // 在**版本工作目录**里跑时，`.git` 是文件，`<repoRoot>/.git/modules` 不存在
        // （同 `moduleGitDirFor()` 的病灶说明）。
        const nestedBases = [
          ...(this.gitCommonDir() ? [join(this.gitCommonDir() as string, 'modules')] : []),
          join(this.repoRoot, '.git', 'modules'),
          ...(this.gitDirOf(this.repoRoot)
            ? [join(this.gitDirOf(this.repoRoot) as string, 'modules')]
            : []),
        ];
        const moduleGitDir = nestedBases
          .flatMap((base) => [
            join(base, ...topPath.split('/'), 'modules', ...sub.path.split('/')),
            join(base, ...topPath.split('/'), 'modules', ...sub.name.split('/')),
          ])
          .find((dir) => existsSync(dir));
        if (!moduleGitDir) continue;

        // 顶层 submodule 在 worktree 里的位置 —— 嵌套层要挂在它下面
        const topDest = join(worktreePath, topPath);
        if (!existsSync(topDest)) continue;

        try {
          this.gitOffline(
            [
              // ── `-c` 必须在子命令**之前** ──────────────────────────
              // 放在 `submodule update --init` 之后 git 会直接报 usage 错误
              // （实测：`git submodule update --init -c key=val path` → usage 报错，
              // 什么都没做，还被 try/catch 吞掉 → 静默跳过）。
              '-c', 'protocol.file.allow=always',
              // 把克隆源指向主仓里已存在的 module git 目录：
              //   - 不触网（用的是本地 objects）
              //   - 不受 `protocol.file.allow` 限制（本地路径克隆默认被禁）
              //
              // 配置键用的是嵌套层 `.gitmodules` 的 **section 名**
              // （msquic 的是 `submodules/googletest`），不是 path。
              '-c', `submodule.${sub.name}.url=${moduleGitDir}`,
              // `--no-fetch`：嵌套层本地缺 commit 时不许去联网（见 gitOffline 的说明）
              'submodule', 'update', '--init', '--no-fetch', sub.path,
            ],
            topDest,
            this.submoduleTimeoutMs(),
          );
        } catch {
          // 克隆失败不阻断 —— 门禁会因缺依赖报错，信息更明确
        }
      }
    }
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

      // worktree 里这个 submodule **有没有被初始化出来**。
      //
      // 为什么必须单独判（实测 nimrtc-v14 v1-ice-recovery，2026-11-23）：
      //   worktree 里的 submodule 目录存在但**是空的**（没有 `.git`）——
      //   那说明同步那一步没成功。
      //   此时在 `wtSub` 里跑任何 git 命令，git 会**向上**找到顶层仓库，
      //   于是回答的是**顶层仓库**的答案：
      //     - `rev-parse HEAD` → 顶层仓库的 HEAD（毫无意义）
      //     - `cat-file -e <sha>` → 顶层仓库里没有那个 commit → **误判为缺失**
      //   实测就是这么误报的：报「没有 ac01707f」，而那个 commit
      //   **确实存在**在 submodule 自己的对象库里。
      //
      // 所以：目录里没有 `.git` → 不问它，改问**主仓**里那个 submodule
      // （它的 `.git` 指向真正的 module git 目录）。
      const wtHasGit = existsSync(join(wtSub, '.git'));

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
      const wtHead = wtHasGit ? this.submoduleHead(wtSub) : null;
      if (wtHead === target) continue;

      // ── 钉死的 commit 本地根本没有？→ 明确报错，别静默 ────────────
      //
      // 病灶（实测 nimrtc-v14 v3-n4-d6-connectivity，2026-11-22）：
      //   `version/v3` 的树钉住了较老的子模块 commit（googletest `15460959`、
      //   libopus `22244de5`），而本地 module 仓库里只有较新的
      //   「carbon copy」commit（`05d7a9b`）。
      //   `git checkout --force <pin>` 在本地缺该 commit 时**失败**，
      //   原来的 `catch {}` 把它吞了 —— worktree 的 vendor 目录于是是**空的**。
      //
      //   然后：错误在**门禁②的 build 阶段**炸出来，
      //   报错是「找不到 googletest」/「复制某个头文件失败」，
      //   跟「这个 commit 本地没有」毫无关系（ADR-095 §2.3）。
      //
      // 判据用 `cat-file -e`：只读本地对象库，不触网（C3），且是确定性的。
      // 「commit 不存在」与「checkout 因别的原因失败」必须分开 ——
      // 前者必须拦（worktree 建出来就是坏的），后者不该拦（可能只是一次占用）。
      //
      // **问哪个目录**：worktree 里那个 submodule 初始化成功时问它；
      // 没初始化成功时问**主仓**里那个 —— 但主仓里那个若也是**空壳**
      // （版本工作目录里没初始化过 submodule），问它等于问**顶层仓库**
      // → 误判「缺失」（见上面的病灶说明）。
      //
      // 兜底：module git 目录本身就是那个对象库 —— 它一定答得对。
      const probePath = wtHasGit
        ? wtSub
        : existsSync(join(mainSub, '.git'))
          ? mainSub
          : this.moduleGitDirFor(sub, join(mainSub, '.git')) ?? mainSub;
      if (!this.commitAvailable(probePath, target)) {
        throw new WorktreeError(
          missingSubmoduleCommitMessage(sub.path, target, this.repoRoot),
          `checkout ${target}`,
          `本地 module git 目录里没有 commit ${target}`,
        );
      }

      try {
        this.git(['checkout', '--force', target], undefined, false, wtSub);
        aligned.push(sub.path);
      } catch {
        // 对不齐就留着 —— git status 会显示差异，审计会报出来（不静默）。
        //
        // 注意：这里只吞「checkout 失败」，**不吞「commit 不存在」** ——
        // 后者已经在上面单独判过了（ADR-095 §3.1）。
        this.submoduleFailures.push({
          path: sub.path,
          reason: `检出到 ${target} 失败（commit 在本地存在，但 checkout 没成功）`,
        });
      }
    }

    return aligned;
  }

  /**
   * 主仓 index 里钉死的那个 submodule commit（gitlink 记录的 sha）。
   *
   * 读的是**主仓**的 index —— 不是 worktree 的。
   *
   * 为什么（实测踩坑，2026-11-22）：
   *   `git submodule add` 会把 gitlink **暂存**进 index，但它**不提交**。
   *   所以主仓工作区的 index 里有那个 gitlink，而主仓 HEAD 里没有。
   *   而 worktree 是从 **HEAD** 建出来的 —— 它的 index 里于是**没有** gitlink。
   *
   *   读 worktree 的 index 的话，永远读到空 → 判据形同虚设。
   *
   * 哪个才是「钉死的那个」？主仓 index 里的 gitlink 才是 —— 它是
   * `git submodule update` 会检出的那个 commit。
   *
   * 读不到（没钉 / 不是 submodule）→ null（= 不查，不拦）。
   */
  private pinnedCommitOf(subPath: string): string | null {
    try {
      const recorded = this.git(
        ['ls-files', '-s', '--', subPath],
        undefined,
        true,
        this.repoRoot,
      ).trim();
      const match = recorded.match(/^160000 ([0-9a-f]{40})/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
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

    const sliceMarker = `/${WORKTREE_BASE_DIR.replace(/\\/g, '/')}/`;
    const versionMarker = `/${VERSION_WORKTREE_BASE_DIR.replace(/\\/g, '/')}/`;

    const flush = () => {
      if (!current) return;
      const normalized = current.path.replace(/\\/g, '/');

      // 版本目录先判（它的路径里也含 "worktrees/"）
      const versionIdx = normalized.lastIndexOf(versionMarker);
      if (versionIdx !== -1) {
        const label = normalized.slice(versionIdx + versionMarker.length);
        if (label) {
          results.push({
            sliceId: label,
            path: current.path,
            relativePath: join(VERSION_WORKTREE_BASE_DIR, label),
            branch: current.branch.replace('refs/heads/', ''),
            baseCommit: current.head,
            kind: 'version',
          });
        }
        current = null;
        return;
      }

      const idx = normalized.lastIndexOf(sliceMarker);
      if (idx !== -1) {
        const sliceId = normalized.slice(idx + sliceMarker.length);
        if (sliceId) {
          results.push({
            sliceId,
            path: current.path,
            relativePath: join(WORKTREE_BASE_DIR, sliceId),
            branch: current.branch.replace('refs/heads/', ''),
            baseCommit: current.head,
            kind: 'slice',
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
    // D-72：含 submodule 的 worktree 只有 `--force` 能移除（git 硬拒）。
    if (options.force || this.needsForceForSubmodules(target)) args.push('--force');
    args.push(target);

    // ── ZD-016：记下「移除之前」git 侧的登记状态 ────────────────────
    //
    // 兜底的前提是「git 侧已经注销了，但目录还在」。这个前提要拿**事实**判定：
    //
    //   事实一：git **自己说**「这已经不是工作树了」→ 它不认这个目录了。
    //   事实二：事前 `git worktree list` 里查得到、事后查不到
    //           → git 摘了登记（git 先摘登记再删目录，所以这个现象很常见）。
    //
    // 反过来，「事前就查不到」**不能**当成「git 刚摘掉」——
    // 那只是「git 压根没管过这个目录」（比如残留目录、测试里手搓的目录）。
    // 这两种情况在 list 输出上长得一模一样，只有**事前快照**能区分。
    // 事前没登记 → remove 失败就是 git 的真错误 → 按 D-67 的契约立刻抛出。
    const registeredBefore = this.isRegistered(target);
    // 这个目录**当过 worktree 吗**？（看 `.git` 指针文件，见 looksLikeWorktree）
    const wasWorktree = this.looksLikeWorktree(target);
    // git 显式说「这已经不是工作树了」→ 它自己不认这个目录了。
    const deregisteredSignal = /is not a working tree|not a working tree/i;

    try {
      this.removeWithRetry(args, target, `移除 worktree 失败: ${relative(this.repoRoot, target)}`);
    } catch (err) {
      // ── ZD-016：git 侧已注销、目录还在的兜底 ─────────────────────
      //
      // 病灶（实测于 nimrtc-v14 v1-n5-turn-server，2026-11-20）：
      //   `git worktree remove` 报「Permission denied」（MSBuild 还持有
      //   worktree 里 pdb 的句柄）→ 目录没删掉，但 **git 侧的登记已经
      //   被摘掉了**（git 先摘登记再删目录）。
      //
      //   于是：
      //     - 目录还在（几个 GB 的构建树）
      //     - 但 `git worktree remove --force <path>` 现在必然失败 ——
      //       「fatal: '<path>' is not a working tree」
      //
      //   zelto 之前给出的补救命令**正是这条必然失败的命令**。
      //
      // ── 关键：兜底的触发条件必须是「git 侧确实已注销」这个**事实**，
      //         不能是「remove 失败了」这种**症状** ────────────────────
      //
      // 症状与事实必须分开，否则会把三类完全不同的失败混为一谈：
      //
      //   (a) git 说不认它了（显式报错 or 登记前后翻转）
      //       → git 侧不用管了，**直接删目录**是安全的。
      //
      //   (b) **git 侧的登记还在**，只是目录删不掉
      //       （文件句柄被占 / cwd 锁）→ 登记还在时直接删目录等于
      //       绕过 git 撕毁登记，git 那边会留下一个指向不存在目录的
      //       悬空条目 → 后续 `git worktree list` / prune 行为诡异。
      //
      //   (c) git **压根不认**这个目录（事前就没登记）→ remove 失败是
      //       git 的真错误，按 D-67 的契约**立刻抛出**，不许被兜底吞掉。
      const detail = err instanceof WorktreeError ? (err.stderr ?? '') : String(err);
      const gitSaysDeregistered = deregisteredSignal.test(detail);
      const registeredAfter = this.isRegistered(target);
      const deregistered =
        gitSaysDeregistered ||
        (registeredBefore && !registeredAfter) ||
        // 「当过 worktree，但 git 现在不认它了」——
        // 这是 ZD-016 的真实现场：git 先摘登记再删目录，删到一半撞上占用。
        (wasWorktree && !registeredAfter);

      // ── 兜底的前提之二：失败必须是**占用类** ──────────────────────
      //
      // D-67 的契约是「**非占用类**错误立刻抛出，不许被兜底改写」。
      // 而 git 报「not a working tree」也可能是非占用类的真错误 ——
      // 比如这个路径压根不是工作树（测试里手搓的目录、早已 prune 过的残留），
      // 那时 remove 失败就是 git 的**真错误**，必须原样抛出去让人看。
      //
      // 只有占用类失败才可能是「git 想删但删不掉、可能已经摘了登记」
      // 那一回事 —— 那才是 ZD-016 的病灶。
      //
      // 两个条件是「且」的关系：
      //   git 不认它（事实） **且** 失败是占用类（症状）
      // 少任何一个都不兜底 —— 宁可报错让人看，不许替 git 改判。
      const busyFailure = this.isBusyRemovalError(detail);

      if (deregistered && busyFailure) {
        // (a) git 侧已经不需要管了（登记没了），直接删目录。
        this.git(['worktree', 'prune'], undefined, true);
        if (this.deleteDirectoryDirectly(target)) return;
      } else if (registeredBefore) {
        // (b) 登记还在 → 先让 git 摘登记，再删目录（顺序不能反：
        // 先删目录的话，git 会认为 worktree 还存在却目录不见了）。
        this.git(['worktree', 'remove', '--force', target], undefined, true);
        this.git(['worktree', 'prune'], undefined, true);
        if (this.deleteDirectoryDirectly(target)) return;
      }
      // (c) 兜底不适用 → 把原始错误抛出去。
      //
      // ── ZD-017：目录删不掉 —— 区分「文件句柄被占」与「cwd 锁」──
      //
      // 两者的补救方式完全不同，给错建议等于把人送进死胡同
      // （ZD-016 的教训）。这里把诊断结论附在**原始错误的消息**上。
      //
      // 注意是「附加」而不是「另起一个错误」：
      //   - 保留原始 message / stderr → 人看到的是 git 真正说的话
      //   - 保留原始错误类型（WorktreeError / 别的）→ 调用方的
      //     `instanceof` 判断与 CLI 的错误分支不受影响
      const diagnosis = this.diagnoseRemovalBlock(target);
      const originalMessage = err instanceof Error ? err.message : String(err);
      if (err instanceof Error) {
        err.message = `${originalMessage}\n     ${diagnosis}`;
        throw err;
      }
      throw new WorktreeError(`${originalMessage}\n     ${diagnosis}`);
    }
    this.git(['worktree', 'prune'], '清理 worktree 登记失败');
  }

  /**
   * 这个 worktree 在 git 侧**登记着吗**？（ZD-016）
   *
   * 判据问的是**事实**，不是症状：
   *   - `git worktree list --porcelain` 里查得到这个路径 → 登记着
   *   - 查不到 → 没登记
   *
   * 为什么不用「错误消息里有没有『not a working tree』」：
   *   那句话只覆盖了事实成立**且 git 恰好这么说了**的情形。
   *   占用类错误（Invalid argument / Permission denied）耗尽重试后，
   *   git 侧可能**已经摘了登记**（git 先摘登记再删目录）也可能没有 ——
   *   只有问 git 本人才知道。
   *
   * 问不到（git 调用本身失败）时**保守返回 false**（当作没登记）：
   *   判「没登记」只会让兜底不生效 —— 错误照常抛出，不会误删目录。
   */
  private isRegistered(target: string): boolean {
    let output = '';
    try {
      output = this.git(['worktree', 'list', '--porcelain'], undefined, true);
    } catch {
      return false;
    }
    const normalizedTarget = target.replace(/\\/g, '/').replace(/\/+$/, '');
    for (const line of output.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const path = line.slice('worktree '.length).trim().replace(/\\/g, '/').replace(/\/+$/, '');
      if (path === normalizedTarget) return true;
    }
    return false;
  }

  /**
   * 这个目录**当过 git worktree 吗**？（ZD-016）
   *
   * 判据：目录里有 `.git` **文件**。
   *
   * 为什么是「文件」而不是「目录」：
   *   - 主仓的 `.git` 是**目录**；
   *   - worktree 的 `.git` 是**文件**（内容形如
   *     `gitdir: D:/repo/.git/worktrees/<name>`）——
   *     worktree 的 git 目录在**主仓**里，worktree 自己只留一个指针。
   *
   * 为什么需要它：
   *   「`git worktree list` 里查不到这个路径」有两种来源 ——
   *     (i)  git **刚摘掉**登记（ZD-016 的病灶）
   *     (ii) 这个路径**从来**不是 worktree
   *   两者在 list 输出上**长得一模一样**，只有这个判据能分开：
   *   真正当过 worktree 的目录会留下 `.git` 文件。
   *
   * 只读文件、不调 git、不触网 —— 符合 core/ 的边界（C3）。
   */
  private looksLikeWorktree(target: string): boolean {
    try {
      const gitPath = join(target, '.git');
      // 必须是**文件**：worktree 的 `.git` 是指针文件；
      // 目录形态说明这是一份普通 clone（或者主仓根），不是 worktree。
      return statSync(gitPath).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 直接删目录（绕开 git）。
   *
   * 只在**git 侧的登记已经没了**之后用 —— 见 `remove` 里的 ZD-016 说明。
   *
   * @returns 是否删掉了
   */
  private deleteDirectoryDirectly(target: string): boolean {
    if (!existsSync(target)) return true;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        rmSync(target, { recursive: true, force: true });
        return !existsSync(target);
      } catch {
        // 文件被占用 —— 退避后重试（句柄通常几秒内释放）
        if (attempt < 3) this.sleep(this.removeRetryDelayMs * attempt);
      }
    }
    return !existsSync(target);
  }

  /**
   * 诊断「目录删不掉」的真因，给出人能直接照做的建议。
   *
   * ── ZD-017（实测于 nimrtc-v14 v1-n5-turn-server，2026-11-20）─────
   *
   * Windows 上有两类完全不同的「占用」，补救方式也不同：
   *
   * (a) **文件句柄被占** —— 某个进程打开了 worktree 里的文件
   *     （MSBuild 拿着 pdb、刚跑完的 exe 没退干净）。等几秒句柄会释放，
   *     `rmdir /s /q` 就能删掉。
   *
   * (b) **进程把目录设成了当前工作目录** —— 目录**一个文件都没有**
   *     （只有 `.` 和 `..`），但 Windows 会给 cwd 一个目录句柄，
   *     于是 `rd /s /q` 报「另一个程序正在使用此文件夹」。
   *
   * (b) 的关键识别特征是**目录是空的**：如果是 (a)，worktree 里躺着
   * 几 GB 构建树，删不掉是因为文件还在；而 (b) 里 git 已经把内容清空了，
   * 只剩一个空壳。
   *
   * 这一类**用 Restart Manager 查不到**（它只管文件句柄），
   * `Get-CimInstance Win32_Process` 也看不到 cwd。唯一可靠的定位办法是
   * 读进程 PEB —— 那是特权操作，超出 `core/` 「纯判定」的边界（C3），
   * 所以 zelto 不自动查，只**认得出这个特征并给出正确的人工排查步骤**。
   *
   * @returns 给人的建议文本；目录为空且删不掉时返回 cwd 锁的排查指引
   */
  private diagnoseRemovalBlock(target: string): string {
    let isEmpty = false;
    try {
      isEmpty = readdirSync(target).length === 0;
    } catch {
      // 读不出来（权限/已消失）→ 按普通占用处理
    }

    if (!isEmpty) {
      return [
        'Worktree directory still contains files — a process is holding file handles (typical: MSBuild / a freshly built exe).',
        'Wait a few seconds and retry, or close that process, then:',
        `  rmdir /s /q "${target}"`,
      ].join('\n     ');
    }

    return [
      'Worktree directory is EMPTY but cannot be deleted — this is the Windows "current working directory" lock (ZD-017),',
      'not a file-handle problem. Some process still has this directory as its cwd, so Windows keeps a directory handle on it.',
      'Restart Manager cannot see this kind of lock, so it will report "no lockers" even though the directory cannot be removed.',
      'To find the holder (Windows):',
      '  1. Open Sysinternals "handle.exe" and run:  handle.exe -accepteula "v1-n5-turn-server"',
      '  2. Or list every process cwd by reading PEB (see docs/实战缺陷记录-nimrtc-v14.md §ZD-017 for a ready-to-run script)',
      '  3. Kill that process, then:  rmdir /s /q "' + target + '"',
      'Note: MSBuild workers started with /nodeReuse:true are a common culprit — `MSBuild.exe -nodeReuse:false` avoids it.',
    ].join('\n     ');
  }

  // ─── 上下文同步 ──────────────────────────────────────────────────────────

  /**
   * 把执行所需的上下文同步进 worktree：
   * - submodule（vendor 源码树；`git worktree add` 不会带过来）
   * - 规格文件（复制，覆盖可能未提交的版本）
   * - 验收测试目录（复制）
   * - node_modules（平台连接，共享主仓库依赖）
   * - 生成物（跑 `worktree.prepare` 里的命令，ADR-095 §3.2）
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
    // 生成物**最后**准备 —— 它依赖前面积累好的目录结构
    //（spec / acceptance / node_modules 链接）。
    if (options.prepareCommands && options.prepareCommands.length > 0) {
      this.prepareArtifacts(info.path, options.prepareCommands);
    }
  }

  /**
   * 跑「生成物清单」里的命令，把不进版本库的构建产物**重新生成**出来。
   *
   * 为什么需要（ADR-095 §3.2，实测 nimrtc-v14 v3-n4-d6-connectivity）：
   *   新建的 worktree 只含**被 git 跟踪**的内容。有些项目的构建**依赖**
   *   生成的产物 —— 那文件在 `.gitignore` 里（wolfssl 的
   *   `certs/ecc-key.pem`），git 不会带过去。于是门禁②的 build 阶段必然失败，
   *   报错是「复制某个 pem 失败」/「找不到头文件」——
   *   跟「这个文件是生成的」毫无关系。
   *
   * 为什么是「生成」而不是「拷贝」：拷贝旧的产物可能带来**过期**的内容
   * （过期证书），而重新生成保证产物与当前代码一致。
   *
   * **fail fast**：前一条失败就不跑后一条。理由有二：
   *   1. 后一条大概率也依赖前一条的产物，跑下去只是浪费；
   *   2. 连着跑一串注定失败的命令，报错会指向最后一条 —— 又是「报错指向错的地方」。
   *
   * **失败就抛**：不放行到 agent。这与 C9 的 fail closed 同一原则 ——
   * 依赖缺失时的正确动作是停下，不是带着缺口继续跑。
   */
  prepareArtifacts(
    worktreePath: string,
    commands: Array<{ run: string; timeoutSec?: number }>,
  ): PrepareResult {
    const ran: string[] = [];

    for (const cmd of commands) {
      const run = cmd.run.trim();
      if (!run) continue;

      const timeoutMs = Math.max(
        1_000,
        (cmd.timeoutSec ?? DEFAULT_PREPARE_TIMEOUT_SEC) * 1000,
      );

      try {
        execFileSync(run, [], {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Windows 上准备命令常是 `.cmd` / `.bat`（`npm` 就是），
          // 不走 shell 的话 `ENOENT`。
          shell: true,
        });
      } catch (err) {
        const raw = err as { stderr?: Buffer | string; message?: string };
        const stderr = raw?.stderr ? String(raw.stderr).trim() : '';
        const reason = stderr || (err instanceof Error ? err.message : String(err));

        throw new WorktreeError(
          [
            `准备阶段失败：第 ${ran.length + 1} 条命令退出码非零`,
            `命令：${run}`,
            '',
            'worktree 还没准备好，agent **没有**开跑。',
            '修好这条命令（或从 worktree.prepare 里去掉它）后重建 worktree。',
            '',
            reason,
          ].join('\n'),
          run,
          reason,
        );
      }

      ran.push(run);
    }

    return { ran };
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

  /**
   * 只补齐**主仓有、worktree 没有**的验收文件；已有的一个都不动。
   *
   * 为什么不能像规格那样直接覆盖 —— 见 `create()` 里复用分支的注释：
   * 验收测试是 **agent 的产出**，真源在 worktree 里。覆盖等于
   * 把 agent 写的真断言换回主仓的 `test.todo` 骨架。
   *
   * 补齐（而不是不抄）是为了另一种情形：主仓里**新增**了验收文件
   * （比如人手工加了一条回归用例），worktree 里还没有 ——
   * 那份是人的产出，agent 应该看到。
   *
   * 判据按**相对路径**逐个文件比：worktree 里有的就跳过。
   */
  private copyMissingIntoWorktree(worktreePath: string, relativePath: string): void {
    const source = join(this.repoRoot, relativePath);
    if (!existsSync(source)) return;

    const sourceStat = statSync(source);
    if (!sourceStat.isDirectory()) {
      // 单文件：只有 worktree 里没有时才补
      const dest = join(worktreePath, relativePath);
      if (!existsSync(dest)) {
        mkdirSync(join(dest, '..'), { recursive: true });
        cpSync(source, dest, { recursive: true });
      }
      return;
    }

    mkdirSync(join(worktreePath, relativePath), { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const childRel = join(relativePath, entry.name);
      if (entry.isDirectory()) {
        this.copyMissingIntoWorktree(worktreePath, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const dest = join(worktreePath, childRel);
      if (existsSync(dest)) continue; // worktree 已有 —— agent 的产出，不动
      mkdirSync(join(dest, '..'), { recursive: true });
      cpSync(join(this.repoRoot, childRel), dest, { recursive: true });
    }
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

  /**
   * `git worktree remove` 带重试。
   *
   * 为什么需要重试（D-65，nimrtc-zelto v4 实测）：
   *
   * Windows 上 worktree 里常驻着构建产物（`build/tests/Debug/*.exe`、
   * `msquic.dll`）。agent 刚跑完验收时，这些 exe 进程**可能还没退干净**，
   * 文件句柄还开着 —— `git worktree remove` 于是报：
   *
   * ```
   * error: failed to delete '...': Invalid argument
   * ```
   *
   * 几秒后句柄释放，目录其实完全可删。zelto 之前只尝试一次，失败就打印
   * 「请手动删除」—— 但 worktree 里躺着一整棵构建树（几个 GB），
   * 人得自己 `rmdir /s /q`。实测就是**等 20 秒后一条 rmdir 就干净了**。
   *
   * 修法：失败且报错像「文件被占用 / Invalid argument / directory not empty」时，
   * 退避重试若干次；仍失败才报错（保留原语义：不静默吞掉）。
   *
   * 判据只看**是不是占用类错误** —— 真失败（比如分支被占用）重试也没用，
   * 不该浪费人的时间。
   */
  private removeWithRetry(args: string[], target: string, errorMessage: string): void {
    const MAX_ATTEMPTS = 5;
    const RETRY_DELAY_MS = this.removeRetryDelayMs;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        this.git(args, errorMessage);
        return;
      } catch (err) {
        lastError = err;
        const detail = err instanceof WorktreeError ? (err.stderr ?? '') : String(err);
        const busy = this.isBusyRemovalError(detail);
        // 不是占用类错误 → 重试也没用，立刻抛出（保留原始报错）
        if (!busy) throw err;
        // 目录已经真的不在了 → 视为成功
        if (!existsSync(target)) {
          this.git(['worktree', 'prune'], undefined, true);
          return;
        }
        if (attempt === MAX_ATTEMPTS) break;
        this.sleep(RETRY_DELAY_MS * attempt);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new WorktreeError(errorMessage, args.join(' '), String(lastError));
  }

  /**
   * 这个失败是不是「占用类」（文件句柄被占 / cwd 锁）？
   *
   * ── 为什么需要这个判据（ZD-016 / ZD-017 的边界）────────────────────
   *
   * `remove()` 的兜底逻辑（git 侧已注销 → 直接删目录）**只能**用在
   * 占用类失败上：
   *
   *   - 占用类失败：git 是「想删但删不掉」，它可能**已经摘了登记**
   *     （git 先摘登记再删目录）。这时目录残留、登记已无 → 直接删目录安全。
   *
   *   - 非占用类失败：git 是「压根不认 / 拒绝删」—— 这是 git 的**真错误**
   *     （分支被占用、路径非法、权限不足…）。此时兜底等于**改写 git 的错误**，
   *     把一个需要人看的真问题掩盖成「删掉了」。D-67 的契约明确要求：
   *     非占用类错误**立刻抛出，不许被兜底吞掉**。
   *
   * 判据与 `removeWithRetry` 里那份**必须一致** —— 两处判据分叉的后果是
   * 「重试时当成占用类，兜底时当成非占用类」（于是占用类错误直接抛出去，
   * 白白丢掉 ZD-016 的修复）或反过来（于是 git 的真错误被吞掉）。
   *
   * 抽成一份函数，两边共用。
   */
  private isBusyRemovalError(detail: string): boolean {
    return /Invalid argument|being used by another process|cannot access|directory not empty|资源正被|另一个程序/i.test(
      detail,
    );
  }

  /** 同步阻塞等待（Node 内置，无第三方依赖） */
  private sleep(ms: number): void {
    const shared = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(shared), 0, 0, ms);
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

  /**
   * `git worktree add`，带一次失效登记的自愈重试。
   *
   * 为什么需要（ADR-056 真实项目验证）：
   *
   * 人手动删掉工作目录、或上一次跑崩了留下半个目录时，git 的 worktree
   * 登记还在 —— 下一次 `git worktree add` 直接报：
   *
   * ```
   * fatal: '<path>' is a missing but already registered worktree
   * ```
   *
   * 目录确实不存在（`existsSync` 为假 → 走「创建」路径），但 git 那边
   * 认为它还占着位置，于是**永远建不出来**。zelto 从此卡死在这个版本上。
   *
   * 自愈：失败且报「already registered」→ `git worktree prune`
   * 清掉失效登记 → 重试一次。
   *
   * prune 只清**目录已不存在**的登记（git 自己判定），
   * 不会误删活着的 worktree。
   */
  private addWorktree(args: string[], errorMessage: string): void {
    try {
      this.git(args, errorMessage);
      return;
    } catch (err) {
      const detail = err instanceof WorktreeError ? (err.stderr ?? '') : String(err);
      if (!/already registered worktree|missing but already registered/i.test(detail)) {
        throw err;
      }
      // 登记是失效的 —— prune 掉，再试一次
      this.git(['worktree', 'prune'], undefined, true);
      this.git(args, errorMessage);
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

  /**
   * 某个 commit 在某个 submodule 的**本地**对象库里存在吗？
   *
   * 判据：`git cat-file -e <sha>` —— 只读本地对象库，
   * **不触网**（C3），也不修改任何东西。
   *
   * 为什么不用 `git rev-parse <sha>^{commit}`：那会做**引用解析**，
   * 在「对象在库里但不是一个 commit」时给出别的答案；
   * `cat-file -e` 只问「这个对象在不在」。
   *
   * **为什么必须设 `GIT_WORK_TREE`**（实测踩坑，2026-11-22）：
   *   独立嵌套克隆（submodule 的 `.git` 是**目录**）的 config 里有
   *   `core.worktree` —— 通常是**相对路径**（`../../../../vendor/lib`）。
   *   git 在任何 git 命令前都会 chdir 到它；从别的 cwd 进去就找不到：
   *     fatal: cannot chdir to '../../../../vendor/lib': No such file or directory
   *   于是明明有那个 commit，却判成「没有」→ **误拦一个好的工程**。
   *
   *   设 `GIT_WORK_TREE` 把那个相对路径**顶掉**（环境变量优先于 config），
   *   git 就不再去 chdir 那个陈旧的路径。
   *
   *   `-c core.worktree=…` **不管用** —— chdir 发生在读 config 之后，
   *   命令行覆盖救不了它（实测过）。
   *
   * @param subPath submodule 的**工作树**路径（`<主仓>/<sub.path>`）。
   */
  private commitAvailable(subPath: string, sha: string): boolean {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
        cwd: subPath,
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_WORK_TREE: subPath },
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 跑一条**离线**的 git 命令 —— 绝不触网，且有硬超时。
   *
   * 为什么需要（C3 + 实测于 nimrtc v1.4，2026-11-20）：
   *
   * `git submodule update --init` 在「本地缺目标 commit」时会去 **fetch**。
   * fetch 的对象是 `.gitmodules` 里写的远程 URL —— 那是**公网**。
   * 于是判定路径（worktree 准备）居然在联网，直接违反 C3
   * 「`core/` 不触网、判定只读文件、纯计算」。
   *
   * 更糟的是**挂住**而不是失败：
   *   - SSH 通向公网仓库但没配 key → 一直等确认/等密码；
   *   - HTTPS 极慢 → 几十秒才回来；
   *   - 全局 `url.<x>.insteadOf` 把 https 改写成 ssh → 变成第一种。
   * 实测：14 个 submodule 串行同步耗时 **127 秒**，其中两个各挂满 60 秒。
   * 而 Web 驾驶舱只给 `zelto run --detach` 30 秒（`adapters/web/throttle.ts`），
   * 于是 Web 端先杀 CLI 进程 → 切片卡在 `running` → 人只看到
   * 「发起运行超时（30 秒）」，而一个 agent 都没起过。
   *
   * 所以这里做三件事：
   *   1. **禁网**：`GIT_TERMINAL_PROMPT=0`（不等密码）+ `GIT_ASKPASS`/`SSH_ASKPASS`
   *      置空 + `GIT_SSH_COMMAND` 带 `BatchMode=yes`（不等确认）——
   *      这些让任何一次触网尝试**立刻失败**而不是挂住；
   *   2. **限时**：`submoduleTimeoutMs`（默认 15 秒）—— 挂住也只挂到这里；
   *   3. **`--no-fetch`**：明确告诉 git 不要去取 —— 本地有就用本地的，
   *      本地没有就**如实失败**（由调用方记成 skipped）。
   *
   * 本地有目标 commit 时，这条路径实测 14 个 submodule 共约 1 秒。
   */
  private gitOffline(args: string[], cwd: string, timeoutMs: number): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // 不弹密码提示（没有终端时它会挂住等输入）
        GIT_TERMINAL_PROMPT: '0',
        // 不弹 GUI 凭据框（Windows 上会挂住等点击）
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
        // SSH 一律非交互（BatchMode=yes → 缺 key 时立刻失败，不等确认）
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
      },
    });
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

/**
 * 把 submodule 同步的失败归类成一句人话。
 *
 * 为什么需要分类（实测：nimrtc v1.4，2026-11-20）：
 * 同一条「submodule 没同步上」有三种成因，修法完全不同：
 *
 *  1. `unable to read tree (<sha>)` —— **本地 module git 目录里没有这个
 *     commit**。git 本来要去远程取，而我们用 `--no-fetch` 把它掐断了。
 *     修法：在主仓里 `git submodule update --init` 把 commit 补到本地。
 *  2. 超时（ETIMEDOUT）—— git 卡在网络上。修法：查网络/SSH 配置。
 *  3. 其它 —— 贴原始 stderr，别装懂。
 *
 * 第 1 类是绝大多数情况（12/14），也是最容易被误读成「源码丢了」的一类 ——
 * 所以必须单独识别出来。
 *
 * **同一故障条件，git 在不同平台上的措辞不同**（实测）：
 *   - Windows：`fatal: '<...>/.git/modules/vendor/sub' does not appear to be a
 *     git repository`，紧跟一句 `fatal: Could not read from remote repository.`
 *   - Linux：  `fatal: repository '<...>/.git/modules/vendor/sub' does not exist`
 *
 * 而 Windows 那句「Could not read from remote」是**误导**的 ——
 * zelto 把 submodule 的克隆源指向主仓里的**本地** module git 目录，
 * 那个「remote」其实是我们指定的本地路径。
 *
 * 所以判据按**故障条件**写（报错里有没有提到本地 module 目录），
 * 不按**某个平台的措辞**写。只认一种措辞 = 换个平台就退化成「贴原文」，
 * 人拿不到那条可执行的修法 —— 而这条修法恰恰是这类故障最值钱的部分。
 */
/**
 * 「本地缺钉死的子模块 commit」这条错误的**人话版本**。
 *
 * 为什么要有这个函数（ADR-095 §3.1）：报错信息必须**给可执行的修法**，
 * 不能只说「失败了」。三种成因的修法完全不同：
 *
 *   1. commit 在**远程**仓库里 → fetch 远程
 *   2. commit 在**别的本地副本**里 → fetch 那个副本
 *   3. 主仓 index 记的 commit **本来就是错的** → 修正主仓
 *
 * 只给一句「本地没有这个 commit」，人会去瞎试 —— 试错了就是几十分钟。
 */
export function missingSubmoduleCommitMessage(
  subPath: string,
  sha: string,
  repoRoot: string,
): string {
  const subDir = join(repoRoot, subPath);
  const short = sha.slice(0, 8);

  return [
    `本地 module git 目录里没有 index 记录的 commit ${short}（submodule: ${subPath}）`,
    '',
    '这个 worktree 的 vendor 目录会是空的 —— 门禁②的 build 阶段必然失败，',
    '而且报错会指向「找不到头文件」，与真正的原因无关。所以在这里就停下。',
    '',
    '三种修法，按适用场景选：',
    `  1) 该 commit 在远程仓库里（推荐）：`,
    `     git -C "${subDir}" fetch origin ${sha}`,
    `  2) 该 commit 只在别的本地副本里：`,
    `     git -C "${subDir}" fetch <那个副本的路径> ${sha}`,
    '  3) 主仓 index 记录的 commit 本来就是错的（少见）：',
    '     在主仓里 git submodule update --init 修正后重新建 worktree',
    '',
    `补齐后重建 worktree 即可（zelto 会重新校验）。`,
  ].join('\n');
}

export function describeSubmoduleFailure(err: unknown): string {
  // 错误对象可能是 Error，也可能只是 `{ message, stderr }` 形态的普通对象
  // （execFileSync 抛的就是后者）—— 两种都要认，否则错误信息会变成
  // 毫无意义的 '[object Object]'。
  const raw = err as { message?: unknown; stderr?: Buffer | string } | null | undefined;
  const message =
    err instanceof Error
      ? err.message
      : typeof raw?.message === 'string'
        ? raw.message
        : typeof err === 'string'
          ? err
          : '';
  const stderr = raw?.stderr;
  const detail = stderr ? String(stderr).trim() : '';
  const combined = `${message}\n${detail}`;

  if (/ETIMEDOUT|timed out|timeout/i.test(combined)) {
    return '同步超时（git 卡在网络上）—— 检查网络与 SSH 配置';
  }

  // ── 本地 module git 目录不可用（最常见，12/14）────────────────────
  //
  // 判据：**报错里出现了本地 module git 目录的路径**。
  //
  // 为什么按路径判、而不按措辞判：zelto 明确把 submodule 的克隆源指向
  // 主仓里的本地 module git 目录（`submodule.<name>.url=<本地路径>`），
  // 所以**任何提到那个路径的失败都是本地问题**，跟 git 怎么说无关。
  //
  // git 在两个平台上的措辞完全不同（实测）：
  //   - Windows：`fatal: '<path>' does not appear to be a git repository`
  //               紧跟一句 `fatal: Could not read from remote repository.`
  //   - Linux：  `fatal: repository '<path>' does not exist`
  //
  // 而 Windows 那句「Could not read from remote」是**误导**的 ——
  // 那个「remote」其实是我们指定的本地路径。只看措辞必然一边错一边漏。
  //
  // 所以判据是「有没有提到本地 module 目录」，措辞只用来确认「确实是指它」。
  const mentionsLocalModuleDir = /\.git[/\\]modules/i.test(combined);
  const localModuleDirBroken = new RegExp(
    [
      'does not appear to be a git repository',
      'does not exist',
      'unable to read tree',
      'does not contain',
      'not a git repository',
    ].join('|'),
    'i',
  ).test(combined);

  if (mentionsLocalModuleDir && localModuleDirBroken) {
    return (
      '本地 module git 目录里没有 index 记录的 commit —— ' +
      '在主仓里执行 `git submodule update --init` 把依赖补到本地后重试'
    );
  }

  // ── 远程真的不可达 ────────────────────────────────────────────────
  //
  // 到这里还没有本地路径 —— 那失败说的是**远端**（凭据 / 网络 / 权限）。
  // 与上一类的修法完全不同，混起来会把人引去跑一条没用的命令。
  //
  // 注意 `Could not read from remote repository` 必须放在**后面**：
  // Windows 上本地 module 目录坏掉时 git 也会说这句话（措辞误导）。
  if (
    /Could not read from remote|Permission denied|Authentication failed|could not resolve host|Connection refused|unable to access/i.test(
      combined,
    )
  ) {
    return '没有权限访问 submodule 的远程仓库 —— 检查凭据配置';
  }

  // ── 本地缺 commit，但措辞不含路径线索 ──────────────────────────────
  //
  // `could not read <sha>` 形态（`unable to read tree` 的近亲）。
  if (/unable to read tree|does not contain|could not read/i.test(combined)) {
    return (
      '本地 module git 目录里没有 index 记录的 commit —— ' +
      '在主仓里执行 `git submodule update --init` 把依赖补到本地后重试'
    );
  }

  return detail || message || '未知原因';
}
