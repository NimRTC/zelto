// Gate and sign commands: gate, inbox, sign

import { createInterface } from 'node:readline';
import { GateExecutor } from '../../core/gate/executor.js';
import { SignManager } from '../../core/gate/sign.js';
import type { GateConfig } from '../../core/gate/types.js';
import { register } from './shared.js';
import { store, events, ZELTO_DIR, loadConfig } from './shared.js';

// ─── gate ────────────────────────────────────────────────────────────────────

register('gate', async (args) => {
  const [id] = args;
  if (!id || id === '--help' || id === '-h') {
    console.error('Usage: zelto gate <slice-id> [--retry <N>] [--dry-run]');
    return 1;
  }

  const isJson = args.includes('--json');
  const isDryRun = args.includes('--dry-run');
  const retryFlag = args.indexOf('--retry');
  const forceRetry = retryFlag >= 0 && args[retryFlag + 1] ? Math.max(0, parseInt(args[retryFlag + 1], 10) || 0) : -1;

  try {
    const slice = await store.read(id);
    if (slice.state !== 'frozen') {
      if (forceRetry >= 0) {
        // Force re-run gate on any state
        console.log(`zelto gate ${id} — re-running gate② (forced, state=${slice.state})...`);
      } else {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, passed: false, error: `Slice is in state "${slice.state}", must be "frozen"` }));
        } else {
          console.error(`Slice "${id}" is in state "${slice.state}". Must be "frozen" to run gate.`);
          console.error(`  Use --retry <N> to force re-run regardless of state.`);
        }
        return 1;
      }
    } else {
      console.log(`zelto gate ${id} — running gate②...`);
    }

    const config = loadConfig();

    // Dry run: show what would be executed
    if (isDryRun) {
      if (isJson) {
        console.log(JSON.stringify({
          sliceId: id, dryRun: true,
          commands: config.gate.commands.map((c) => ({ name: c.name, run: c.run })),
          timeoutSec: config.gate.timeoutSec,
          retry: config.gate.retry,
        }));
      } else {
        console.log(`  Dry-run for gate ${id}:`);
        console.log(`  Commands: ${config.gate.commands.length}`);
        for (const c of config.gate.commands) {
          console.log(`    - ${c.name}: ${c.run}`);
        }
        console.log(`  Timeout: ${config.gate.timeoutSec}s`);
        console.log(`  Retries: ${config.gate.retry.max}`);
        console.log(`\n  Run without --dry-run to execute.`);
      }
      return 0;
    }

    const gateConfig = {
      commands: config.gate.commands.map((c) => ({ name: c.name, run: c.run })),
      changedLineCoverage: 0.8,
      timeoutSec: config.gate.timeoutSec,
      retry: { max: forceRetry >= 0 ? forceRetry : config.gate.retry.max, budgetStepUsd: 0.05 },
    } satisfies GateConfig;

    const executor = new GateExecutor(store, events, gateConfig);
    const report = await executor.execute(id);

    if (isJson) {
      console.log(JSON.stringify({
        sliceId: id, passed: report.passed,
        commands: report.results.map((r) => ({
          command: r.command, passed: r.passed, exitCode: r.exitCode, durationMs: r.durationMs,
        })),
        retryCount: report.retryCount,
        totalDurationMs: report.totalDurationMs,
      }));
      return report.passed ? 0 : 1;
    }

    console.log(`  Commands: ${report.results.length}`);
    for (const r of report.results) {
      const icon = r.passed ? '✅' : '❌';
      console.log(`    ${icon} ${r.command} (${r.durationMs.toFixed(0)}ms, exit ${r.exitCode ?? 'signal'})`);
    }

    if (report.retryCount > 0) {
      console.log(`  Retries:  ${report.retryCount}`);
    }

    if (report.passed) {
      console.log(`  Result:   ✅ Gate passed (${report.totalDurationMs.toFixed(0)}ms)`);
      const prevState = slice.state;
      await store.transit(id, 'GATE_PASS');
      await events.append(id, 'slice.state.changed', 'cli', {
        sliceId: id, from: prevState, to: 'completed', event: 'GATE_PASS',
      });
      console.log(`  State:    ✅ Slice transitioned to "completed"`);

      const signManager = new SignManager(ZELTO_DIR, events, store);
      const signReq = await signManager.request(id, 'zelto');
      console.log(`  Sign:     📋 Sign request created (${signReq.id})`);
      console.log(`  Next:     Run "zelto sign ${id} --approve" to approve`);
    } else {
      console.log(`  Result:   ❌ Gate failed (${report.totalDurationMs.toFixed(0)}ms)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, error: msg }));
    } else {
      console.error(`Error running gate for "${id}": ${msg}`);
    }
    return 1;
  }
  return 0;
});

// ─── inbox ───────────────────────────────────────────────────────────────────

register('inbox', async (args) => {
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const pending = await signManager.list('pending');

  if (args.includes('--list') || !process.stdout.isTTY) {
    if (pending.length === 0) {
      console.log('Inbox is empty. Nothing pending.');
      return 0;
    }
    console.log('Inbox — Pending Sign Requests:');
    console.log('');
    for (const req of pending) {
      console.log(`  [${req.id}]`);
      console.log(`    Slice:    ${req.sliceId}`);
      console.log(`    Requested: ${req.requestedAt}`);
      console.log(`    By:        ${req.requestedBy}`);
      console.log(`    Action:    zelto sign ${req.sliceId} --approve | --reject`);
      console.log('');
    }
    console.log(`${pending.length} pending request(s).`);
    return 0;
  }

  if (pending.length === 0) {
    console.log('📋 Inbox is empty. Nothing pending.');
    return 0;
  }

  console.log('📋 Inbox — Pending Sign Requests:');
  console.log('');
  for (let i = 0; i < pending.length; i++) {
    const req = pending[i];
    console.log(`  ${i + 1}. [${req.sliceId}] — requested ${req.requestedAt.slice(0, 10)}`);
  }
  console.log('');
  console.log('Enter number to review, or q to quit.');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question('> ', resolve);
  });
  rl.close();

  const idx = Number.parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= pending.length) {
    if (answer === 'q' || answer === 'Q') {
      console.log('Bye.');
      return 0;
    }
    console.log('Invalid selection.');
    return 1;
  }

  const req = pending[idx];
  console.log('');
  console.log(`  Slice:    ${req.sliceId}`);
  console.log(`  Request:  ${req.requestedAt}`);
  console.log(`  By:       ${req.requestedBy}`);

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  const decision = await new Promise<string>((resolve) => {
    rl2.question('  Approve? [Y/n] ', resolve);
  });
  rl2.close();

  if (decision === '' || decision.toLowerCase() === 'y' || decision.toLowerCase() === 'yes') {
    await signManager.approve(req.id, 'human', null);
    console.log(`  ✅ ${req.sliceId} approved`);
    await autoMergeSlice(req.sliceId);
  } else {
    const rl3 = createInterface({ input: process.stdin, output: process.stdout });
    const comment = await new Promise<string>((resolve) => {
      rl3.question('  Rejection comment: ', resolve);
    });
    rl3.close();
    await signManager.reject(req.id, 'human', comment || null);
    console.log(`  ❌ ${req.sliceId} rejected`);
  }

  return 0;
});

// ─── auto-merge (shared helper) ──────────────────────────────────────────────

async function autoMergeSlice(sliceId: string): Promise<void> {
  try {
    const { execSync } = await import('node:child_process');
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8', timeout: 5000,
    }).trim();

    const expectedBranch = `slice/${sliceId}`;

    if (currentBranch === 'main' || currentBranch === 'master') {
      // On main branch — commit changes directly with slice attribution
      console.log(`  Staging: committing changes to ${currentBranch}...`);
      execSync('git add -A', { cwd: process.cwd(), timeout: 15000 });
      try {
        execSync(`git commit -m "feat(${sliceId}): slice approved

Auto-commit after sign approval for slice ${sliceId}

Co-Authored-By: Claude Code <noreply@anthropic.com>"`, {
          cwd: process.cwd(), timeout: 15000,
        });
        console.log(`  ✅ Committed to ${currentBranch}`);
      } catch {
        console.log(`  ℹ️  Nothing to commit`);
      }
    } else {
      // On a feature branch — merge to main
      console.log(`  Merging: staging changes...`);
      execSync('git add -A', { cwd: process.cwd(), timeout: 15000 });
      try {
        execSync(`git commit -m "feat(${sliceId}): slice approved

Auto-merge after sign approval for slice ${sliceId}

Co-Authored-By: Claude Code <noreply@anthropic.com>"`, {
          cwd: process.cwd(), timeout: 15000,
        });
      } catch {
        // Nothing to commit — fine
      }

      try {
        execSync('git rev-parse --verify main', { timeout: 3000 });
        execSync(`git checkout main && git merge --ff-only ${currentBranch}`, {
          cwd: process.cwd(), timeout: 15000,
        });
        console.log(`  ✅ Merged "${currentBranch}" → main`);

        // Delete the feature branch
        try {
          execSync(`git branch -d ${currentBranch}`, { cwd: process.cwd(), timeout: 5000 });
          console.log(`  ✅ Deleted branch "${currentBranch}"`);
        } catch {
          console.log(`  ℹ️  Could not delete branch "${currentBranch}" (may have unmerged changes)`);
        }

        // Try to create a GitHub PR if gh CLI is available
        try {
          execSync('gh --version', { stdio: 'ignore', timeout: 3000 });
          const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8', timeout: 3000 }).trim();
          if (remoteUrl && remoteUrl.includes('github.com')) {
            console.log(`  ℹ️  PR not created automatically. Create one:`);
            console.log(`     gh pr create --fill --base main`);
          }
        } catch {
          // gh CLI not available — skip
        }
      } catch {
        console.log(`  ℹ️  No main branch to merge into. Current: ${currentBranch}`);
      }
    }
  } catch (mergeErr) {
    console.log(`  ⚠️  Auto-merge skipped: ${mergeErr}`);
  }
}

