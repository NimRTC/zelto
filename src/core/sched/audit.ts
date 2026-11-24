// Write-set audit — 运行后的写集兜底审计
//
// C1: 状态只在文件里；这里只读 git，不写任何状态
// C2/C6: 只用 Node 内置模块，不依赖 adapters/
// C3: 纯本地判定，不调模型、不触网
//
// 为什么需要它：PreToolUse hook 能拦「声明出来的写」和「静态可见的 shell 写目标」，
// 但拦不住 `node -e "fs.writeFileSync(...)"` 这类任意解释器里的写。
// 运行结束后拿 git 的真实改动再对一次写集，就把漏网的写补上了（ADR-014 §5）。
//
// 这不是操作系统沙箱 —— 真正的隔离需要特权进程，zelto 不做那件事。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathInWriteSet } from './paths.js';

/**
 * zelto 自己写进 worktree 的文件。
 *
 * 这些文件不该被算成「agent 的越界写入」，但它们的**内容**必须原样 ——
 * agent 改掉 hook 设置就等于关掉了门禁，所以内容对不上就是篡改。
 */
export interface ManagedFile {
  /** 相对 worktree 的路径（正斜杠） */
  path: string;
  /** 期望内容哈希（`sha256:<hex>`） */
  hash: string;
}

export interface AuditOptions {
  /** 建分支时的基点；给了就把「已提交的改动」也算进来 */
  baseCommit?: string | null;
  /** zelto 托管的文件：路径不计入越界，但内容被改动即视为篡改 */
  managed?: ManagedFile[];
  /**
   * 运行开始时 worktree 就已经脏的路径（相对 worktree，正斜杠）。
   *
   * 为什么需要：nimrtc-zelto 实测 D-29 —— 主仓工作区里
   * `src/third_party/msquic` 本来就是 `-dirty`（嵌套 submodule
   * `submodules/quictls` 被改过），worktree 建出来继承了这份脏。
   * agent 碰都没碰它，审计却把它算成「本片的越界写入」，
   * 切片直接被打回 frozen。预置脏不是 agent 写的，不该判越界。
   *
   * 语义：只从 `violations` 里排除，`changed` 里照样列出（可审计）。
   * 同一文件 agent 又改了也无法区分 —— 保守起见一律不判，
   * 与「无 worktree 时不审计」的 fail-open 方向一致（误报比漏报贵）。
   */
  baselineChanged?: string[];
  /**
   * 本片 id（ADR-067 D3）。
   *
   * 给了就**只把本片自己产出的提交**算进审计范围 ——
   * 判据是 commit message 里的 `Refs-Slice: <id>` trailer
   * **或**标题 `feat(<id>): slice approved`（D-69：trailer 会丢，标题不会）。
   *
   * 不给就退回「基点..HEAD 的全部提交」（老行为）。这个行为在
   * 切片分支被别的东西推进过时时会误报：那些提交不是本片 agent 写的，
   * 却会被算成「本片的越界写入」（实测 D-28）。
   */
  sliceId?: string | null;
}

export interface WriteAuditResult {
  /** worktree 里所有相对路径的改动 */
  changed: string[];
  /** 落在写集之外的改动 */
  violations: string[];
  /** 内容被改动的 zelto 托管文件 */
  tampered: string[];
  /** git 调用失败时的说明（不抛异常，调用方自行决定怎么处理） */
  error: string | null;
  /**
   * 审计**没能覆盖到本片已提交改动**时的说明（D-69）。
   *
   * 非 null 有两种含义，**必须分清**：
   *
   *  1. `error` 非 null —— 提交历史**读不出来**（git 调用失败）。
   *     此时「已提交部分」确实没被审计，**必须 fail closed**：
   *     看不见不等于没有（fail open）。
   *
   *  2. `error` 为 null、只有本字段非 null —— 有提交**没写明归属**
   *     （既没有 trailer 也没有标题约定）。
   *     这些提交的改动**已经按「疑似本片」纳入审计范围**，
   *     所以边界是**确定**的 —— 此时**不该**拒绝放行：
   *     否则一次成功的运行会被误判成越界（ADR-067 D3 的正常场景里
   *     基点之后本来就有别片的提交）。
   *     本字段此时只表达「**追溯链有断节**」，用于留痕与提示。
   */
  coverageGap?: string | null;
}

