// Gate and sign commands: gate, inbox, sign

import { createInterface } from 'node:readline';
import { GateExecutor } from '../../core/gate/executor.js';
import { SignManager } from '../../core/gate/sign.js';
import type { GateConfig } from '../../core/gate/types.js';
import { register } from './shared.js';
import { store, events, ZELTO_DIR, loadConfig, resolveTargetDir, existingWorktreePath } from './shared.js';
import { SpecMdExecutor } from '../../core/spec/SpecMdExecutor.js';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';

// ─── gate ────────────────────────────────────────────────────────────────────

register('gate', async (args) => {
  const hasSpecMd = args.includes('--spec-md');

  // Handle `gate --spec-md` without a slice ID: run spec-md on all slices
  if (hasSpecMd && (!args[0] || args[0].startsWith('--'))) {
    return runSpecMdOnAllSlices();
  }

  const [id] = args;
  if (!id || id === '--help' || id === '-h') {
    if (!id && hasSpecMd) {
      // --spec-md without slice-id is handled above
      return 0;
    }
    console.error('Usage: zelto gate <slice-id> [--retry <N>] [--dry-run] [--spec-md] [--only <name>]');
    console.error('       zelto gate --spec-md                    (validate all specs)');
    return 1;
  }

  const isJson = args.includes('--json');
  const isDryRun = args.includes('--dry-run');
  const retryFlag = args.indexOf('--retry');
  const forceRetry = retryFlag >= 0 && args[retryFlag + 1] ? Math.max(0, parseInt(args[retryFlag + 1], 10) || 0) : -1;
  const onlyFlag = args.indexOf('--only');
  const onlyCommand = onlyFlag >= 0 && args[onlyFlag + 1] ? args[onlyFlag + 1] : null;

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

    // Resolve target project directory for cross-project execution
    const targetDir = resolveTargetDir();
    const gateCommands = targetDir && config.targetProject?.gate?.commands
      ? config.targetProject.gate.commands
      : config.gate.commands;
    const gateProfiles = targetDir && config.targetProject?.gate?.profiles
      ? config.targetProject.gate.profiles
      : config.gate.profiles;

    if (targetDir) {
      console.log(`  Target:   ${targetDir}`);
    }

    // Dry run: show what would be executed
    if (isDryRun) {
      if (isJson) {
        console.log(JSON.stringify({
          sliceId: id, dryRun: true,
          commands: gateCommands
            .filter((c) => !onlyCommand || c.name === onlyCommand)
            .map((c) => ({ name: c.name, run: c.run })),
          timeoutSec: config.gate.timeoutSec,
          retry: config.gate.retry,
          only: onlyCommand,
          targetDir,
        }));
      } else {
        const filteredCmds = gateCommands.filter((c) => !onlyCommand || c.name === onlyCommand);
        console.log(`  Dry-run for gate ${id}:`);
        console.log(`  Commands: ${filteredCmds.length}${onlyCommand ? ` (filtered: ${onlyCommand})` : ''}`);
        for (const c of filteredCmds) {
          console.log(`    - ${c.name}: ${c.run}`);
        }
        console.log(`  Timeout: ${config.gate.timeoutSec}s`);
        console.log(`  Retries: ${config.gate.retry.max}`);
        if (targetDir) console.log(`  CWD:     ${targetDir}`);
        console.log(`\n  Run without --dry-run to execute.`);
      }
      return 0;
    }

    const gateConfig = {
      commands: gateCommands
        .filter((c) => !onlyCommand || c.name === onlyCommand)
        .map((c) => ({ name: c.name, run: c.run })),
      profiles: gateProfiles,
      changedLineCoverage: 0.8,
      timeoutSec: config.gate.timeoutSec,
      retry: { max: forceRetry >= 0 ? forceRetry : config.gate.retry.max, budgetStepUsd: 0.05 },
    } satisfies GateConfig;

    if (onlyCommand && gateConfig.commands.length === 0) {
      console.error(`No gate command found with name "${onlyCommand}". Available: ${gateCommands.map((c) => c.name).join(', ')}`);
      return 1;
    }

    if (onlyCommand && !isJson) {
      console.log(`  Only:     ${onlyCommand}`);
    }

    // Run spec-md validation if --spec-md flag is set
    if (hasSpecMd) {
      const specMd = new SpecMdExecutor(resolve(process.cwd(), 'specs', 'slices'));
      const result = await specMd.validate(id);
      if (!result.valid) {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, specMdValid: false, specMdErrors: result.errors }));
        } else {
          console.log(`  Spec-MD: ❌ ${id} spec file validation failed`);
          for (const err of result.errors) {
            console.log(`    - ${err}`);
          }
        }
        return 1;
      }
      if (!isJson) {
        console.log(`  Spec-MD: ✅ ${id} spec file validated`);
      }
    }

    const worktreePath = existingWorktreePath(id);
    const gateRoot = worktreePath ?? targetDir ?? undefined;
    const executor = new GateExecutor(store, events, gateConfig, gateRoot);
    const report = await executor.execute(id);
    if (worktreePath && !isJson) {
      console.log(`  Worktree: ${worktreePath}`);
    }

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
      if (!r.passed && r.stderr) {
        // Show truncated stderr for failure debugging
        const stderrLines = r.stderr.split('\n').filter((l) => l.trim()).slice(0, 5);
        for (const line of stderrLines) {
          console.log(`       ${line.slice(0, 200)}`);
        }
      }
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
    // ADR-018: 签字只改状态。合并是显式动作 —— zelto merge <id>
    console.log(`  下一步：zelto merge ${req.sliceId}`);
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