// ─── sign ────────────────────────────────────────────────────────────────────

register('sign', async (args) => {
  const [id, action] = args;
  if (!id || !action) {
    console.error('Usage: zelto sign <slice-id> [--approve|--reject] [--comment <text>]');
    return 1;
  }

  const isJson = args.includes('--json');
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const commentIndex = args.indexOf('--comment');
  const comment = commentIndex >= 0 ? args[commentIndex + 1] : null;

  try {
    if (action === '--approve') {
      const pending = await signManager.list('pending');
      const req = pending.find((r) => r.sliceId === id);
      if (!req) {
        const newReq = await signManager.request(id, 'human');
        await signManager.approve(newReq.id, 'human', comment);
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, action: 'approved', autoRequested: true }));
        } else {
          console.log(`zelto sign ${id} -- ✅ Approved (auto-requested)`);
        }
      } else {
        await signManager.approve(req.id, 'human', comment);
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, action: 'approved' }));
        } else {
          console.log(`zelto sign ${id} -- ✅ Approved`);
        }
      }

      // Auto-merge: stage, commit, and merge to main
      if (!isJson) await autoMergeSlice(id);
    } else if (action === '--reject') {
      const pending = await signManager.list('pending');
      const req = pending.find((r) => r.sliceId === id);
      if (!req) {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, action: 'rejected', error: 'No pending sign request' }));
        } else {
          console.error(`No pending sign request for slice "${id}".`);
        }
        return 1;
      }
      await signManager.reject(req.id, 'human', comment);
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, action: 'rejected' }));
      } else {
        console.log(`zelto sign ${id} -- ❌ Rejected`);
      }
    } else {
      if (isJson) {
        console.log(JSON.stringify({ error: `Unknown action: ${action}` }));
      } else {
        console.error(`Unknown action: ${action}`);
        console.error('Usage: zelto sign <slice-id> [--approve|--reject]');
      }
      return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, error: msg }));
    } else {
      console.error(`Error processing sign for "${id}": ${msg}`);
    }
    return 1;
  }
  return 0;
});