/**
 * 跑一条 git 命令。
 *
 * 统一加上 `core.quotePath=false`：默认配置下 git 会把非 ASCII 路径转义成
 * 八进制并加引号（`"docs/\346\212\200.md"`），后面每次用都得先解码，
 * 漏掉一处路径就错了。关掉引号后路径原样输出。
 */
function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * 跑一条 git 命令，超时就**重试**。
 *
 * ── 为什么超时值得重试 ──────────────────────────────────────────────────
 *
 * 60 秒超时撞上的是**冷缓存**，不是「git 坏了」：
 * 刚建出来的 worktree 上，索引/对象库都还没热起来，
 * `git diff --name-only` 要把整个工作树 stat 一遍，冷缓存下能跑到几百秒
 * （实测 nimrtc-v14，2026-11-23：worktree 刚建好时三条 git 命令合计 >60s，
 * 热起来之后同样的命令只要 0.3~0.4 秒）。
 *
 * 超时是**瞬时**状态，不是「读不出来」。D-61 要求的是
 * 「判不出来要 fail closed」—— 但「第一次读超时、第二次能读出来」
 * 并不是判不出来，是**抖动**。直接抛错会让一个完全正常的工程
 * 因为冷缓存而拒绝开工（D-61 的教训本意是防「假装干净」，
 * 不是防「抖动」）。
 *
 * 所以这里重试；**重试仍然失败才抛**。fail closed 的语义没变：
 * 最终读不出来 → 抛错 → 基线不明 → 拒绝开工。
 */
function gitWithRetry(args: string[], cwd: string, attempts = 3): string {
  return runWithTimeoutRetry(() => git(args, cwd), attempts);
}

/**
 * 重试「瞬时失败」的通用包装。
 *
 * 只对**超时/资源类**错误重试：git 自己报错（比如「不是 git 仓库」）
 * 重试再多次也是同样的结果，重试只是浪费时间。
 *
 * 重试全部失败后把最后一个错误抛出去 —— fail closed 的语义没变。
 *
 * @param run 实际要跑的动作
 * @param attempts 最多尝试次数（含第一次）
 */
export function runWithTimeoutRetry<T>(run: () => T, attempts = 3): T {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return run();
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ETIMEDOUT' && code !== 'ENOBUFS' && code !== 'EAGAIN') {
        throw err;
      }
    }
  }
  throw lastError;
}

/** git 的 C 风格转义与字节值。 */
const GIT_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  '\\': 0x5c,
};

/**
 * 解码 git 对特殊字符路径的 C 风格引号。
 *
 * git 把非 ASCII 字节转义成八进制（`\346\212\200`），这**不是** JSON 转义，
 * 所以 `JSON.parse` 会失败。早期的实现因此把中文路径整个当成乱码留在字符串里，
 * 审计时把正常文件判成越界、把越界文件判不出来。
 *
 * 解出来的是字节序列，最后按 UTF-8 还原成字符串。
 */
export function decodeGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;

  const body = path.slice(1, -1);
  const bytes: number[] = [];

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];

    if (ch !== '\\') {
      const code = body.codePointAt(i) ?? 0;
      bytes.push(...Buffer.from(String.fromCodePoint(code), 'utf-8'));
      if (code > 0xffff) i += 1; // 代理对占两个 UTF-16 码元
      continue;
    }

    const next = body[i + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }

    // \uXXXX —— JSON 风格的 Unicode 转义（占 6 个字符：反斜杠、u 和 4 位十六进制）
    if (next === 'u') {
      const hex = body.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        bytes.push(...Buffer.from(String.fromCharCode(Number.parseInt(hex, 16)), 'utf-8'));
        i += 5;
        continue;
      }
    }

    // \NNN —— git 的八进制字节转义
    if (next >= '0' && next <= '7') {
      const octal = body.slice(i + 1, i + 4);
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      i += 3;
      continue;
    }

    const escaped = GIT_ESCAPES[next];
    if (escaped !== undefined) {
      bytes.push(escaped);
      i += 1;
      continue;
    }

    // 认不出来的转义：原样保留反斜杠
    bytes.push(0x5c, ...Buffer.from(next, 'utf-8'));
    i += 1;
  }

  return Buffer.from(bytes).toString('utf-8');
}

