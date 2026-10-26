// Core slice lifecycle commands: slices, create, check, clarify, abandon, freeze, run, admit

import { createInterface } from 'node:readline';
import { writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAgentAdapter } from '../../adapters/claude-agent/index.js';
import { ClarifyEngine } from '../../core/clarify/engine.js';
import { Scheduler } from '../../core/sched/engine.js';
import { BudgetCollector } from '../../core/budget/collector.js';
import { GateExecutor } from '../../core/gate/executor.js';
import { SignManager } from '../../core/gate/sign.js';
import type { GateConfig } from '../../core/gate/types.js';
import { classifyStall } from '../../core/stall/classifier.js';
import { register } from './shared.js';
import { store, events, ZELTO_DIR, loadPolicyConfig, hashSpecFile, loadConfig } from './shared.js';

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Detect common source directories for default write-set.
 * Scans the project root for typical source directory names.
 */
function detectDefaultWrites(): string[] {
  const candidates = ['src', 'lib', 'app', 'tools', 'scripts', 'tests', 'docs', 'include', 'assets', 'public', 'components', 'pages'];
  const found: string[] = [];
  try {
    const entries = readdirSync(process.cwd());
    for (const entry of entries) {
      if (candidates.includes(entry)) {
        try {
          if (statSync(join(process.cwd(), entry)).isDirectory()) {
            found.push(`${entry}/**`);
          }
        } catch { /* skip */ }
      }
      // Also detect root-level config files
      if (entry === 'CMakeLists.txt' || entry === 'Makefile' || entry === 'package.json' || entry === 'Cargo.toml' || entry === 'go.mod') {
        if (!found.includes(entry)) found.push(entry);
      }
    }
  } catch { /* cannot read cwd */ }
  return found;
}

// ─── slices ──────────────────────────────────────────────────────────────────

register('slices', async (args) => {
  const doPrune = args.includes('--prune');

  if (doPrune) {
    return await pruneSlices();
  }

  const list = await store.list();
  if (list.length === 0) {
    console.log('No slices found.');
    return 0;
  }

  console.log('Slices:');
  for (const id of list) {
    try {
      const s = await store.read(id);
      console.log(`  ${id.padEnd(20)} ${s.state.padEnd(15)} ${s.title}`);
    } catch {
      console.log(`  ${id} (error reading)`);
    }
  }
  return 0;
});

/**
 * Remove abandoned slices and their events from disk.
 */
async function pruneSlices(): Promise<number> {
  const { rmSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const list = await store.list();
  let removed = 0;

  for (const id of list) {
    try {
      const s = await store.read(id);
      if (s.state !== 'abandoned') continue;

      // Remove slice file
      const slicePath = join('.zelto', 'slices', `${id}.json`);
      if (existsSync(slicePath)) {
        rmSync(slicePath, { force: true });
      }

      // Remove events directory
      const eventsDir = join('.zelto', 'events', id);
      if (existsSync(eventsDir)) {
        rmSync(eventsDir, { recursive: true, force: true });
      }

      // Remove bundle if exists
      const bundlePath = join('.zelto', `${id}-bundle.json`);
      if (existsSync(bundlePath)) {
        rmSync(bundlePath, { force: true });
      }

      console.log(`  🗑️  Removed abandoned slice: ${id}`);
      removed++;
    } catch {
      // Skip problematic slices
    }
  }

  if (removed === 0) {
    console.log('No abandoned slices to remove.');
  } else {
    console.log(`\n✅ Removed ${removed} abandoned slice(s).`);
  }
  return 0;
}

// ─── create ──────────────────────────────────────────────────────────────────

register('create', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto create <slice-id> [--title <title>] [--writes <path1,path2,...>]');
    return 1;
  }

  const titleIdx = args.indexOf('--title');
  const title = titleIdx >= 0 ? args.slice(titleIdx + 1).join(' ') : id;

  const writesIdx = args.indexOf('--writes');
  const writes = writesIdx >= 0 ? args[writesIdx + 1].split(',').map((w: string) => w.trim()).filter(Boolean) : [];

  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    console.error(`Invalid slice ID: "${id}". Use only letters, numbers, hyphens, and underscores.`);
    return 1;
  }

  if (await store.exists(id)) {
    console.error(`Slice "${id}" already exists.`);
    return 1;
  }

  const slice = store.create(id, title, { writes });
  await store.write(slice);
  await events.append(id, 'spec.drafted', 'cli', { sliceId: id, title, specPath: slice.spec.path });
  console.log(`zelto create ${id} — ✅ Created`);
  console.log(`  ID:     ${id}`);
  console.log(`  Title:  ${title}`);
  console.log(`  State:  ${slice.state}`);
  console.log(`  Writes: ${writes.length > 0 ? writes.join(', ') : '(none)'}`);
  console.log(`  Spec:   ${slice.spec.path}`);
  console.log(`  Next:   zelto check ${id} && zelto freeze ${id}`);
  return 0;
});

