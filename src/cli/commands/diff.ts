/**
 * diff.command.ts — `zelto diff <slice-id>` command
 *
 * Shows a summary of changes made by a slice: which files were modified,
 * added, or deleted, and a git diff since the slice was frozen.
 */

import { register } from '../commands/shared.js';
import { store, existingWorktreePath } from '../commands/shared.js';
import { colors } from '../color.js';
import { execSync } from 'node:child_process';

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

    // Determine diff base: use baseCommit, or try git log to find the frozen state
    let baseRef: string | null = slice.baseCommit;
    if (!baseRef) {
      // Try to find the commit when this slice was created/frozen via event stream
      try {
        const log = execSync(
          `git log --all --oneline --diff-filter=A -- specs/slices/${id}.md`,
          { encoding: 'utf-8', timeout: 5000, cwd },
        ).trim();
        if (log) {
          baseRef = log.split('\n')[0].split(' ')[0];
        }
      } catch {
        // Fall back to HEAD~1 or similar
      }
    }

    // Default fallback
    // In a worktree the agent's changes are usually uncommitted, so diff against the
    // base commit directly (covers both committed and working-tree changes).
    const diffTarget = worktreePath
      ? (baseRef ?? 'HEAD')
      : (baseRef ? `${baseRef}..HEAD` : '--cached');

    // Get file change stats
    let statOutput = '';
    let nameOutput = '';
    let diffOutput = '';

    try {
      statOutput = execSync(
        `git diff ${diffTarget} --stat`,
        { encoding: 'utf-8', timeout: 10000, cwd },
      ).trim();
    } catch { /* no changes */ }

    try {
      nameOutput = execSync(
        `git diff ${diffTarget} --name-status`,
        { encoding: 'utf-8', timeout: 10000, cwd },
      ).trim();
    } catch { /* no changes */ }

    // Uncommitted changes inside the worktree are not part of `base..HEAD`
    let uncommittedOutput = '';
    if (worktreePath) {
      try {
        uncommittedOutput = execSync(
          'git diff HEAD --stat',
          { encoding: 'utf-8', timeout: 10000, cwd },
        ).trim();
      } catch { /* no changes */ }
    }

    if (isStat && !isJson) {
      console.log(`Changes for slice "${id}":`);
      console.log('');
      if (statOutput) {
        console.log(statOutput);
      } else {
        console.log('  No changes detected.');
      }
      return 0;
    }

    try {
      diffOutput = execSync(
        `git diff ${diffTarget}`,
        { encoding: 'utf-8', timeout: 10000, cwd },
      ).trim();
    } catch { /* no changes */ }

    if (isJson) {
      const files: Array<{ status: string; path: string }> = [];
      if (nameOutput) {
        for (const line of nameOutput.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            files.push({ status: parts[0], path: parts.slice(1).join(' ') });
          }
        }
      }
      console.log(JSON.stringify({
        sliceId: id,
        baseRef,
        worktree: worktreePath,
        files,
        diff: diffOutput || null,
        uncommitted: uncommittedOutput || null,
      }, null, 2));
      return 0;
    }

    // Default: human-readable output
    console.log(`${colors.bold(`Changes for slice "${id}":`)}`);
    console.log(`  ${colors.dim(`Base: ${baseRef ?? '(working tree vs cached)'}`)}`);
    if (worktreePath) {
      console.log(`  ${colors.dim(`Worktree: ${worktreePath}`)}`);
    }
    console.log('');

    if (!nameOutput && !diffOutput && !uncommittedOutput) {
      console.log('  No changes detected.');
      return 0;
    }

    // Show file list
    if (nameOutput) {
      console.log(`${colors.bold('Files:')}`);
      for (const line of nameOutput.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const status = parts[0];
          const path = parts.slice(1).join(' ');
          const statusColor: Record<string, (s: string) => string> = {
            M: colors.yellow,
            A: colors.green,
            D: colors.red,
          };
          const colorFn = statusColor[status] ?? colors.dim;
          console.log(`  ${colorFn(status === 'M' ? '✎' : status === 'A' ? '+' : '−')} ${path}`);
        }
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