/**
 * 解析 `git status --porcelain` 的输出，取出路径。
 */
export function parsePorcelainStatus(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    if (line.startsWith('!!')) continue; // ignored
    let filePath = line.slice(3).trim();
    if (!filePath) continue;
    // 重命名：`old -> new`
    const arrow = filePath.indexOf(' -> ');
    if (arrow >= 0) filePath = filePath.slice(arrow + 4);
    filePath = decodeGitPath(filePath);
    paths.push(filePath.replace(/\\/g, '/'));
  }
  return paths;
}

/**
 * 判断一个「脏」路径是不是**只有 submodule 的 `-dirty` 标记**。
 *
 * 病灶（实测于 nimrtc-zelto，2026-11-17）：
 *   `git status --porcelain` 报 ` M src/third_party/msquic`，
 *   但 `git diff` 显示的只有：
 *
 *     -Subproject commit a5ae3a06ed6e3c054c251892370801db98d85174
 *     +Subproject commit a5ae3a06ed6e3c054c251892370801db98d85174-dirty
 *
 *   **指针一模一样**，只多了 `-dirty` —— 意思是「submodule 内部有未提交的
 *   改动」（nimrtc 的 msquic 里嵌着 quictls，CRLF 换行导致的经典假脏）。
 *
 *   这不是「人改了代码还没提交」—— 主仓的 gitlink 指针没动，
 *   合并**不会碰它**，也不会盖掉任何东西。
 *
 *   但合并守卫只看 `git status --porcelain`，于是判成「工作区不干净」→
 *   合并被拦下 → **每一片都合不进去**（实测：v2-input-binder 签字通过却合不了）。
 *
 * 判据：diff 里只有 `-dirty` 后缀，commit 指针不变 → 判「不算脏」。
 *
 * **保守方向**：指针变了（真的换了 submodule 版本）→ 判「脏」（拦住）。
 * 判不出来（git 调用失败 / 路径不是 submodule）→ 判「脏」（拦住）。
 * 误报（拦住一次本来能合的）比漏报（盖掉人的未提交改动）便宜。
 *
 * @param repoRoot git 仓库根
 * @param path 相对仓库根的路径（正斜杠）
 */
export function isSubmoduleOnlyDirty(repoRoot: string, path: string): boolean {
  try {
    // 只看这一个路径的 diff；--submodule=short 给出 `Subproject commit ...` 形态
    const out = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'diff', '--submodule=short', '--', path],
      { cwd: repoRoot, encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const lines = out
      .split('\n')
      .map((l) => l.trim())
      // diff 里这两行带前导的 `-` / `+`（`-Subproject commit X` / `+Subproject commit X`）
      .filter((l) => l.startsWith('-Subproject commit ') || l.startsWith('+Subproject commit '))
      .map((l) => l.slice(1).trim());
    if (lines.length !== 2) return false;

    const before = lines[0].replace('Subproject commit ', '');
    const after = lines[1].replace('Subproject commit ', '');
    // 只多了一个 `-dirty` 后缀，commit 指针没变 → 不算脏
    return after === `${before}-dirty`;
  } catch {
    return false;
  }
}

