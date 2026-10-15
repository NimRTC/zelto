// CLI command dispatcher

import { GateExecutor } from '../core/gate/executor.js';
import { SignManager } from '../core/gate/sign.js';
import type { GateConfig } from '../core/gate/types.js';
import { Scheduler } from '../core/sched/engine.js';
import { SliceStore } from '../core/slice/store.js';
import { EventStream } from '../core/events/stream.js';
import type { PolicyConfig } from '../core/policy/types.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ZELTO_DIR = '.zelto';
const SLICES_DIR = join(ZELTO_DIR, 'slices');
const LOCKS_DIR = join(ZELTO_DIR, 'locks');
const EVENTS_DIR = join(ZELTO_DIR, 'events');

function loadPolicyConfig(): PolicyConfig {
  return {
    rules: [
      { id: 'allow-src-ts', match: { path: 'src/**/*.ts', operation: 'write' }, action: 'allow', basis: 'policy.yaml#allow-src-ts' },
      { id: 'allow-tests', match: { path: 'tests/**/*.ts', operation: 'write' }, action: 'allow', basis: 'policy.yaml#allow-tests' },
      { id: 'allow-read-all', match: { path: '**', operation: 'read' }, action: 'allow', basis: 'policy.yaml#allow-read-all', priority: 0 },
      { id: 'allow-docs', match: { path: 'docs/**', operation: 'write' }, action: 'allow', basis: 'policy.yaml#allow-docs' },
      { id: 'allow-config', match: { path: '.zelto/config.yaml', operation: 'write' }, action: 'ask', basis: 'policy.yaml#allow-config' },
      { id: 'deny-acceptance-direct', match: { path: 'tests/acceptance/**', operation: 'write' }, action: 'deny', basis: 'AGENTS.md#禁区-5', guidance: 'Acceptance tests are frozen with the spec.' },
    ],
    protected: ['policy/**', '.zelto/**', 'AGENTS.md', '.cursor/rules/**'],
  };
}

const store = new SliceStore(SLICES_DIR);
const events = new EventStream(EVENTS_DIR);

function loadConfig(): { gate: { commands: Array<{ name: string; run: string }>; timeoutSec: number; retry: { max: number } } } {
  const configPath = join(ZELTO_DIR, 'config.yaml');
  const defaultConfig = {
    commands: [{ name: 'test', run: 'pnpm test' }, { name: 'lint', run: 'pnpm lint' }],
    timeoutSec: 120,
    retry: { max: 2 },
  };

  if (!existsSync(configPath)) {
    return { gate: defaultConfig };
  }

  try {
    // Simple YAML-like parse for gate config
    const content = readFileSync(configPath, 'utf-8');
    // For now, just return defaults — proper YAML parsing comes later
    return { gate: defaultConfig };
  } catch {
    return { gate: defaultConfig };
  }
}

type Command = (args: string[]) => Promise<number>;

const commands: Record<string, Command> = {};

function register(name: string, fn: Command) {
  commands[name] = fn;
}

register('slices', async () => {
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

    // Gate① checks: verify trace completeness, spec existence, drift status
    const issues: string[] = [];
    if (slice.trace.requirements.length === 0) issues.push('No requirements traced');
    if (slice.trace.contracts.length === 0) issues.push('No contracts traced');
    if (slice.trace.tests.length === 0) issues.push('No tests traced');
    if (slice.drift.detected) issues.push(`Drift detected: ${slice.drift.reason}`);

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

    // Update frozen hash
    slice.spec.frozenHash = `sha256:${Date.now()}`; // Placeholder — real hash from spec file
    slice.spec.frozenAt = new Date().toISOString();

    // Transition state via store
    await store.transit(id, 'FREEZE');
    console.log(`zelto freeze ${id} — ✅ Slice frozen at ${slice.spec.frozenAt}`);
  } catch (err) {
    console.error(`Error freezing slice "${id}": ${err}`);
    return 1;
  }
  return 0;
});

register('run', async (args) => {
  const [id] = args;
  if (!id) {
    console.error('Usage: zelto run <slice-id> [--agent <name>] [--dry-run]');
    return 1;
  }

  try {
    const policy = loadPolicyConfig();
    const scheduler = new Scheduler(store, events, policy);

    // Check admission
    const result = await scheduler.admit(id);
    if (result.decision !== 'admitted') {
      console.error(`zelto run ${id} — ❌ Cannot run: ${result.reason}`);
      if (result.blockedBy.length > 0) {
        console.error(`  Blocked by: ${result.blockedBy.join(', ')}`);
      }
      return 1;
    }

    const slice = await store.read(id);
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

    // Start run
    await scheduler.startRun(id);

    console.log(`zelto run ${id} — ✅ Admitted and starting execution...`);
    console.log(`  Agent:   ${args.includes('--agent') ? args[args.indexOf('--agent') + 1] : 'default'}`);
    console.log(`  Run ID:  ${slice.runs.length + 1}`);

    // Show constraints
    const bundle = scheduler.buildConstraints(slice);
    console.log(`  Constraints:`);
    console.log(`    Write-set:     ${bundle.writes.join(', ') || '(none)'}`);
    console.log(`    Protected:     ${bundle.protectedPaths.join(', ')}`);
    console.log(`    Policy rules:  ${bundle.policyRules.length}`);
  } catch (err) {
    console.error(`Error running slice "${id}": ${err}`);
    return 1;
  }
  return 0;
});

