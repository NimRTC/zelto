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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 去掉 git 对特殊字符路径的 C 风格引号。 */
function unquotePath(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
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
    filePath = unquotePath(filePath);
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