/**
 * 判断一个「脏」路径是不是**submodule 指针与 index 记录不一致**。
 *
 * 病灶（实测于 nimrtc-v14 v1-audio-p2 合并，2026-11-21）：
 *
 *   版本工作目录 `.zelto/version-worktrees/v1` 里，
 *   `git status --porcelain` 报 11 个 ` M src/third_party/<x>`，
 *   合并守卫判成「目标工作区有未提交改动」→ **合并被拦下**。
 *
 *   但那 11 条**不是人改的代码**：
 *     - index 里记录的 gitlink 是 `22244de5`（version/v1 分支上的旧指针）
 *     - 而工作区里那个 submodule **实际 checkout 的是** `acdb9e26`
 *       （主仓工作区当前在的那个 commit）
 *
 *   也就是说：**主仓工作区里 submodule 被切过 commit**，
 *   worktree 建出来时继承了这个状态。`alignSubmodulesToMainRepo`
 *   本该把它对齐回 index 记录的指针，但它 `checkout --force` 失败了
 *   —— 目标 commit 的对象**不在本地**（`--no-fetch` 不触网，C3 要求）。
 *
 *   判据为什么重要：合并**只碰待合分支改过的路径**
 *   （`git diff version/v1 slice/v1-audio-p2` 里根本没有 `src/third_party`）。
 *   工作区里 submodule 的指针状态与这次合并**无关** ——
 *   拦住它等于「因为仓库里有一处与本次无关的不一致，就把这次合并也拦下」。
 *
 * 判据：
 *   1. 该路径在 index 里是 gitlink（mode 160000）→ 确实是 submodule；
 *   2. 工作区里那个 submodule 实际 checkout 的 commit 与 index 记录的不一致
 *      （含「工作区里根本没有 .git、不是仓库」这种更明显的错位）。
 *
 * 方向：**只豁免「指针错位」这一种形态**。
 * 「submodule 内部有未提交改动」（`-dirty`）由 `isSubmoduleOnlyDirty` 管。
 * 两者都不豁免「人真的改了 submodule 指向的源码」—— 那种情况
 * `git diff` 会报出具体的文件，不是指针错位。
 *
 * @param repoRoot 仓库根（版本工作目录或主仓）
 * @param path 相对仓库根的路径（正斜杠）
 */
export function isSubmodulePointerMismatch(repoRoot: string, path: string): boolean {
  try {
    // index 里记的 gitlink
    const recorded = execFileSync(
      'git',
      ['ls-files', '-s', '--', path],
      { cwd: repoRoot, encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const match = recorded.match(/^160000 ([0-9a-f]{40})/);
    if (!match) return false; // 不是 gitlink → 不是 submodule
    const target = match[1];

    // 工作区里那个 submodule 实际 checkout 的 commit
    const subDir = join(repoRoot, path);
    if (!existsSync(subDir)) return false;
    const head = execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: subDir, encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(head)) return false;

    return head !== target;
  } catch {
    // 读不出来 → 保守判成「不是指针错位」→ 维持拦截。
    // 误报（拦住一次本来能合的）比漏报（盖掉人的真实改动）便宜。
    return false;
  }
}

/** 计算文件内容哈希（`sha256:<hex>`）；文件不存在时返回 null。 */
export function hashFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  } catch {
    return null;
  }
}

/**
 * 列出目录下所有文件的相对路径（正斜杠）。
 *
 * 用来把「zelto 自己复制进 worktree 的目录」（例如验收目录）登记成托管文件：
 * 目录本身不是文件，审计要的是里面每一个文件。
 *
 * 目录不存在时返回空数组 —— 切片可能还没有验收测试。
 */
export function listFilesUnder(root: string, relativeDir: string): string[] {
  const base = resolve(root, relativeDir);
  if (!existsSync(base)) return [];

  const results: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full);
      } else {
        results.push(relative(resolve(root), full).replace(/\\/g, '/'));
      }
    }
  };

  walk(base);
  return results.sort();
}

/**
 * 分支上属于某个切片的提交（ADR-067 D3）。
 *
 * 判据：commit message 里有 `Refs-Slice: <sliceId>` trailer
 * **或**标题是 `feat(<sliceId>): slice approved`。
 *
 * 两个判据不是冗余，是**互为兜底**（D-69）：
 *
 *  - trailer 是精确声明，但它**会丢** —— Windows 上 `execSync` 走 cmd.exe，
 *    命令里的换行被当成命令分隔符，`git commit -m "a\n\nb"` 实际只拿到
 *    第一行，trailer 被静默吞掉（实测 nimrtc-zelto：全部切片提交都没了 trailer）。
 *  - 标题 `feat(<id>): slice approved` 是 zelto 自己的提交约定，
 *    **它自己写、不会被 cmd 吃掉**（标题就是第一行）。
 *
 * 只认 trailer 时，trailer 一丢 → 本片的提交**全部看不见** →
 * 审计的 changed 变空 → violations 变空 → **越界被放行**（fail open）。
 * 这是 C9 的兜底判据失效，不是「记录不全」那么轻。
 *
 * 为什么需要按提交过滤：审计要回答「本片 agent 改了什么」。
 * 分支上的提交可能不全来自本片 —— 基点错了、或运行期间有人把别的
 * 分支合进来时，那些提交会被误算成「本片的越界写入」（实测 D-28）。
 *
 * @param repoRoot 仓库根
 * @param baseCommit 起点 commit（不含）
 * @param headCommit 终点 commit（含）
 * @param sliceId 切片 id
 * @returns 本片产出的 commit 列表（从旧到新）
 */