// ─── check ───────────────────────────────────────────────────────────────────

register('check', async (args) => {
  const [id] = args;
  if (!id) {
    console.error('Usage: zelto check <slice-id>');
    return 1;
  }

  try {
    const slice = await store.read(id);
    console.log(`zelto check ${id} — running gate① checks...`);
    console.log(`  Slice:   ${slice.title}`);
    console.log(`  State:   ${slice.state}`);
    console.log(`  Spec:    ${slice.spec.path}`);
    console.log(`  Traces:  ${slice.trace.requirements.length} reqs, ${slice.trace.contracts.length} contracts, ${slice.trace.tests.length} tests`);

    const issues: string[] = [];
    if (slice.trace.requirements.length === 0) issues.push('No requirements traced');
    if (slice.trace.contracts.length === 0) issues.push('No contracts traced');
    if (slice.trace.tests.length === 0) issues.push('No tests traced');
    if (slice.drift.detected) issues.push(`Drift detected: ${slice.drift.reason}`);

    if (slice.spec.frozenHash) {
      const currentHash = hashSpecFile(slice.spec.path);
      if (currentHash && currentHash !== slice.spec.frozenHash) {
        issues.push('Spec file has changed since freeze (hash mismatch)');
        await events.append(id, 'slice.drift_detected', 'cli', {
          sliceId: id, expectedHash: slice.spec.frozenHash, actualHash: currentHash,
          reason: 'Spec file hash mismatch after freeze',
        });
      } else if (!currentHash) {
        issues.push('Spec file not found');
      } else {
        console.log(`  Spec hash: ✅ ${slice.spec.frozenHash.slice(0, 12)}...`);
      }
    }

    await events.append(id, 'spec.checked', 'cli', {
      sliceId: id, issues: issues.length, passed: issues.length === 0, details: issues,
    });

    if (issues.length === 0) {
      console.log('  Result:  ✅ All checks passed');
    } else {
      console.log(`  Issues:  ${issues.join(', ')}`);
      console.log('  Result:  ⚠️  Fix issues before freezing');
    }
  } catch (err) {
    console.error(`Error reading slice "${id}": ${err}`);
    return 1;
  }
  return 0;
});

// ─── clarify ─────────────────────────────────────────────────────────────────

