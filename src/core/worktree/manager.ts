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

/**
 * 版本工作目录 base（相对仓库根）。
 *
 * 刻意与 `WORKTREE_BASE_DIR` 分开（ADR-056 §3.1）：`list()` 按路径里的
 * `.zelto/worktrees/` 标记反解 sliceId，版本目录混进去会被误认成切片
 * worktree，进而被切片清理逻辑误删。另起一个 base 就不用改那个解析。
 */
export const VERSION_WORKTREE_BASE_DIR = join('.zelto', 'version-worktrees');

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

  /**
   * 移除 worktree 时的重试间隔（毫秒）。
   *
   * 可被测试改小 —— 生产值 3s 是为了让 Windows 上的文件句柄有时间释放。
   */
  removeRetryDelayMs = 3_000;

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

  // ─── 版本工作目录（ADR-056）───────────────────────────────────────────────

  /**
   * 版本工作目录的绝对路径。
   *
   * 与切片 worktree 分开落在 `.zelto/version-worktrees/<label>/`——
   * 见 `VERSION_WORKTREE_BASE_DIR` 的说明。
   */
  versionPathFor(label: string): string {
    return join(this.repoRoot, VERSION_WORKTREE_BASE_DIR, label);
  }

  /** 版本工作目录的相对仓库根路径 */
  versionRelativePathFor(label: string): string {
    return join(VERSION_WORKTREE_BASE_DIR, label);
  }

  /** 该版本是否已有工作目录 */
  versionExists(label: string): boolean {
    return existsSync(this.versionPathFor(label));
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
   */
  async removeVersionWorktree(label: string, options: { force?: boolean } = {}): Promise<void> {
    const target = this.versionPathFor(label);
    if (!existsSync(target)) {
      this.git(['worktree', 'prune'], '清理 worktree 登记失败');
      return;
    }

    this.unlinkNodeModules(target);

    const args = ['worktree', 'remove'];
    if (options.force) args.push('--force');
    args.push(target);

    this.removeWithRetry(args, target, `移除版本工作目录失败: ${this.versionRelativePathFor(label)}`);
    this.git(['worktree', 'prune'], '清理 worktree 登记失败');
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
            'submodule', 'update', '--init', sub.path,
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

    // 嵌套 submodule：主仓的 module git 目录做本地克隆源，不联网。
    this.syncNestedSubmodules(worktreePath, submodules.map((s) => s.path));

    return { initialized, skipped };
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
        const moduleGitDir = [
          join(this.repoRoot, '.git', 'modules', ...topPath.split('/'), 'modules', ...sub.path.split('/')),
          join(this.repoRoot, '.git', 'modules', ...topPath.split('/'), 'modules', ...sub.name.split('/')),
        ].find((dir) => existsSync(dir));
        if (!moduleGitDir) continue;

        // 顶层 submodule 在 worktree 里的位置 —— 嵌套层要挂在它下面
        const topDest = join(worktreePath, topPath);
        if (!existsSync(topDest)) continue;

        try {
          this.git(
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
              'submodule', 'update', '--init', sub.path,
            ],
            undefined,
            false,
            topDest,
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
    if (options.force) args.push('--force');
    args.push(target);

    this.removeWithRetry(args, target, `移除 worktree 失败: ${relative(this.repoRoot, target)}`);
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
        const busy =
          /Invalid argument|being used by another process|cannot access|directory not empty|资源正被|另一个程序/i.test(
            detail,
          );
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
}

/** 判断路径是否已存在且是目录 */
export function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