export function commitsOfSlice(
  repoRoot: string,
  baseCommit: string,
  headCommit: string,
  sliceId: string,
): string[] {
  return sliceCommits(repoRoot, baseCommit, headCommit, sliceId).own;
}

/**
 * 基点之后的提交，按归属分类（D-69）。
 *
 * 「本片的」= 提交信息明确声明了本片 id（trailer 或标题约定）。
 * 「别人的」= 明确声明了**别的**切片 id —— 这些不是本片 agent 写的，
 *   不该算成「本片的越界写入」（ADR-067 D3，实测 D-28）。
 * 「说不清的」= 提交信息里**没有任何切片声明** —— 这才是真正的盲区：
 *   它的改动既可能是本片的，也可能不是。审计必须**把它也纳入范围**
 *   （宁可多看，不可漏看），而不是当作「不是本片的」放过去。
 */
export interface SliceCommits {
  /** 明确声明了本片 id 的提交 */
  own: string[];
  /** 明确声明了别的切片 id 的提交 */
  foreign: string[];
  /** 没有任何切片声明的提交（盲区） */
  unattributed: string[];
  /** git log 读不出来时的说明（null = 读到了） */
  error: string | null;
}

/**
 * 分类基点之后的提交。
 *
 * 与 `commitsOfSlice` 的区别：后者只回答「哪些是本片的」，
 * 这一个额外回答「哪些是别的片的」与「哪些说不清」——
 * 后两者合起来正好是「基点之后的全部提交」。
 */
export function sliceCommits(
  repoRoot: string,
  baseCommit: string,
  headCommit: string,
  sliceId: string,
): SliceCommits {
  let log: string;
  try {
    log = git(
      ['log', '--format=%H%x00%B%x00%x00', `${baseCommit}..${headCommit}`],
      repoRoot,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 读不出来**必须**说出来 —— 静默返回空 = 「已提交部分没被审计」
    // 却被当成「没有越界」（fail open）。见 D-69。
    return {
      own: [],
      foreign: [],
      unattributed: [],
      error: `读取提交历史失败: ${message}`,
    };
  }

  const own: string[] = [];
  const foreign: string[] = [];
  const unattributed: string[] = [];

  // 格式：<hash>\0<body>\0\0<hash>\0<body>\0\0 ...
  const records = log.split('\0\0');
  for (const record of records) {
    if (!record.trim()) continue;
    const sep = record.indexOf('\0');
    if (sep < 0) continue;
    const hash = record.slice(0, sep).trim();
    const body = record.slice(sep + 1);
    if (!hash) continue;

    const ids = declaredSliceIds(body);
    if (ids.length === 0) {
      unattributed.push(hash);
    } else if (ids.includes(sliceId)) {
      own.push(hash);
    } else {
      foreign.push(hash);
    }
  }

  // git log 是从新到旧；反转成从旧到新（diff 累积时顺序不影响结果，
  // 但可读性与调试体验更好）
  const rev = (a: string[]): string[] => a.reverse();
  return { own: rev(own), foreign: rev(foreign), unattributed: rev(unattributed), error: null };
}

/**
 * 提交信息里声明的切片 id（全部）。
 *
 * 两种声明形态：
 *
 *  1. `Refs-Slice: <id>` trailer（也可写成 `Refs-Slices: <id>, <id>`）
 *  2. zelto 自己的提交约定：`feat(<id>): slice approved` 标题
 *     与 `Merge slice <id>` 标题
 *
 * 为什么 trailer 也要认复数形态（`Refs-Slices:`）：
 * squash 合并会把多片的提交压成一条，那条提交里写的是复数 trailer。
 * 它是**明确声明**了归属，不能当成「认不出来」。
 *
 * trailer 的值可能是一串（`v1-a, v2-b`），要拆开逐个比对 ——
 * 精确匹配，`v1-a` 不能匹配 `v1-ab`。
 */
export function declaredSliceIds(message: string): string[] {
  const ids: string[] = [];
  const text = message ?? '';

  // 1. trailer：`Refs-Slice:` / `Refs-Slices:`
  const trailerPattern = /^Refs-Slices?:\s*(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = trailerPattern.exec(text)) !== null) {
    for (const part of match[1].split(/[,;\s]+/)) {
      const id = part.trim();
      if (id) ids.push(id);
    }
  }

  // 2. 标题约定
  const subject = text.split('\n', 1)[0].trim();
  const feat = /^feat\(([^)]+)\): slice approved$/.exec(subject);
  if (feat) ids.push(feat[1].trim());
  const merge = /^Merge slice (.+)$/.exec(subject);
  if (merge) ids.push(merge[1].trim());

  return ids;
}