register('clarify', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto clarify <slice-id> [--auto] [--dry-run]');
    return 1;
  }

  const isAuto = args.includes('--auto');
  const isDryRun = args.includes('--dry-run');

  try {
    const slice = await store.read(id);
    if (slice.state !== 'draft' && slice.state !== 'clarifying') {
      console.error(`Slice "${id}" is in state "${slice.state}". Only draft/clarifying slices can be clarified.`);
      return 1;
    }

    const engine = new ClarifyEngine(events);

    if (slice.state === 'draft') {
      if (!isDryRun) {
        await store.transit(id, 'CLARIFY_START');
        await events.append(id, 'slice.state.changed', 'cli', {
          sliceId: id, from: 'draft', to: 'clarifying', event: 'CLARIFY_START',
        });
        console.log(`zelto clarify ${id} — entering clarification...`);
      } else {
        console.log(`zelto clarify ${id} — dry-run (no changes made)...`);
      }
    } else {
      console.log(`zelto clarify ${id} — continuing clarification...`);
    }

    const current = isDryRun ? slice : await store.read(id);
    const round = (current.runs?.length ?? 0) + 1;

    if (isAuto || isDryRun) {
      const result = engine.generateQuestions(current, round);

      if (result.converged) {
        console.log('  ✅ No open questions — slice is already complete.');
        return 0;
      }

      console.log(`  Questions: ${result.questions.length}`);
      for (const q of result.questions) {
        console.log(`    [${q.id}] ${q.text}`);
        console.log(`           Default: ${q.default}`);
      }

      if (isDryRun) {
        console.log(`\n  Run without --dry-run to auto-answer with defaults.`);
        return 0;
      }

      for (const q of result.questions) {
        const answer = { questionId: q.id, answer: q.default, answeredBy: 'zelto' };
        engine.applyAnswers(current, [answer]);
        await events.append(id, 'clarify.answer', 'zelto', {
          questionId: q.id, answer: q.default, selfAnswered: true,
        });
      }

      await store.write(current);
      console.log(`  ✅ All questions auto-answered.`);

      await store.transit(id, 'CLARIFY_CONVERGED');
      await events.append(id, 'slice.state.changed', 'cli', {
        sliceId: id, from: 'clarifying', to: 'draft', event: 'CLARIFY_CONVERGED',
      });
      const afterConverge = await store.read(id);

      const specHash = hashSpecFile(afterConverge.spec.path);
      afterConverge.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
      afterConverge.spec.frozenAt = new Date().toISOString();
      await store.write(afterConverge);
      await store.transit(id, 'FREEZE');
      await events.append(id, 'spec.frozen', 'zelto', {
        sliceId: id, frozenHash: afterConverge.spec.frozenHash, frozenAt: afterConverge.spec.frozenAt,
      });

      console.log(`  ✅ Slice frozen at ${afterConverge.spec.frozenAt}`);
      console.log(`  Next: zelto run ${id} --dry-run`);
      return 0;
    }

    // Interactive mode
    const result = engine.generateQuestions(current, round);

    if (result.converged) {
      console.log('  ✅ No open questions — slice is already complete.');
      return 0;
    }

    console.log('');
    const answers: Array<{ questionId: string; answer: string; answeredBy: string }> = [];

    for (let i = 0; i < result.questions.length; i++) {
      const q = result.questions[i];
      console.log(`  ${i + 1}/${result.questions.length}: ${q.text}`);
      console.log(`    Candidates: ${q.candidates.join(', ')}`);
      console.log(`    Default: ${q.default}`);
      console.log(`    Impact: ${q.impact}, Reversibility: ${q.reversibility}`);

      if (!process.stdout.isTTY) {
        console.log(`    → Using default (non-TTY): ${q.default}`);
        answers.push({ questionId: q.id, answer: q.default, answeredBy: 'zelto' });
      } else {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const input = await new Promise<string>((resolve) => {
          rl.question('    > ', resolve);
        });
        rl.close();
        const chosen = input.trim() || q.default;
        answers.push({ questionId: q.id, answer: chosen, answeredBy: 'human' });
      }
      console.log('');
    }

    engine.applyAnswers(current, answers);
    await store.write(current);

    for (const a of answers) {
      await events.append(id, 'clarify.answer', a.answeredBy, {
        questionId: a.questionId, answer: a.answer,
      });
    }

    console.log(`  ✅ All questions answered.`);

    await store.transit(id, 'CLARIFY_CONVERGED');
    const afterConverge = await store.read(id);

    const specHash = hashSpecFile(afterConverge.spec.path);
    afterConverge.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
    afterConverge.spec.frozenAt = new Date().toISOString();
    await store.write(afterConverge);
    await store.transit(id, 'FREEZE');
    await events.append(id, 'spec.frozen', 'human', {
      sliceId: id, frozenHash: afterConverge.spec.frozenHash, frozenAt: afterConverge.spec.frozenAt,
    });

    console.log(`  ✅ Slice frozen at ${afterConverge.spec.frozenAt}`);
    console.log(`  Next: zelto run ${id} --dry-run`);
    return 0;
  } catch (err) {
    console.error(`Error clarifying slice "${id}": ${err}`);
    return 1;
  }
});

// ─── abandon ─────────────────────────────────────────────────────────────────

register('abandon', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto abandon <slice-id>');
    return 1;
  }

  try {
    const slice = await store.read(id);
    if (slice.state === 'abandoned') {
      console.error(`Slice "${id}" is already abandoned.`);
      return 1;
    }

    const prevState = slice.state;
    await store.transit(id, 'ABANDON');

    await events.append(id, 'slice.state.changed', 'cli', {
      sliceId: id, from: prevState, to: 'abandoned', event: 'ABANDON',
    });

    console.log(`zelto abandon ${id} — ✅ Slice abandoned`);
    console.log(`  Previous state: ${prevState}`);
    console.log(`  Now:            abandoned`);
    return 0;
  } catch (err) {
    console.error(`Error abandoning slice "${id}": ${err}`);
    return 1;
  }
});

// ─── freeze ──────────────────────────────────────────────────────────────────