register('gate', async (args) => {
  const [id] = args;
  if (!id) {
    console.error('Usage: zelto gate <slice-id>');
    return 1;
  }

  try {
    const slice = await store.read(id);
    if (slice.state !== 'frozen') {
      console.error(`Slice "${id}" is in state "${slice.state}". Must be "frozen" to run gate.`);
      return 1;
    }

    console.log(`zelto gate ${id} — running gate②...`);
    const config = loadConfig();

    // Build GateConfig from the loaded config
    const gateConfig = {
      commands: config.gate.commands.map((c) => ({ name: c.name, run: c.run })),
      changedLineCoverage: 0.8,
      timeoutSec: config.gate.timeoutSec,
      retry: { max: config.gate.retry.max, budgetStepUsd: 0.05 },
    } satisfies GateConfig;

    const executor = new GateExecutor(store, events, gateConfig);
    const report = await executor.execute(id);

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
      // Signal that sign is needed
      console.log(`  Next:     Run "zelto sign ${id} --approve" to approve`);
    } else {
      console.log(`  Result:   ❌ Gate failed (${report.totalDurationMs.toFixed(0)}ms)`);
    }
  } catch (err) {
    console.error(`Error running gate for "${id}": ${err}`);
    return 1;
  }
  return 0;
});

register('inbox', async () => {
  const signManager = new SignManager(ZELTO_DIR, events);
  const pending = await signManager.list('pending');

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
});

register('sign', async (args) => {
  const [id, action] = args;
  if (!id || !action) {
    console.error('Usage: zelto sign <slice-id> [--approve|--reject] [--comment <text>]');
    return 1;
  }

  const signManager = new SignManager(ZELTO_DIR, events);
  const commentIndex = args.indexOf('--comment');
  const comment = commentIndex >= 0 ? args[commentIndex + 1] : null;

  try {
    if (action === '--approve') {
      // Find pending sign request for this slice
      const pending = await signManager.list('pending');
      const req = pending.find((r) => r.sliceId === id);
      if (!req) {
        // Auto-create one
        const newReq = await signManager.request(id, 'human');
        await signManager.approve(newReq.id, 'human', comment);
        console.log(`zelto sign ${id} -- ✅ Approved (auto-requested)`);
      } else {
        await signManager.approve(req.id, 'human', comment);
        console.log(`zelto sign ${id} -- ✅ Approved`);
      }
    } else if (action === '--reject') {
      const pending = await signManager.list('pending');
      const req = pending.find((r) => r.sliceId === id);
      if (!req) {
        console.error(`No pending sign request for slice "${id}".`);
        return 1;
      }
      await signManager.reject(req.id, 'human', comment);
      console.log(`zelto sign ${id} -- ❌ Rejected`);
    } else {
      console.error(`Unknown action: ${action}`);
      console.error('Usage: zelto sign <slice-id> [--approve|--reject]');
      return 1;
    }
  } catch (err) {
    console.error(`Error processing sign for "${id}": ${err}`);
    return 1;
  }
  return 0;
});

register('next', async () => {
  const list = await store.list();
  if (list.length === 0) {
    console.log('No slices found. Create one to get started.');
    return 0;
  }

  // Find the first slice in earliest actionable state
  const priority: Array<string> = ['draft', 'clarifying', 'frozen', 'running', 'completed', 'abandoned'];
  for (const state of priority) {
    for (const id of list) {
      try {
        const s = await store.read(id);
        if (s.state === state) {
          const actions: Record<string, string> = {
            draft: 'zelto check <id> && zelto freeze <id>',
            clarifying: 'Complete clarification',
            frozen: 'zelto run <id> --dry-run',
            running: 'Wait for execution (blocking other slices?)',
            completed: 'zelto sign <id> --approve',
            abandoned: 'Restart or archive',
          };
          console.log(`Next: ${id} (${s.state})`);
          console.log(`  ${s.title}`);
          console.log(`  Action: ${actions[s.state]?.replaceAll('<id>', id) ?? 'Review'}`);
          return 0;
        }
      } catch {
        // Skip unreadable slices
      }
    }
  }

  console.log('All slices are up to date.');
  return 0;
});

register('help', async () => {
  console.log(`
zelto — AI Programming Cockpit

Commands:
  slices                    List all slices
  next                      Show recommended next slice
  check <id>                Run gate① (deterministic checks)
  freeze <id>               Freeze slice baseline
  run <id> [--agent <n>]    Execute slice (with parallel admission check)
  run <id> --dry-run        Check admission without executing
  gate <id>                 Run gate② (acceptance tests)
  inbox                     Show pending sign queue
  sign <id> --approve       Approve slice
  sign <id> --reject        Reject slice
  help                      Show this help
`);
  return 0;
});

export async function runCLI(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === 'help' || cmd === '--help') {
    return commands.help!([]);
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}`);
    console.error('Run "zelto help" for usage.');
    return 1;
  }

  return handler(rest);
}