/**
 * 判断一条 commit message 是否声明「由某个切片产出」。
 *
 * trailer 格式：`Refs-Slice: <id>`（大小写不敏感的 key，
 * 值精确匹配 —— `v1-a` 不能匹配 `v1-ab`）。
 */
export function hasRefsSlice(message: string, sliceId: string): boolean {
  return declaredSliceIds(message).includes(sliceId);
}

/**
 * 判断一条 commit message 是否是「某个切片产出的提交」。
 *
 * 两个判据，**任一命中**即算（D-69）：
 *
 *  1. `Refs-Slice: <id>` trailer —— 精确声明，但**会丢**
 *     （Windows 上 cmd.exe 吞掉提交信息里的换行）；
 *  2. 标题 `feat(<id>): ...` —— zelto 自己的提交约定，
 *     标题就是提交信息的第一行，**不会被 cmd 吃掉**。
 *
 * 为什么必须有第 2 个：只认 trailer 时，trailer 一丢，
 * `commitsOfSlice` 就返回空 → 审计的 changed/violations 都变空 →
 * **越界被放行**（fail open）。判据不能只有一条会断的绳。
 *
 * 判据 2 精确匹配切片 id：`feat(v1-a): ...` 不能被 `v1-ab` 命中。
 */
export function isSliceCommit(message: string, sliceId: string): boolean {
  if (hasRefsSlice(message, sliceId)) return true;
  const subject = (message || '').split('\n', 1)[0].trim();
  // 标题约定只认「精确的切片 id」—— 但标题后面的说明文字随意
  // （`feat(v1-a): slice approved` 与 `feat(v1-a): agent 产出` 都算）。
  if (subject.startsWith(`feat(${sliceId}):`)) return true;
  // 合并提交也算本片的产物 —— `Merge slice <id>`（merge-executor 写的）
  if (subject === `Merge slice ${sliceId}`) return true;
  return false;
}