register('freeze', async (args) => {
  const [id] = args;
  if (!id) {
    console.error('Usage: zelto freeze <slice-id>');
    return 1;
  }

  try {
    const slice = await store.read(id);
    if (slice.state !== 'draft' && slice.state !== 'clarifying') {
      console.error(`Slice "${id}" is in state "${slice.state}", cannot freeze.`);
      return 1;
    }

    const specHash = hashSpecFile(slice.spec.path);
    slice.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    await store.transit(id, 'FREEZE');
    await events.append(id, 'spec.frozen', 'cli', {
      sliceId: id, frozenHash: slice.spec.frozenHash, frozenAt: slice.spec.frozenAt,
    });
    console.log(`zelto freeze ${id} — ✅ Slice frozen at ${slice.spec.frozenAt}`);
  } catch (err) {
    console.error(`Error freezing slice "${id}": ${err}`);
    return 1;
  }
  return 0;
});

// ─── run ─────────────────────────────────────────────────────────────────────

register('run', async (args) => {
  const [id] = args;
  if (!id) {
    console.error('Usage: zelto run <slice-id> [--agent <name>] [--dry-run]');
    return 1;
  }

  try {
    const scheduler = new Scheduler(store, events, loadPolicyConfig());

    const result = await scheduler.admit(id);
    if (result.decision !== 'admitted') {
      console.error(`zelto run ${id} — ❌ Cannot run: ${result.reason}`);
      if (result.blockedBy.length > 0) {
        console.error(`  Blocked by: ${result.blockedBy.join(', ')}`);
      }
      return 1;
    }

    const slice = await store.read(id);

    // Auto-detect write-set if empty
    if (slice.writes.length === 0) {
      const detected = detectDefaultWrites();
      if (detected.length > 0) {
        slice.writes = detected;
        await store.write(slice);
        console.log(`  Auto-detected write-set: ${detected.join(', ')}`);
      } else {
        console.warn('  ⚠️  No write-set detected — agent will have no files to modify');
      }
    }

    // Check budget before starting run
    const budgetOk = await checkBudget(id);
    if (!budgetOk) {
      console.error(`zelto run ${id} — ❌ Budget exhausted`);
      return 1;
    }

    const isDryRun = args.includes('--dry-run');

    if (isDryRun) {
      console.log(`zelto run ${id} — ✅ Would admit (dry-run)`);
      const bundle = scheduler.buildConstraints(slice);
      console.log(`  Spec:          ${bundle.specPath}`);
      console.log(`  Frozen hash:   ${bundle.frozenHash}`);
      console.log(`  Write-set:     ${bundle.writes.join(', ') || '(none)'}`);
      console.log(`  Policy rules:  ${bundle.policyRules.length}`);
      console.log(`  Instructions:  ${bundle.instructions.split('\n').length} lines`);
      return 0;
    }

    await scheduler.startRun(id);

    const bundle = scheduler.buildConstraints(slice);
    console.log(`zelto run ${id} — ✅ Admitted and starting execution...`);
    console.log(`  Write-set:     ${bundle.writes.join(', ') || '(none)'}`);
    console.log(`  Protected:     ${bundle.protectedPaths.join(', ')}`);
    console.log(`  Policy rules:  ${bundle.policyRules.length}`);

    const bundlePath = join(ZELTO_DIR, `${id}-bundle.json`);
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');

    const cfg = loadConfig();
    const agentCmd = cfg.agent.command;
    const agentName = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : agentCmd;

    console.log(`  Agent:         ${agentName}`);
    console.log(`  Bundle:        ${bundlePath}`);
    console.log('');

    const adapter = new ClaudeAgentAdapter({ cwd: process.cwd(), agentCommand: agentName });
    const { sessionId } = await adapter.start({ sliceId: id, prompt: bundlePath });

    await events.append(id, 'run.started', 'zelto', {
      sliceId: id, agent: agentName, bundlePath, writes: bundle.writes,
    });

    const exitCode = await adapter.waitForExit(sessionId);

    if (exitCode === 0) {
      await store.transit(id, 'RUN_FINISH');
      await events.append(id, 'run.finished', 'zelto', { sliceId: id, exitCode: 0 });
      console.log(`\n✅ Agent completed successfully (exit 0)`);

      // Auto-run gate and create sign request on pass
      await autoGateAfterRun(id);
    } else {
      await events.append(id, 'run.aborted', 'zelto', { sliceId: id, exitCode });
      console.log(`\n❌ Agent exited with code ${exitCode}`);

      // Auto-classify stall for non-zero exit
      await autoClassifyStall(id, exitCode);
    }
  } catch (err) {
    console.error(`Error running slice "${id}": ${err}`);
    return 1;
  }
  return 0;
});

