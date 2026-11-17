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
   * 判据是 commit message 里的 `Refs-Slice: <id>` trailer。
   *
   * 不给就退回「基点..HEAD 的全部提交」（老行为）。这个行为在
   * 切片分支被别的东西推进过时会误报：那些提交不是本片 agent 写的，
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
 * 判据：commit message 里有 `Refs-Slice: <sliceId>` trailer。
 * 这是 zelto 既有的提交约定（`merge-runner.ts` 的自动提交就带它），
 * 确定性可判，不调模型、不触网（C3）。
 *
 * 为什么需要它：审计要回答「本片 agent 改了什么」。
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
  let log: string;
  try {
    log = git(
      ['log', '--format=%H%x00%B%x00%x00', `${baseCommit}..${headCommit}`],
      repoRoot,
    );
  } catch {
    return [];
  }

  const result: string[] = [];
  // 格式：<hash>\0<body>\0\0<hash>\0<body>\0\0 ...
  const records = log.split('\0\0');
  for (const record of records) {
    if (!record.trim()) continue;
    const sep = record.indexOf('\0');
    if (sep < 0) continue;
    const hash = record.slice(0, sep).trim();
    const body = record.slice(sep + 1);
    if (!hash) continue;
    if (hasRefsSlice(body, sliceId)) result.push(hash);
  }
  // git log 是从新到旧；反转成从旧到新（diff 累积时顺序不影响结果，
  // 但可读性与调试体验更好）
  return result.reverse();
}

/**
 * 判断一条 commit message 是否声明「由某个切片产出」。
 *
 * trailer 格式：`Refs-Slice: <id>`（大小写不敏感的 key，
 * 值精确匹配 —— `v1-a` 不能匹配 `v1-ab`）。
 */
export function hasRefsSlice(message: string, sliceId: string): boolean {
  const pattern = /^Refs-Slice:\s*(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message)) !== null) {
    if (match[1].trim() === sliceId) return true;
  }
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
  add(git(['diff', '--name-only'], repoRoot));
  add(git(['diff', '--cached', '--name-only'], repoRoot));
  add(git(['ls-files', '--others', '--exclude-standard'], repoRoot));

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

  try {
    // D-63：不用 `--untracked-files=all`（它在冷 worktree 上要 224 秒）。
    // `listChangedPaths` 用 diff + diff --cached + ls-files 三条命令，
    // 语义等价，快 17 倍。
    for (const p of listChangedPaths(worktreeRoot)) changed.add(p);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { changed: [], violations: [], tampered: [], error: `git status 失败: ${message}` };
  }

  if (baseCommit) {
    // 审计要回答的是「**本片 agent 改了什么**」，不是「**本片分支上有哪些提交**」。
    //
    // 基点错了、或分支在运行期间被别的东西推进过时，
    // 「基点..HEAD 的全部提交」里会混进不是本片产出的东西 ——
    // 那些东西会被算成「本片的越界写入」（实测 D-28：上一片的三个文件
    // 经一次事后快进进了本片分支，被判成本片越界）。
    //
    // 所以给了 sliceId 就按 `Refs-Slice:` trailer 过滤，只算本片的提交。
    const sliceId = options.sliceId ?? null;
    if (sliceId) {
      for (const commit of commitsOfSlice(worktreeRoot, baseCommit, 'HEAD', sliceId)) {
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
  return { changed: all, violations, tampered, error: null };
}
