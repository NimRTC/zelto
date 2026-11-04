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
    const status = git(['status', '--porcelain', '--untracked-files=all'], worktreeRoot);
    for (const p of parsePorcelainStatus(status)) changed.add(p);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { changed: [], violations: [], tampered: [], error: `git status 失败: ${message}` };
  }

  if (baseCommit) {
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

  // 托管文件：路径不计入越界，但内容被改动就是篡改
  const managedPaths = new Set(managed.map((m) => m.path.replace(/\\/g, '/')));
  const tampered: string[] = [];
  for (const file of managed) {
    const rel = file.path.replace(/\\/g, '/');
    const actual = hashFile(join(worktreeRoot, rel));
    if (actual !== file.hash) tampered.push(rel);
  }

  const all = [...changed];
  const violations = all.filter((p) => !managedPaths.has(p) && !pathInWriteSet(p, writes));
  return { changed: all, violations, tampered, error: null };
}