// ─── admit ───────────────────────────────────────────────────────────────────

register('admit', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto admit <slice-id> [--json]');
    return 1;
  }

  const isJson = args.includes('--json');

  try {
    const scheduler = new Scheduler(store, events, loadPolicyConfig());

    const result = await scheduler.admit(id);
    if (result.decision !== 'admitted') {
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, decision: 'blocked', reason: result.reason, blockedBy: result.blockedBy }));
      } else {
        console.log(`❌ Blocked: ${result.reason}`);
        if (result.blockedBy.length > 0) {
          console.log(`  Blocked by: ${result.blockedBy.join(', ')}`);
        }
      }
      return 1;
    }

    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, decision: 'admitted', reason: null, blockedBy: [] }));
    } else {
      console.log(`✅ Admitted: ${id}`);
    }
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(`Error: ${msg}`);
    }
    return 1;
  }
});

// ─── budget check (shared helper) ──────────────────────────────────────────────

/**
 * Check if a slice has exceeded its budget limit.
 * Returns true if budget is OK, false if exhausted.
 */
async function checkBudget(id: string): Promise<boolean> {
  try {
    const budget = new BudgetCollector(events, ZELTO_DIR);
    const exhausted = await budget.isExhausted(id);
    if (exhausted) {
      const [spent, limit] = await Promise.all([budget.getSpent(id), budget.getLimit(id)]);
      console.error(`  ⛔ Budget exhausted: $${spent.toFixed(2)} spent of $${limit.toFixed(2)} limit`);
      await events.append(id, 'stall.classified', 'zelto', {
        sliceId: id, class: 'budget_exhausted', spent, limit,
      });
      return false;
    }
    return true;
  } catch (err) {
    // Budget check failure is non-fatal — proceed without enforcement
    return true;
  }
}

// ─── auto gate after run (shared helper) ─────────────────────────────────────

async function autoGateAfterRun(id: string): Promise<void> {
  const config = loadConfig();
  const gateConfig: GateConfig = {
    commands: config.gate.commands.map((c) => ({ name: c.name, run: c.run })),
    changedLineCoverage: 0.8,
    timeoutSec: config.gate.timeoutSec,
    retry: { max: config.gate.retry.max, budgetStepUsd: 0.05 },
  };

  const executor = new GateExecutor(store, events, gateConfig);
  console.log(`\n  Auto-running gate②...`);
  const report = await executor.execute(id);

  console.log(`  Gate commands: ${report.results.length}`);
  for (const r of report.results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`    ${icon} ${r.command} (${r.durationMs.toFixed(0)}ms, exit ${r.exitCode ?? 'signal'})`);
  }

  if (report.passed) {
    console.log(`  Gate: ✅ Passed (${report.totalDurationMs.toFixed(0)}ms)`);
    await store.transit(id, 'GATE_PASS');
    await events.append(id, 'slice.state.changed', 'zelto', {
      sliceId: id, from: 'frozen', to: 'completed', event: 'GATE_PASS',
    });

    const signManager = new SignManager(ZELTO_DIR, events, store);
    const signReq = await signManager.request(id, 'zelto');
    console.log(`  Sign: 📋 Request created (${signReq.id})`);
    console.log(`  Next: zelto sign ${id} --approve`);
  } else {
    console.log(`  Gate: ❌ Failed (${report.totalDurationMs.toFixed(0)}ms)`);
    if (report.retryCount > 0) {
      console.log(`  Retries: ${report.retryCount}`);
    }
    console.log(`  Run: zelto gate ${id} to retry`);
  }
}

async function autoClassifyStall(id: string, exitCode: number | null): Promise<void> {
  const stallClass = classifyStall({
    type: exitCode === null ? 'build_failure' : 'environment_failure',
    message: `Agent exited with code ${exitCode ?? 'signal'}`,
    attempts: 1,
  });

  try {
    const slice = await store.read(id);
    slice.stall.class = stallClass;
    slice.stall.autoResolved = 0;
    slice.stall.gateRetries = 0;
    await store.write(slice);

    await events.append(id, 'stall.classified', 'zelto', {
      sliceId: id, class: stallClass, exitCode, runAborted: true,
    });

    console.log(`  Stall: ⚠️ Classified as "${stallClass}"`);
    console.log(`  Run: zelto resume ${id} to handle`);
  } catch (err) {
    console.error(`  ⚠️ Could not write stall info: ${err}`);
  }
}