/**
 * 列出工作区里所有「变了的」路径（相对仓库根，正斜杠）。
 *
 * 语义与 `git status --porcelain --untracked-files=all` **等价**
 * （已修改 / 已暂存 / 已删除 / 未跟踪），但**快得多**。
 *
 * ── 为什么不用 `git status --untracked-files=all` ───────────────────────
 *
 * 实测（nimrtc-zelto，2026-11-18，刚建出来的 worktree）：
 *
 *     git status --porcelain --untracked-files=all   →  224 秒
 *     git status --porcelain                        →   12 秒
 *     git diff --name-only + git ls-files --others   →   13 秒（冷）/ 0.6 秒（热）
 *
 * 224 秒比任何合理超时都长 —— 基线快照直接被超时打断，
 * 整轮开工被拒（「基线不明就不开工」，D-61）。
 *
 * 病根在 `--untracked-files=all`：它要把**每一个**未跟踪文件单独 stat 一遍，
 * 而 nimrtc 带 googletest / msquic 两个大 submodule，冷缓存下遍历整棵树
 * 要几分钟。同一条命令缓存热了只要 0.6 秒 —— 也就是说
 * **慢的恰恰是第一次，而第一次恰恰是最不能出错的那一次**
 * （它决定后面所有审计的基线）。
 *
 * 而 `git ls-files --others --exclude-standard` 走的是**索引 + 目录项**，
 * 不逐个文件 stat，同样语义下快 17 倍。
 *
 * ── 为什么等价 ────────────────────────────────────────────────────────
 *
 * 三条命令合起来覆盖 porcelain 的全部状态：
 *   - `git diff --name-only`         → 工作区 vs 索引（已改/已删）
 *   - `git diff --cached --name-only` → 索引 vs HEAD（已暂存）
 *   - `git ls-files --others --exclude-standard` → 未跟踪（且不在 ignore 里）
 *
 * 少一条就会漏判：只留 `diff` 会漏掉未跟踪文件（agent 新建的文件），
 * 只留 `ls-files` 会漏掉已修改的文件 —— 两者都是越界写入的常见形态。
 *
 * ── 为什么读不出来要**抛错**而不是「少一路」 ──────────────────────────
 *
 * 这段代码原本是「catch 掉、少一路、继续」（D-63 初版）。那样写有个致命后果：
 *
 *   `git diff --name-only` 在**不是 git 仓库**的目录里会失败（exit 129），
 *   `git ls-files` 也会失败（exit 128）。三路全失败 → 返回**空数组**。
 *
 *   而空数组在审计那边是「**这个 worktree 什么都没改**」——
 *   `auditWorktreeWrites` 于是报 `violations: []`、`error: null`，
 *   **审计通过了**。
 *
 *   这与 C9 直接冲突：写集审计的意义是「越界就拦下」，
 *   而「git 读不出来」时它反而说「一切正常」。
 *   实测（2026-11-18，D-63 回归）：在非仓库目录里审计，
 *   `result.error` 是 null、`violations` 是空 —— 测试直接挂了。
 *
 *   「读不出来」必须当成「判不出来」，而判不出来要**fail closed**：
 *   抛错 → 上层报 `error` → 这一轮不算数（D-61 的同一条退路）。
 *
 * C3: 纯 git 判定，不调模型、不触网
 */
export function listChangedPaths(repoRoot: string): string[] {
  const paths = new Set<string>();

  const add = (raw: string): void => {
    for (const line of raw.split('\n')) {
      const p = line.trim();
      if (p) paths.add(p.replace(/\\/g, '/'));
    }
  };

  // 三条命令任一读不出来 → 抛错（fail closed）。
  //
  // 不吞异常：吞掉的后果是「审计读不到 git → 一切正常」，
  // 而那正是 C9 要防的事 —— 越界写入会在审计里消失。
  //
  // 「不是 git 仓库」这种整体失败会在这里冒出来，
  // 上层据此把这一轮判成「审计失败」而不是「没有越界」。
  add(gitWithRetry(['diff', '--name-only'], repoRoot));
  add(gitWithRetry(['diff', '--cached', '--name-only'], repoRoot));
  add(gitWithRetry(['ls-files', '--others', '--exclude-standard'], repoRoot));

  return [...paths].sort();
}

/**
 * 审计某个 worktree 的改动是否全部落在写集内。
 *
 * @param worktreeRoot worktree 绝对路径
 * @param writes 允许写入的路径（glob / 目录前缀）
 * @param options baseCommit 建分支时的基点；给了就把「已提交的改动」也算进来
 */
