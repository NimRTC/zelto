// 改动事实收集 —— 跑 git 拿「agent 到底动了什么」
//
// C3: 只读 git，不调模型、不触网
// C2: core/ 内，零第三方依赖，不 import adapters/
//
// 为什么在 core/ 而不是 CLI 层：
//   跟 `core/sign-review/collect.ts` 同一个理由 —— 事实收集要跑 git，
//   而 Web 端（`zelto web`）也要用同一份事实。两处各判一次必然漂移
//   （D-11 的教训）。
//
// git 读不到时的口径：**读不到就说读不到**，不假装成「没改动」。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { ChangedFile } from './conformance.js';

/**
 * 收集一次改动的文件清单。
 *
 * @param cwd 跑 git 的目录（切片 worktree，没有则仓库根）
 * @param baseRef 差异基准（commit / 分支 / `HEAD`）
 * @returns 改动文件清单；git 读不到时返回空数组
 */
export function collectChangedFiles(cwd: string, baseRef: string): ChangedFile[] {
  const out = runGit(cwd, ['diff', '-M', '--numstat', baseRef]);
  if (out === null) return [];

  const files: ChangedFile[] = [];

  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // numstat 的格式：`<added>\t<deleted>\t<path>`
    // 二进制文件的 added/deleted 是 `-`。
    const cols = trimmed.split('\t');
    if (cols.length < 3) continue;

    const added = cols[0] === '-' ? 0 : Number.parseInt(cols[0], 10) || 0;
    const deleted = cols[1] === '-' ? 0 : Number.parseInt(cols[1], 10) || 0;

    // 重命名时 numstat 给的是 `old => new` 或 `old\t=>\tnew`（带 -M 时是
    // `old => new` 单字段）。这里取箭头后的新路径。
    const rawPath = cols.slice(2).join('\t');
    const path = rawPath.includes('=>')
      ? (rawPath.split('=>')[1] ?? rawPath).trim().replace(/^\{|\}$/g, '')
      : rawPath.trim();

    if (!path) continue;

    files.push({
      path: path.replace(/\\/g, '/'),
      status: 'M',
      added,
      deleted,
    });
  }

  // 补上新增与删除的文件（numstat 对未跟踪文件不列）
  for (const file of collectUntracked(cwd)) {
    if (!files.some((f) => f.path === file.path)) {
      files.push(file);
    }
  }

  return files;
}

/** 未跟踪的文件（agent 新建但还没 git add 的） */
function collectUntracked(cwd: string): ChangedFile[] {
  const out = runGit(cwd, ['ls-files', '--others', '--exclude-standard']);
  if (out === null) return [];

  const files: ChangedFile[] = [];
  for (const line of out.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    files.push({ path: p.replace(/\\/g, '/'), status: 'A', added: 0, deleted: 0 });
  }
  return files;
}

/**
 * 读改动文件的当前内容。
 *
 * 读不到就不放进去 —— 符号证据那一步会自动跳过这个文件，
 * 退到「只有路径证据」的口径。**不假装文件是空的**：
 * 空内容会让「符号没出现」看起来像真结论，那是假阴性。
 */
export function readFileContents(
  cwd: string,
  paths: string[],
): Map<string, string> {
  const contents = new Map<string, string>();
  const root = resolve(cwd);

  for (const p of paths) {
    try {
      const abs = resolve(root, p);
      const rel = relative(root, abs).replace(/\\/g, '/');
      contents.set(rel, readFileSync(abs, 'utf-8'));
    } catch {
      /* 读不到就不放 —— 证据缺失不等于证据为负 */
    }
  }

  return contents;
}

/**
 * 跑 git 并拿 stdout。
 *
 * 失败返回 null（不抛）—— 读不到就说读不到。
 * stderr 丢弃：git 探测失败时它会把整页 usage 打到 stderr，那不该漏到用户终端。
 */
function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}