// ─── spec-md on all slices (for gate --spec-md without slice-id) ──────────────

async function runSpecMdOnAllSlices(): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const slicesDir = resolve(process.cwd(), 'specs', 'slices');
  const executor = new SpecMdExecutor(slicesDir);
  try {
    const entries = await readdir(slicesDir);
    const mdFiles = entries.filter((f) => f.endsWith('.md'));
    if (mdFiles.length === 0) {
      console.log('No spec files found in specs/slices/.');
      return 0;
    }
    let validated = 0;
    let skipped = 0;
    let allValid = true;
    for (const file of mdFiles) {
      const sliceId = file.replace(/\.md$/, '');
      // Skip old-format spec files that don't have ## Spec section
      const content = await readFile(resolve(slicesDir, file), 'utf-8');
      if (!content.includes('## Spec')) {
        skipped++;
        continue;
      }
      const result = await executor.validate(sliceId);
      if (result.valid) {
        console.log(`  ✅ ${sliceId}`);
        validated++;
      } else {
        console.error(`  ❌ ${sliceId}`);
        for (const err of result.errors) {
          console.error(`     - ${err}`);
        }
        allValid = false;
      }
    }
    if (allValid) {
      console.log(`\n✅ ${validated} spec files validated (spec-md). ${skipped > 0 ? `${skipped} old-format skipped.` : ''}`);
    } else {
      console.error(`\n❌ Some spec files failed validation (spec-md). ${skipped > 0 ? `${skipped} old-format skipped.` : ''}`);
      return 1;
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error running spec-md on all slices: ${msg}`);
    return 1;
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
  // ADR-018 §3.3：--push 从签字迁到合并。推的必须是合并结果，不是签字那一刻的分支。
  if (args.includes('--push')) {
    const message = 'zelto sign 不再接受 --push（签字只改状态，不推远端）';
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, error: 'sign does not accept --push', message: `${message}：zelto merge ${id} --push` }));
    } else {
      console.error(message);
      console.error(`        要推送合并结果，请跑：zelto merge ${id} --push`);
    }
    return 1;
  }
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

      // ADR-018：签字只改状态。合并是显式动作 —— zelto merge <id>
      if (!isJson) {
        console.log(`下一步：zelto merge ${id}`);
      }
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
    } else if (action === '--revoke') {
      // 签错了要能回退：撤销已经通过的签字记录（ADR-021）
      const approved = await signManager.list('approved');
      const req = approved.find((r) => r.sliceId === id);
      if (!req) {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, action: 'revoked', error: 'No approved sign request' }));
        } else {
          console.error(`No approved sign request for slice "${id}".`);
          console.error('  只有已签字（approved）的切片才能撤销。');
        }
        return 1;
      }
      await signManager.revoke(req.id, 'human', comment);
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, action: 'revoked', signId: req.id }));
      } else {
        console.log(`zelto sign ${id} -- ↩️  Revoked (签字已作废)`);
        console.log('  切片仍是 completed：门禁结论保留，批准记录作废。');
        console.log('  修好之后重新发起签名请求，再走 zelto merge。');
      }
    } else {
      if (isJson) {
        console.log(JSON.stringify({ error: `Unknown action: ${action}` }));
      } else {
        console.error(`Unknown action: ${action}`);
        console.error('Usage: zelto sign <slice-id> [--approve|--reject|--revoke]');
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
