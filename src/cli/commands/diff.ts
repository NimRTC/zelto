/**
 * diff.command.ts — `zelto diff <slice-id>` command
 *
 * Shows a summary of changes made by a slice: which files were modified,
 * added, or deleted, and a git diff since the slice was frozen.
 *
 * **基准与文件清单来自 `core/sign-review/diff.ts`** —— 与 `zelto sign --review`
 * 同一份实现。这不是"顺手统一"，而是必须的：
 * 签字时看到的「改了 3 个文件」与这里列出的 7 个对不上，
 * 签字前确认就成了走形式（D-11 教训：两处各判一套必然漂移）。
 */

import { register } from '../commands/shared.js';
import { store, existingWorktreePath } from '../commands/shared.js';
import { colors } from '../color.js';
import { execSync } from 'node:child_process';
import {
  collectDiffFacts,
  resolveDiffBase,
  type DiffFile,
  type DiffFileStatus,
} from '../../core/sign-review/diff.js';

register('diff', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto diff <slice-id> [--stat] [--json]');
    return 1;
  }

  const isStat = args.includes('--stat');
  const isJson = args.includes('--json');

  try {
    const slice = await store.read(id);

    // Diff inside the slice's worktree when it exists — that's where the agent's
    // (possibly uncommitted) changes live.
    const worktreePath = existingWorktreePath(id);
    const cwd = worktreePath ?? process.cwd();

    // 基准解析只在 core/sign-review/diff.ts 一处 —— 签字复查与这里说同一份事实。
    const { baseRef, baseNote } = resolveDiffBase(id, slice.baseCommit ?? null, cwd);

    // 文件级事实（状态 + 增删行 + 未跟踪文件）
    const diffFacts = collectDiffFacts({
      sliceId: id,
      baseCommit: slice.baseCommit ?? null,
      worktreePath,
      repoRoot: cwd,
    });

    // 全文 diff —— 只在 `zelto diff` 这里给（签字复查放不下全文）
    let diffOutput = '';
    try {
      diffOutput = execSync(
        `git diff ${baseRef ?? 'HEAD'}`,
        { encoding: 'utf-8', timeout: 10000, cwd },
      ).trim();
    } catch { /* no changes */ }

    if (isStat && !isJson) {
      console.log(`Changes for slice "${id}":`);
      console.log('');
      if (diffFacts.files.length > 0) {
        console.log(formatStatBlock(diffFacts.files));
      } else {
        console.log('  No changes detected.');
      }
      return 0;
    }

    if (isJson) {
      console.log(
        JSON.stringify(
          {
            sliceId: id,
            baseRef,
            baseNote,
            worktree: worktreePath,
            filesChanged: diffFacts.filesChanged,
            addedLines: diffFacts.addedLines,
            deletedLines: diffFacts.deletedLines,
            files: diffFacts.files.map((f) => ({
              path: f.path,
              status: f.status,
              added: f.added,
              deleted: f.deleted,
            })),
            diff: diffOutput || null,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    // Default: human-readable output
    console.log(`${colors.bold(`Changes for slice "${id}":`)}`);
    console.log(`  ${colors.dim(`Base: ${baseNote}`)}`);
    if (worktreePath) {
      console.log(`  ${colors.dim(`Worktree: ${worktreePath}`)}`);
    }
    console.log('');

    if (diffFacts.files.length === 0 && !diffOutput) {
      console.log('  No changes detected.');
      return 0;
    }

    // Show file list —— 与签字复查看到的是同一份清单
    if (diffFacts.files.length > 0) {
      console.log(`${colors.bold('Files:')}`);
      for (const file of diffFacts.files) {
        console.log(`  ${statusMarker(file.status)} ${file.path}${formatLineDelta(file)}`);
      }
      console.log('');
    }

    // Show diff
    if (!isStat && diffOutput) {
      const maxLines = 80;
      const lines = diffOutput.split('\n');
      console.log(`${colors.bold('Diff:')}`);
      // Show only first N lines to avoid flooding terminal
      const displayLines = lines.slice(0, maxLines);
      for (const line of displayLines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          console.log(`  ${colors.green(line)}`);
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          console.log(`  ${colors.red(line)}`);
        } else if (line.startsWith('@@')) {
          console.log(`  ${colors.cyan(line)}`);
        } else {
          console.log(`  ${line}`);
        }
      }
      if (lines.length > maxLines) {
        console.log(`  ${colors.dim(`... ${lines.length - maxLines} more lines`)}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('ENOENT')) {
      console.error(`Slice "${id}" not found.`);
    } else {
      console.error(`Error: ${msg}`);
    }
    return 1;
  }
  return 0;
});

// ─── 呈现小工具 ──────────────────────────────────────────────────────────────

/** 状态 → 记号 + 颜色。 */
function statusMarker(status: DiffFileStatus): string {
  switch (status) {
    case 'added':
      return colors.green('+');
    case 'modified':
      return colors.yellow('✎');
    case 'deleted':
      return colors.red('−');
    case 'renamed':
      return colors.cyan('»');
    case 'copied':
      return colors.cyan('»');
    case 'untracked':
      return colors.green('*');
    default:
      return colors.dim('?');
  }
}

/** 行数增量 —— 二进制/未跟踪文件没有行数，就不显示。 */
function formatLineDelta(file: DiffFile): string {
  if (file.added === null && file.deleted === null) return '';
  const parts: string[] = [];
  if (file.added) parts.push(colors.green(`+${file.added}`));
  if (file.deleted) parts.push(colors.red(`-${file.deleted}`));
  return parts.length > 0 ? `  ${colors.dim('(')} ${parts.join(' ')} ${colors.dim(')')}` : '';
}

/** `--stat` 模式的聚合块（对齐 git 的 stat 观感）。 */
function formatStatBlock(files: DiffFile[]): string {
  const lines: string[] = [];
  for (const f of files) {
    const counts =
      f.added === null && f.deleted === null ? '-' : `${f.added ?? 0} ${f.deleted ?? 0}`;
    lines.push(` ${f.path} | ${counts}`);
  }
  lines.push(
    ` ${files.length} file${files.length === 1 ? '' : 's'} changed, ` +
      `${files.reduce((a, f) => a + (f.added ?? 0), 0)} insertions(+), ` +
      `${files.reduce((a, f) => a + (f.deleted ?? 0), 0)} deletions(-)`,
  );
  return lines.join('\n');
}
