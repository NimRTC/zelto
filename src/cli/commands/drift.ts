/**
 * drift.ts — `zelto drift` command
 *
 * Checks a slice for drift: spec hash changes, write-set file changes,
 * and acceptance test file status.
 *
 * C3: deterministic only — no model calls, no network
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { register, store, events, hashSpecFile } from './shared.js';
import { getDefaultFormatter } from '../output-formatter.js';

interface DriftIssue {
  type: string;
  severity: 'warning' | 'error';
  message: string;
}

register('drift', async (args) => {
  const [id] = args;
  const f = getDefaultFormatter();

  if (!id || id === '--help' || id === '-h') {
    f.error('USAGE', 'Usage: zelto drift <slice-id> [--json]');
    return 1;
  }

  const isJson = args.includes('--json');

  try {
    const slice = await store.read(id);
    const issues: DriftIssue[] = [];

    // 1. Check spec file hash
    if (slice.spec.frozenHash) {
      const currentHash = hashSpecFile(slice.spec.path);
      if (!currentHash) {
        issues.push({ type: 'spec.missing', severity: 'error', message: `Spec file not found: ${slice.spec.path}` });
      } else if (currentHash !== slice.spec.frozenHash) {
        issues.push({
          type: 'spec.hash_mismatch',
          severity: 'error',
          message: `Spec file changed since freeze (hash: ${currentHash.slice(0, 12)}... ≠ frozen: ${slice.spec.frozenHash.slice(0, 12)}...)`,
        });
      }
    }

    // 2. Check write-set files (via git diff against baseCommit or HEAD~1)
    if (slice.writes.length > 0) {
      try {
        const baseRef = slice.baseCommit ?? 'HEAD';
        const diffOutput = execSync(
          `git diff --name-only ${baseRef} -- ${slice.writes.join(' ')}`,
          { encoding: 'utf-8', timeout: 10000, cwd: process.cwd() },
        ).trim();

        if (diffOutput) {
          const changedFiles = diffOutput.split('\n').filter(Boolean);
          issues.push({
            type: 'writes.changed',
            severity: 'warning',
            message: `${changedFiles.length} write-set file(s) changed since ${baseRef}: ${changedFiles.slice(0, 5).join(', ')}${changedFiles.length > 5 ? ` (+${changedFiles.length - 5} more)` : ''}`,
          });
        }
      } catch {
        // git diff may fail if baseCommit is invalid or not in a git repo
        issues.push({
          type: 'writes.check_skipped',
          severity: 'warning',
          message: 'Could not check write-set file changes (not a git repo or invalid base commit)',
        });
      }
    }

    // 3. Check acceptance test file exists
    if (slice.acceptance.dir) {
      const acceptPath = slice.acceptance.dir.endsWith('/')
        ? slice.acceptance.dir.slice(0, -1)
        : slice.acceptance.dir;
      if (!existsSync(acceptPath) && !existsSync(`${acceptPath}.test.ts`)) {
        issues.push({
          type: 'acceptance.missing',
          severity: 'warning',
          message: `Acceptance test path not found: ${slice.acceptance.dir}`,
        });
      }
    }

    // 4. Check for uncommitted changes in write-set
    if (slice.writes.length > 0) {
      try {
        const uncommitted = execSync(
          `git status --porcelain -- ${slice.writes.join(' ')}`,
          { encoding: 'utf-8', timeout: 5000, cwd: process.cwd() },
        ).trim();
        if (uncommitted) {
          const lines = uncommitted.split('\n').filter(Boolean);
          issues.push({
            type: 'writes.uncommitted',
            severity: 'warning',
            message: `${lines.length} uncommitted change(s) in write-set`,
          });
        }
      } catch {
        // Non-git repo — skip
      }
    }

    // Update slice drift state if errors found
    const hasErrors = issues.some((i) => i.severity === 'error');
    if (hasErrors !== slice.drift.detected) {
      slice.drift.detected = hasErrors;
      slice.drift.reason = hasErrors
        ? issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ')
        : null;
      slice.drift.at = hasErrors ? new Date().toISOString() : null;
      await store.write(slice);

      if (hasErrors) {
        await events.append(id, 'slice.drift_detected', 'cli', {
          sliceId: id,
          issues: issues.filter((i) => i.severity === 'error'),
        });
      }
    }

    if (isJson) {
      f.data({
        sliceId: id,
        state: slice.state,
        driftDetected: slice.drift.detected,
        issues,
        issueCount: issues.length,
      });
      return issues.some((i) => i.severity === 'error') ? 1 : 0;
    }

    f.out(`zelto drift ${id} — checking for drift...`);
    f.out(`  Slice:   ${slice.title}`);
    f.out(`  State:   ${slice.state}`);
    f.out(`  Drift:   ${slice.drift.detected ? '⚠️ Detected' : '✅ None'}`);

    if (issues.length === 0) {
      f.out(`  Result:  ✅ No drift detected`);
      return 0;
    }

    for (const issue of issues) {
      const icon = issue.severity === 'error' ? '❌' : '⚠️';
      f.out(`  ${icon} [${issue.type}] ${issue.message}`);
    }

    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warningCount = issues.filter((i) => i.severity === 'warning').length;
    f.out(`  Result:  ${errorCount > 0 ? `❌ ${errorCount} error(s)` : ''}${errorCount > 0 && warningCount > 0 ? ', ' : ''}${warningCount > 0 ? `⚠️ ${warningCount} warning(s)` : ''}${errorCount === 0 && warningCount === 0 ? '✅ No drift' : ''}`);

    return errorCount > 0 ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('DRIFT_ERROR', `Error checking drift for "${id}": ${msg}`);
    return 1;
  }
});