export function auditWorktreeWrites(
  worktreeRoot: string,
  writes: string[],
  options: AuditOptions = {},
): WriteAuditResult {
  const baseCommit = options.baseCommit ?? null;
  const managed = options.managed ?? [];
  const changed = new Set<string>();
  let coverageGap: string | null = null;

  try {
    // D-63：不用 `--untracked-files=all`（它在冷 worktree 上要 224 秒）。
    // `listChangedPaths` 用 diff + diff --cached + ls-files 三条命令，
    // 语义等价，快 17 倍。
    for (const p of listChangedPaths(worktreeRoot)) changed.add(p);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      changed: [],
      violations: [],
      tampered: [],
      error: `git status 失败: ${message}`,
      coverageGap: null,
    };
  }

  if (baseCommit) {
    // 审计要回答的是「**本片 agent 改了什么**」，不是「**本片分支上有哪些提交**」。
    //
    // 基点错了、或分支在运行期间被别的东西推进过时，
    // 「基点..HEAD 的全部提交」里会混进不是本片产出的东西 ——
    // 那些东西会被算成「本片的越界写入」（实测 D-28：上一片的三个文件
    // 经一次事后快进进了本片分支，被判成本片越界）。
    //
    // 所以给了 sliceId 就按归属分类提交（ADR-067 D3 + D-69）：
    //
    //   - **本片的**（声明了本片 id）→ 算进审计范围
    //   - **别片的**（声明了别的切片 id）→ 不算（不是本片 agent 写的）
    //   - **说不清的**（没有任何切片声明）→ **也算进审计范围**
    //
    // 最后一条是关键：说不清的提交，它的改动既可能是本片的、也可能不是。
    // 把它排除 = 有可能放过真越界（fail open）；
    // 把它算进去 = 最坏是多看几个文件（误报比漏报贵，C9 的方向）。
    const sliceId = options.sliceId ?? null;
    if (sliceId) {
      const classified = sliceCommits(worktreeRoot, baseCommit, 'HEAD', sliceId);

      if (classified.error) {
        // 提交历史读不出来 → 「已提交部分」根本没被审计到。
        // 这与「没有越界」在结果上无法区分，必须显式说出来（fail closed）。
        return {
          changed: [...changed],
          violations: [],
          tampered: [],
          error: classified.error,
          coverageGap: null,
        };
      }

      const audited = [...classified.own, ...classified.unattributed];
      for (const commit of audited) {
        try {
          const diff = git(['diff', '--name-only', `${commit}^..${commit}`], worktreeRoot);
          for (const line of diff.split('\n')) {
            const p = line.trim();
            if (p) changed.add(p.replace(/\\/g, '/'));
          }
        } catch {
          // 单个提交读不出来（根提交没有父提交等）——跳过，不影响其余
        }
      }

      // D-69：认不出归属的提交**已经纳入审计范围**了 ——
      // 所以这里不再报缺口（那会把一次成功的运行误判成越界）。
      //
      // 但「说不清」这件事本身要留痕：它说明追溯链有断节
      // （提交信息里没写自己属于哪片）。这不是越界，是**追溯不全**。
      if (classified.unattributed.length > 0) {
        coverageGap =
          `基点之后有 ${classified.unattributed.length} 条提交没写明归属` +
          `（既没有 \`Refs-Slice: <id>\` trailer，也没有 \`feat(<id>)\` 标题）—— ` +
          `它们的改动已按「疑似本片」纳入审计（保守方向），但追溯链在这里有断节`;
      }
    } else {
      try {
        const diff = git(['diff', '--name-only', `${baseCommit}..HEAD`], worktreeRoot);
        for (const line of diff.split('\n')) {
          const p = line.trim();
          if (p) changed.add(p.replace(/\\/g, '/'));
        }
      } catch {
        // 基点不可达（比如分支被删）时跳过已提交部分
      }
    }
  }

  // 托管文件：路径不计入越界，但内容被改动就是篡改
  const managedPaths = new Set(managed.map((m) => m.path.replace(/\\/g, '/')));
  const tampered: string[] = [];
  for (const file of managed) {
    const rel = file.path.replace(/\\/g, '/');
    const actual = hashFile(join(worktreeRoot, rel));
    if (actual !== file.hash) tampered.push(rel);
  }

  // 预置脏（D-29）：运行开始时 worktree 就已经脏的路径不算越界，
  // 只从 violations 里排除，changed 里照样保留以便审计。
  const baseline = new Set(
    (options.baselineChanged ?? []).map((p) => p.replace(/\\/g, '/')),
  );

  const all = [...changed];
  const violations = all.filter(
    (p) => !managedPaths.has(p) && !baseline.has(p) && !pathInWriteSet(p, writes),
  );
  return { changed: all, violations, tampered, error: null, coverageGap };
}