// ─── start ────────────────────────────────────────────────────────────────────

register('start', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto start <slice-id> [--title <title>] [--writes <path1,path2,...>] [--agent <name>]');
    return 1;
  }

  const titleIdx = args.indexOf('--title');
  const title = titleIdx >= 0 ? args.slice(titleIdx + 1).join(' ') : id;

  const writesIdx = args.indexOf('--writes');
  const customWrites = writesIdx >= 0 ? args[writesIdx + 1].split(',').map((w: string) => w.trim()).filter(Boolean) : null;

  // Step 1: Create if not exists
  let isNew = false;
  if (!(await store.exists(id))) {
    const writes = customWrites ?? detectDefaultWrites();
    const slice = store.create(id, title, { writes });
    await store.write(slice);
    await events.append(id, 'spec.drafted', 'cli', { sliceId: id, title, specPath: slice.spec.path });
    console.log(`  ✅ Created: ${id}`);
    if (writes.length > 0) {
      console.log(`  Write-set: ${writes.join(', ')}`);
    }
    isNew = true;
  } else {
    console.log(`  ℹ️  Already exists: ${id}`);
  }

  // Step 2: Freeze (if not already frozen)
  try {
    const current = await store.read(id);
    if (current.state === 'draft' || current.state === 'clarifying') {
      // Write a default spec if none exists
      const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
      const specPath = current.spec.path;
      if (!existsSync(specPath)) {
        const specDir = specPath.substring(0, specPath.lastIndexOf('/'));
        if (!existsSync(specDir)) {
          mkdirSync(specDir, { recursive: true });
        }
        writeFileSync(specPath, `# ${current.title}\n\n## Summary\n\n## Design\n\n## Acceptance Criteria\n`, 'utf-8');
      }

      const { hashSpecFile } = await import('./shared.js');
      const specHash = hashSpecFile(specPath);
      current.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
      current.spec.frozenAt = new Date().toISOString();
      await store.write(current);
      await store.transit(id, 'FREEZE');
      await events.append(id, 'spec.frozen', 'cli', {
        sliceId: id, frozenHash: current.spec.frozenHash, frozenAt: current.spec.frozenAt,
      });
      console.log(`  ✅ Frozen: ${id}`);
    } else {
      console.log(`  ℹ️  Already frozen: ${id} (state=${current.state})`);
    }
  } catch (err) {
    console.error(`  ❌ Freeze failed: ${err}`);
    return 1;
  }

  // Step 3: Run the agent
  try {
    const scheduler = new Scheduler(store, events, loadPolicyConfig());

    const admitResult = await scheduler.admit(id);
    if (admitResult.decision !== 'admitted') {
      console.error(`  ❌ Cannot run: ${admitResult.reason}`);
      return 1;
    }

    // Check budget before starting run
    const budgetOk = await checkBudget(id);
    if (!budgetOk) {
      console.error(`  ❌ Budget exhausted`);
      return 1;
    }

    await scheduler.startRun(id);

    const slice = await store.read(id);
    const bundle = scheduler.buildConstraints(slice);
    const bundlePath = join(ZELTO_DIR, `${id}-bundle.json`);
    const { writeFileSync: write } = await import('node:fs');
    write(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');

    const cfg = loadConfig();
    const agentCmd = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : cfg.agent.command;
    const agentName = agentCmd;

    console.log(`  Agent:         ${agentName}`);

    const adapter = new ClaudeAgentAdapter({ cwd: process.cwd(), agentCommand: agentName });
    const { sessionId } = await adapter.start({ sliceId: id, prompt: bundlePath });

    await events.append(id, 'run.started', 'zelto', {
      sliceId: id, agent: agentName, bundlePath, writes: bundle.writes,
    });

    const exitCode = await adapter.waitForExit(sessionId);

    if (exitCode === 0) {
      await store.transit(id, 'RUN_FINISH');
      await events.append(id, 'run.finished', 'zelto', { sliceId: id, exitCode: 0 });
      console.log(`  ✅ Agent completed successfully (exit 0)`);

      // Auto-run gate and create sign request on pass
      await autoGateAfterRun(id);
    } else {
      await events.append(id, 'run.aborted', 'zelto', { sliceId: id, exitCode });
      console.log(`  ❌ Agent exited with code ${exitCode}`);

      // Auto-classify stall for non-zero exit
      await autoClassifyStall(id, exitCode);
    }
  } catch (err) {
    console.error(`  ❌ Agent execution failed: ${err}`);
    return 1;
  }

  return 0;
});
