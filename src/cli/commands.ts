// CLI command dispatcher

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ClaudeAgentAdapter } from '../adapters/claude-agent/index.js';
import { EventStream } from '../core/events/stream.js';
import { ClarifyEngine } from '../core/clarify/engine.js';
import { GateExecutor } from '../core/gate/executor.js';
import { SignManager } from '../core/gate/sign.js';
import type { GateConfig } from '../core/gate/types.js';
import type { Decision, PolicyConfig, PolicyRule } from '../core/policy/types.js';
import { Scheduler } from '../core/sched/engine.js';
import { SliceStore } from '../core/slice/store.js';

const ZELTO_DIR = '.zelto';
const SLICES_DIR = join(ZELTO_DIR, 'slices');
const _LOCKS_DIR = join(ZELTO_DIR, 'locks');
const EVENTS_DIR = join(ZELTO_DIR, 'events');

function loadPolicyConfig(): PolicyConfig {
  // Try to read from policy/policy.yaml
  const policyPath = join('policy', 'policy.yaml');
  if (existsSync(policyPath)) {
    try {
      const content = readFileSync(policyPath, 'utf-8');
      const parsed = parsePolicyYaml(content);
      if (parsed.rules.length > 0) {
        return {
          rules: parsed.rules,
          protected: ['policy/**', '.zelto/**', 'AGENTS.md', '.cursor/rules/**'],
        };
      }
    } catch {
      // Fall through to defaults
    }
  }

  // Fallback: hardcoded defaults
  return {
    rules: [
      {
        id: 'allow-src-ts',
        match: { path: 'src/**/*.ts', operation: 'write' },
        action: 'allow',
        basis: 'policy.yaml#allow-src-ts',
      },
      {
        id: 'allow-tests',
        match: { path: 'tests/**/*.ts', operation: 'write' },
        action: 'allow',
        basis: 'policy.yaml#allow-tests',
      },
      {
        id: 'allow-read-all',
        match: { path: '**', operation: 'read' },
        action: 'allow',
        basis: 'policy.yaml#allow-read-all',
        priority: 0,
      },
      {
        id: 'allow-docs',
        match: { path: 'docs/**', operation: 'write' },
        action: 'allow',
        basis: 'policy.yaml#allow-docs',
      },
      {
        id: 'allow-config',
        match: { path: '.zelto/config.yaml', operation: 'write' },
        action: 'ask',
        basis: 'policy.yaml#allow-config',
      },
      {
        id: 'deny-acceptance-direct',
        match: { path: 'tests/acceptance/**', operation: 'write' },
        action: 'deny',
        basis: 'AGENTS.md#禁区-5',
        guidance: 'Acceptance tests are frozen with the spec.',
      },
    ],
    protected: ['policy/**', '.zelto/**', 'AGENTS.md', '.cursor/rules/**'],
  };
}

const store = new SliceStore(SLICES_DIR);
const events = new EventStream(EVENTS_DIR);

function hashSpecFile(specPath: string): string | null {
  try {
    const content = readFileSync(specPath, 'utf-8');
    return `sha256:${createHash('sha256').update(content).digest('hex')}`;
  } catch {
    return null;
  }
}

function loadConfig(): {
  gate: {
    commands: Array<{ name: string; run: string }>;
    timeoutSec: number;
    retry: { max: number };
  };
  agent: { command: string };
} {
  const configPath = join(ZELTO_DIR, 'config.yaml');
  const defaultConfig = {
    gate: {
      commands: [
        { name: 'test', run: 'pnpm test' },
        { name: 'lint', run: 'pnpm lint' },
      ],
      timeoutSec: 120,
      retry: { max: 2 },
    },
    agent: {
      command: 'npx claude-code',
    },
  };

  if (!existsSync(configPath)) {
    return defaultConfig;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseConfigYaml(content);
    if (parsed) {
      return {
        gate: parsed.gate,
        agent: parsed.agent ?? defaultConfig.agent,
      };
    }
    return defaultConfig;
  } catch {
    return defaultConfig;
  }
}

function parseConfigYaml(content: string): {
  gate: {
    commands: Array<{ name: string; run: string }>;
    timeoutSec: number;
    retry: { max: number };
  };
  agent: { command: string };
} | null {
  const commands: Array<{ name: string; run: string }> = [];
  let timeoutSec = 120;
  let retryMax = 2;
  let agentCommand = 'npx claude-code';
  let currentCommand: { name: string; run: string } | null = null;
  let inGateSection = false;
  let inAgentSection = false;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed === 'gate:') {
      inGateSection = true;
      inAgentSection = false;
      continue;
    }
    if (trimmed === 'agent:') {
      inAgentSection = true;
      inGateSection = false;
      continue;
    }

    if (inGateSection) {
      if (trimmed === '- name: test' || trimmed.startsWith('- name:')) {
        if (currentCommand) commands.push(currentCommand);
        currentCommand = { name: trimmed.slice(7).trim(), run: '' };
        continue;
      }

      if (trimmed.startsWith('run:')) {
        if (currentCommand) {
          currentCommand.run = trimmed.slice(4).trim().replace(/^"|"$/g, '');
        }
        continue;
      }

      if (trimmed.startsWith('timeoutSec:')) {
        timeoutSec = Number.parseInt(trimmed.slice(11).trim(), 10) || 120;
        continue;
      }

      if (trimmed.startsWith('max:')) {
        retryMax = Number.parseInt(trimmed.slice(4).trim(), 10) || 2;
        continue;
      }
    }

    if (inAgentSection && trimmed.startsWith('command:')) {
      agentCommand = trimmed.slice(8).trim().replace(/^"|"$/g, '');
    }
  }

  if (currentCommand) commands.push(currentCommand);

  return commands.length > 0
    ? {
        gate: { commands, timeoutSec, retry: { max: retryMax } },
        agent: { command: agentCommand },
      }
    : null;
}

// YAML parser for policy/policy.yaml (same format as hook's parser)
function parsePolicyYaml(content: string): { rules: PolicyRule[] } {
  const rules: PolicyRule[] = [];
  let currentRule: Record<string, unknown> | null = null;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed.startsWith('- id:')) {
      if (currentRule?.id) rules.push(currentRule as unknown as PolicyRule);
      currentRule = { id: trimmed.slice(5).trim(), match: {} };
      continue;
    }

    if (!currentRule) continue;

    const matchInline = trimmed.match(
      /^match:\s*\{\s*path:\s*"([^"]*)"\s*(?:,\s*operation:\s*"([^"]*)")?\s*\}/,
    );
    if (matchInline) {
      currentRule.match = {
        path: matchInline[1],
        ...(matchInline[2] ? { operation: matchInline[2] } : {}),
      };
      continue;
    }

    if (trimmed.startsWith('path:')) {
      currentRule.match = {
        ...(currentRule.match as Record<string, unknown>),
        path: trimmed.slice(5).trim().replace(/^"|"$/g, ''),
      };
      continue;
    }

    if (trimmed.startsWith('operation:')) {
      currentRule.match = {
        ...(currentRule.match as Record<string, unknown>),
        operation: trimmed.slice(10).trim().replace(/^"|"$/g, ''),
      };
      continue;
    }

    if (trimmed.startsWith('action:')) {
      currentRule.action = trimmed.slice(7).trim() as Decision;
      continue;
    }

    if (trimmed.startsWith('basis:')) {
      currentRule.basis = trimmed.slice(6).trim().replace(/^"|"$/g, '');
      continue;
    }

    if (trimmed.startsWith('guidance:')) {
      currentRule.guidance = trimmed.slice(9).trim().replace(/^"|"$/g, '');
      continue;
    }

    if (trimmed.startsWith('priority:')) {
      currentRule.priority = Number.parseInt(trimmed.slice(9).trim(), 10);
    }
  }

  if (currentRule?.id) rules.push(currentRule as unknown as PolicyRule);
  return { rules };
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

register('create', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto create <slice-id> [--title <title>]');
    return 1;
  }

  // Parse options
  const titleIdx = args.indexOf('--title');
  const title = titleIdx >= 0 ? args.slice(titleIdx + 1).join(' ') : id;

  // Validate ID format
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    console.error(
      `Invalid slice ID: "${id}". Use only letters, numbers, hyphens, and underscores.`,
    );
    return 1;
  }

  // Check if already exists
  if (await store.exists(id)) {
    console.error(`Slice "${id}" already exists.`);
    return 1;
  }

  const slice = store.create(id, title);

  // Write to disk
  await store.write(slice);

  // Emit spec.drafted event
  await events.append(id, 'spec.drafted', 'cli', {
    sliceId: id,
    title,
    specPath: slice.spec.path,
  });

  console.log(`zelto create ${id} — ✅ Slice created`);
  console.log(`  ID:      ${id}`);
  console.log(`  Title:   ${title}`);
  console.log(`  State:   ${slice.state}`);
  console.log(`  Spec:    ${slice.spec.path}`);
  console.log(`  Next:    zelto check ${id}`);
  return 0;
});

register('start', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto start <slice-id> [--title <title>]');
    return 1;
  }

  const titleIdx = args.indexOf('--title');
  const title = titleIdx >= 0 ? args.slice(titleIdx + 1).join(' ') : id;

  try {
    // Step 1: Create if not exists
    if (!(await store.exists(id))) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        console.error(`Invalid slice ID: "${id}".`);
        return 1;
      }
      const slice = store.create(id, title);
      await store.write(slice);
      await events.append(id, 'spec.drafted', 'cli', { sliceId: id, title });
      console.log(`  ✅ Slice "${id}" created`);
    } else {
      console.log(`  ℹ️  Slice "${id}" already exists`);
    }

    const slice = await store.read(id);

    // Step 2: Check state — running is an error
    if (slice.state === 'running') {
      console.error(`  ❌ Slice "${id}" is already running.`);
      return 1;
    }

    // Step 3: Check (gate①) — warn only, don't block
    const issues: string[] = [];
    if (slice.trace.requirements.length === 0) issues.push('No requirements traced');
    if (slice.trace.contracts.length === 0) issues.push('No contracts traced');
    if (slice.trace.tests.length === 0) issues.push('No tests traced');
    if (slice.drift.detected) issues.push(`Drift detected: ${slice.drift.reason}`);
    if (issues.length > 0) {
      console.log(`  ⚠️  Gate① issues: ${issues.join(', ')}`);
    } else {
      console.log(`  ✅ Gate① passed`);
    }

    // Step 4: Freeze if not frozen
    if (slice.state === 'draft' || slice.state === 'clarifying') {
      // Set frozen hash before transit (transit reads fresh from disk)
      const current = await store.read(id);
      const specHash = hashSpecFile(current.spec.path);
      current.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
      current.spec.frozenAt = new Date().toISOString();
      await store.write(current);
      await store.transit(id, 'FREEZE');
      await events.append(id, 'spec.frozen', 'zelto', {
        sliceId: id,
        frozenHash: current.spec.frozenHash,
        frozenAt: current.spec.frozenAt,
      });
      console.log(`  ✅ Slice frozen`);
    } else {
      console.log(`  ℹ️  Slice already ${slice.state}, skipping freeze`);
    }

    // Step 5: Run (admit + start)
    const policy = loadPolicyConfig();
    const scheduler = new Scheduler(store, events, policy);

    const admitResult = await scheduler.admit(id);
    if (admitResult.decision !== 'admitted') {
      console.error(`  ❌ Cannot run: ${admitResult.reason}`);
      if (admitResult.blockedBy.length > 0) {
        console.error(`     Blocked by: ${admitResult.blockedBy.join(', ')}`);
      }
      return 1;
    }

    await scheduler.startRun(id);
    console.log(`  ✅ Slice admitted and started execution`);

    // Re-read to get latest state
    const updatedSlice = await store.read(id);
    const bundle = scheduler.buildConstraints(updatedSlice);

    // Write constraint bundle
    const bundlePath = join(ZELTO_DIR, `${id}-bundle.json`);
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');

    // Determine agent command
    const cfg = loadConfig();
    const agentCmd = cfg.agent.command;
    const agentName = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : agentCmd;

    console.log(`  Agent:         ${agentName}`);
    console.log(`  Bundle:        ${bundlePath}`);
    console.log('');

    // Spawn agent via adapter
    const adapter = new ClaudeAgentAdapter({
      cwd: process.cwd(),
      agentCommand: agentName,
    });
    const { sessionId } = await adapter.start({
      sliceId: id,
      prompt: bundlePath,
    });

    await events.append(id, 'run.started', 'zelto', {
      sliceId: id,
      agent: agentName,
      bundlePath,
      writes: bundle.writes,
    });

    const exitCode = await adapter.waitForExit(sessionId);

    if (exitCode === 0) {
      await store.transit(id, 'RUN_FINISH');
      await events.append(id, 'run.finished', 'zelto', { sliceId: id, exitCode: 0 });
      console.log(`\nzelto start ${id} — ✅ Agent completed successfully (exit 0)`);
      console.log(`  Next: zelto gate ${id}`);
      return 0;
    } else {
      await events.append(id, 'run.aborted', 'zelto', { sliceId: id, exitCode });
      console.log(`\nzelto start ${id} — ❌ Agent exited with code ${exitCode}`);
      console.log(`  Slice remains in "running" state.`);
      return 1;
    }
  } catch (err) {
    console.error(`Error in start "${id}": ${err}`);
    return 1;
  }
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
    console.log(
      `  Traces:  ${slice.trace.requirements.length} reqs, ${slice.trace.contracts.length} contracts, ${slice.trace.tests.length} tests`,
    );

    // Gate① checks: verify trace completeness, spec existence, drift status
    const issues: string[] = [];
    if (slice.trace.requirements.length === 0) issues.push('No requirements traced');
    if (slice.trace.contracts.length === 0) issues.push('No contracts traced');
    if (slice.trace.tests.length === 0) issues.push('No tests traced');
    if (slice.drift.detected) issues.push(`Drift detected: ${slice.drift.reason}`);

    // Spec hash verification
    if (slice.spec.frozenHash) {
      const currentHash = hashSpecFile(slice.spec.path);
      if (currentHash && currentHash !== slice.spec.frozenHash) {
        issues.push('Spec file has changed since freeze (hash mismatch)');
        await events.append(id, 'slice.drift_detected', 'cli', {
          sliceId: id,
          expectedHash: slice.spec.frozenHash,
          actualHash: currentHash,
          reason: 'Spec file hash mismatch after freeze',
        });
      } else if (!currentHash) {
        issues.push('Spec file not found');
      } else {
        console.log(`  Spec hash: ✅ ${slice.spec.frozenHash.slice(0, 12)}...`);
      }
    }

    await events.append(id, 'spec.checked', 'cli', {
      sliceId: id,
      issues: issues.length,
      passed: issues.length === 0,
      details: issues,
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

    // Transition to clarifying if draft
    if (slice.state === 'draft') {
      if (!isDryRun) {
        await store.transit(id, 'CLARIFY_START');
        console.log(`zelto clarify ${id} — entering clarification...`);
      } else {
        console.log(`zelto clarify ${id} — dry-run (no changes made)...`);
      }
    } else {
      console.log(`zelto clarify ${id} — continuing clarification...`);
    }

    // Re-read to get fresh state
    const current = isDryRun ? slice : await store.read(id);
    const round = (current.runs?.length ?? 0) + 1;

    if (isAuto || isDryRun) {
      // Non-interactive mode
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

      // Auto-answer with defaults
      for (const q of result.questions) {
        const answer = { questionId: q.id, answer: q.default, answeredBy: 'zelto' };
        engine.applyAnswers(current, [answer]);
        await events.append(id, 'clarify.answer', 'zelto', {
          questionId: q.id, answer: q.default, selfAnswered: true,
        });
      }

      await store.write(current);
      console.log(`  ✅ All questions auto-answered.`);

      // Converge and freeze
      await store.transit(id, 'CLARIFY_CONVERGED');
      const afterConverge = await store.read(id);

      // Now freeze
      const specHash = hashSpecFile(afterConverge.spec.path);
      afterConverge.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
      afterConverge.spec.frozenAt = new Date().toISOString();
      await store.write(afterConverge);
      await store.transit(id, 'FREEZE');
      await events.append(id, 'spec.frozen', 'zelto', {
        sliceId: id,
        frozenHash: afterConverge.spec.frozenHash,
        frozenAt: afterConverge.spec.frozenAt,
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
        // Non-TTY fallback: use default
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

    // Apply answers
    engine.applyAnswers(current, answers);
    await store.write(current);

    // Log answer events
    for (const a of answers) {
      await events.append(id, 'clarify.answer', a.answeredBy, {
        questionId: a.questionId, answer: a.answer,
      });
    }

    console.log(`  ✅ All questions answered.`);

    // Converge and freeze
    await store.transit(id, 'CLARIFY_CONVERGED');
    const afterConverge = await store.read(id);

    const specHash = hashSpecFile(afterConverge.spec.path);
    afterConverge.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
    afterConverge.spec.frozenAt = new Date().toISOString();
    await store.write(afterConverge);
    await store.transit(id, 'FREEZE');
    await events.append(id, 'spec.frozen', 'human', {
      sliceId: id,
      frozenHash: afterConverge.spec.frozenHash,
      frozenAt: afterConverge.spec.frozenAt,
    });

    console.log(`  ✅ Slice frozen at ${afterConverge.spec.frozenAt}`);
    console.log(`  Next: zelto run ${id} --dry-run`);
    return 0;
  } catch (err) {
    console.error(`Error clarifying slice "${id}": ${err}`);
    return 1;
  }
});

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

    // Emit state change event
    await events.append(id, 'slice.state.changed', 'cli', {
      sliceId: id,
      from: prevState,
      to: 'abandoned',
      event: 'ABANDON',
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

    // Update frozen hash from spec file and save before transit
    const specHash = hashSpecFile(slice.spec.path);
    slice.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    // Transition state via store
    await store.transit(id, 'FREEZE');
    await events.append(id, 'spec.frozen', 'cli', {
      sliceId: id,
      frozenHash: slice.spec.frozenHash,
      frozenAt: slice.spec.frozenAt,
    });
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

    const bundle = scheduler.buildConstraints(slice);
    console.log(`zelto run ${id} — ✅ Admitted and starting execution...`);
    console.log(`  Write-set:     ${bundle.writes.join(', ') || '(none)'}`);
    console.log(`  Protected:     ${bundle.protectedPaths.join(', ')}`);
    console.log(`  Policy rules:  ${bundle.policyRules.length}`);

    // Write constraint bundle to temp file for the agent
    const bundlePath = join(ZELTO_DIR, `${id}-bundle.json`);
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');

    // Determine agent command
    const cfg = loadConfig();
    const agentCmd = cfg.agent.command;
    const agentName = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : agentCmd;

    console.log(`  Agent:         ${agentName}`);
    console.log(`  Bundle:        ${bundlePath}`);
    console.log('');

    // Spawn agent via adapter
    const adapter = new ClaudeAgentAdapter({
      cwd: process.cwd(),
      agentCommand: agentName,
    });
    const { sessionId } = await adapter.start({
      sliceId: id,
      prompt: bundlePath,
    });

    // Record run.started event
    await events.append(id, 'run.started', 'zelto', {
      sliceId: id,
      agent: agentName,
      bundlePath,
      writes: bundle.writes,
    });

    // Wait for agent to complete
    const exitCode = await adapter.waitForExit(sessionId);

    if (exitCode === 0) {
      await store.transit(id, 'RUN_FINISH');
      await events.append(id, 'run.finished', 'zelto', { sliceId: id, exitCode: 0 });
      console.log(`\n✅ Agent completed successfully (exit 0)`);
      console.log(`  Next: zelto gate ${id}`);
    } else {
      await events.append(id, 'run.aborted', 'zelto', { sliceId: id, exitCode });
      console.log(`\n❌ Agent exited with code ${exitCode}`);
      console.log(`  Slice remains in "running" state for investigation.`);
      console.log(`  To reset: manually update slice state or re-freeze.`);
    }
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
      console.log(
        `    ${icon} ${r.command} (${r.durationMs.toFixed(0)}ms, exit ${r.exitCode ?? 'signal'})`,
      );
    }

    if (report.retryCount > 0) {
      console.log(`  Retries:  ${report.retryCount}`);
    }

    if (report.passed) {
      console.log(`  Result:   ✅ Gate passed (${report.totalDurationMs.toFixed(0)}ms)`);
      // Transition to completed
      await store.transit(id, 'GATE_PASS');
      console.log(`  State:    ✅ Slice transitioned to "completed"`);
      // Auto-create sign request
      const signManager = new SignManager(ZELTO_DIR, events, store);
      const signReq = await signManager.request(id, 'zelto');
      console.log(`  Sign:     📋 Sign request created (${signReq.id})`);
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

register('inbox', async (args) => {
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const pending = await signManager.list('pending');

  // Non-interactive mode: --list flag or piped output
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

  // Interactive mode
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

register('sign', async (args) => {
  const [id, action] = args;
  if (!id || !action) {
    console.error('Usage: zelto sign <slice-id> [--approve|--reject] [--comment <text>]');
    return 1;
  }

  const signManager = new SignManager(ZELTO_DIR, events, store);
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
  const priority: Array<string> = [
    'draft',
    'clarifying',
    'frozen',
    'running',
    'completed',
    'abandoned',
  ];
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

register('init', async () => {
  const dirs = [join(ZELTO_DIR, 'slices'), join(ZELTO_DIR, 'events'), join(ZELTO_DIR, 'locks')];

  const configPath = join(ZELTO_DIR, 'config.yaml');
  const defaultConfig = `# zelto project configuration
# Created by \`zelto init\`

gate:
  commands:
    - name: test
      run: pnpm test
    - name: lint
      run: pnpm lint
  timeoutSec: 120
  retry:
    max: 2
`;

  if (existsSync(ZELTO_DIR)) {
    console.log(`zelto init — ⚠️  .zelto/ already exists, skipping.`);
    console.log(`  Use --force to reinitialize (will overwrite config.yaml).`);
    return 0;
  }

  // Create directories
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Write default config
  if (!existsSync(configPath)) {
    writeFileSync(configPath, defaultConfig, 'utf-8');
  }

  console.log(`zelto init — ✅ .zelto/ initialized`);
  console.log(`  Created:`);
  for (const dir of dirs) {
    console.log(`    ${dir}/`);
  }
  console.log(`    ${configPath}`);
  return 0;
});

register('summary', async () => {
  // ── Project meta ──
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
  } catch {
    /* ignore */
  }

  const name = (pkg.name as string) ?? 'zelto';
  const version = (pkg.version as string) ?? '?';

  // ── Build status ──
  const distOk = existsSync('dist/cli/index.js');
  const distTestOk = existsSync('dist-test/tests');

  // ── Git status ──
  let gitBranch = '?';
  let gitCommit = '?';
  let gitDirty = false;
  try {
    gitBranch = readFileSync('.git/HEAD', 'utf-8').trim().replace('ref: refs/heads/', '');
    gitCommit = readFileSync(`.git/refs/heads/${gitBranch}`, 'utf-8').trim().slice(0, 7);
    // Check dirty — quick heuristic: diff-index
    const { execSync } = await import('node:child_process');
    const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 3000 });
    gitDirty = status.trim().length > 0;
  } catch {
    /* ignore */
  }

  // ── Module detection ──
  const coreModules: string[] = [];
  if (existsSync('src/core')) {
    for (const entry of readdirSync('src/core', { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(`src/core/${entry.name}/index.ts`)) {
        coreModules.push(entry.name);
      }
    }
  }

  // ── Empty placeholder dirs ──
  const placeholderDirs: string[] = [];
  const checkPlaceholder = (dir: string) => {
    if (existsSync(dir)) {
      const items = readdirSync(dir);
      if (items.length === 0 || (items.length === 1 && items[0] === '.gitkeep')) {
        placeholderDirs.push(dir);
      }
    }
  };
  checkPlaceholder('src/adapters');
  checkPlaceholder('src/llm');
  checkPlaceholder('src/mcp');
  checkPlaceholder('src/ui');
  checkPlaceholder('tests/acceptance');

  // ── CLI commands ──
  const cmdCount = Object.keys(commands).length;

  // ── Hook ──
  const hookExists = existsSync('src/hook/index.ts');
  let hookLines = 0;
  if (hookExists) {
    try {
      hookLines = readFileSync('src/hook/index.ts', 'utf-8').split('\n').length;
    } catch {
      /* ignore */
    }
  }

  // ── Runtime dir ──
  const zeltoExists = existsSync('.zelto');
  let sliceCount = 0;
  if (zeltoExists && existsSync('.zelto/slices')) {
    try {
      sliceCount = readdirSync('.zelto/slices').filter((f) => f.endsWith('.json')).length;
    } catch {
      /* ignore */
    }
  }

  // ── Output ──
  console.log(`
Project: ${name} v${version}
Build:   ${distOk ? '✅ dist/' : '❌ dist/'} ${distTestOk ? '✅ dist-test/' : '❌ dist-test/'}
Git:     ${gitBranch} @ ${gitCommit}${gitDirty ? ' (dirty)' : ' (clean)'}
Modules: ${coreModules.length} core/ — ${coreModules.join(', ')}
CLI:     ${cmdCount} commands
Hook:    ${hookLines > 0 ? `✅ ${hookLines} lines` : '❌ missing'}
Runtime: ${zeltoExists ? '✅ .zelto/' : '❌ .zelto/ (not initialized)'}
Slices:  ${sliceCount} created
Empty:   ${placeholderDirs.join(', ') || '(none)'}
`);
  return 0;
});

register('help', async () => {
  console.log(`
zelto — AI Programming Cockpit

Commands:
  summary                   Show project summary
  init                      Initialize .zelto/ runtime directory
  slices                    List all slices
  create <id>               Create a new slice
  start <id>                One-click: create→check→freeze→run
  check <id>                Run gate① (deterministic checks)
  freeze <id>               Freeze slice baseline
  run <id> [--agent <n>]    Execute slice (with parallel admission check)
  run <id> --dry-run        Check admission without executing
  gate <id>                 Run gate② (acceptance tests)
  inbox                     Interactive sign queue (--list for non-interactive)
  sign <id> --approve       Approve slice
  sign <id> --reject        Reject slice
  hook --install            Install git hooks (pre-commit, pre-push)
  hook --uninstall          Remove zelto git hooks
  hook --status             Show git hook installation status
  help                      Show this help
`);
  return 0;
});

register('hook', async (args) => {
  const action = args[0];
  const GIT_HOOKS_DIR = join(process.cwd(), '.git', 'hooks');
  const HOOK_MARKER = '# zelto-hook — DO NOT EDIT';

  function hookScript(name: string, condition: string): string {
    return `#!/bin/sh
${HOOK_MARKER}
# Auto-installed by \`zelto hook --install\`
# Runs zelto-hook policy check on ${name}

${condition}
if [ \$? -ne 0 ]; then
  # Collect changed files and check each one
  FILES="${name === 'pre-commit' ? '$(git diff --cached --name-only --diff-filter=ACMR)' : '$(git diff --name-only @{push}.. 2>/dev/null || git diff --name-only HEAD~1..)'}"
  if [ -z "$FILES" ]; then
    exit 0
  fi

  HAS_DENY=0
  echo "$FILES" | while IFS= read -r file; do
    if [ -n "$file" ]; then
      RESULT=$(echo "{\\"path\\":\\"$file\\",\\"operation\\":\\"write\\",\\"harness\\":\\"git\\"}" | node "$(git rev-parse --show-toplevel)/dist/hook/index.js" 2>/dev/null)
      DECISION=$(echo "$RESULT" | grep -o '"decision":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [ "$DECISION" = "deny" ]; then
        echo "❌ zelto-hook: DENIED write to $file"
        BASIS=$(echo "$RESULT" | grep -o '"basis":"[^"]*"' | head -1 | cut -d'"' -f4)
        echo "   Basis: $BASIS"
        HAS_DENY=1
      fi
    fi
  done

  if [ "$HAS_DENY" = "1" ]; then
    echo ""
    echo "zelto-hook: Policy check failed. Commit blocked."
    exit 1
  fi
fi
`;
  }

  async function installHook(name: string, condition: string): Promise<boolean> {
    const hookPath = join(GIT_HOOKS_DIR, name);
    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, 'utf-8');
      if (!existing.includes(HOOK_MARKER) && !existing.includes('# zelto-hook')) {
        console.error(`  ⚠️  ${name} already exists (not a zelto hook). Skipping.`);
        console.error(`     Merge manually: ${hookPath}`);
        return false;
      }
    }
    writeFileSync(hookPath, hookScript(name, condition), 'utf-8');
    // Make executable (chmod +x)
    try {
      const { chmodSync } = await import('node:fs');
      chmodSync(hookPath, 0o755);
    } catch {
      // Windows: chmod may fail, but .git/hooks on Windows doesn't need +x
    }
    console.log(`  ✅ ${name} installed`);
    return true;
  }

  async function uninstallHook(name: string): Promise<boolean> {
    const hookPath = join(GIT_HOOKS_DIR, name);
    if (!existsSync(hookPath)) return false;
    const existing = readFileSync(hookPath, 'utf-8');
    if (!existing.includes(HOOK_MARKER)) {
      console.error(`  ⚠️  ${name} is not a zelto hook. Skipping.`);
      return false;
    }
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(hookPath);
    } catch {
      // Fallback: overwrite with empty
      writeFileSync(hookPath, '', 'utf-8');
    }
    console.log(`  ✅ ${name} uninstalled`);
    return true;
  }

  async function statusHook(name: string): Promise<string> {
    const hookPath = join(GIT_HOOKS_DIR, name);
    if (!existsSync(hookPath)) return 'not installed';
    const existing = readFileSync(hookPath, 'utf-8');
    if (existing.includes(HOOK_MARKER)) return '✅ installed (zelto)';
    return '⚠️  exists (not zelto)';
  }

  if (!action || action === '--help') {
    console.log('Usage: zelto hook --install | --uninstall | --status');
    return 0;
  }

  // Ensure .git/hooks exists
  if (!existsSync(GIT_HOOKS_DIR)) {
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(GIT_HOOKS_DIR, { recursive: true });
    } catch {
      console.error('Error: .git/hooks/ directory not found and could not be created.');
      console.error('Are you in a git repository?');
      return 1;
    }
  }

  switch (action) {
    case '--install': {
      console.log('Installing zelto git hooks...');
      const preCommitOk = await installHook('pre-commit', '# Check all staged files');
      const prePushOk = await installHook('pre-push', '# Check all pushed files');
      if (preCommitOk || prePushOk) {
        console.log('Done.');
        return 0;
      }
      console.error('No hooks were installed. Check warnings above.');
      return 1;
    }
    case '--uninstall': {
      console.log('Uninstalling zelto git hooks...');
      await uninstallHook('pre-commit');
      await uninstallHook('pre-push');
      console.log('Done.');
      return 0;
    }
    case '--status': {
      console.log('Git hook status:');
      console.log(`  pre-commit: ${await statusHook('pre-commit')}`);
      console.log(`  pre-push:   ${await statusHook('pre-push')}`);
      return 0;
    }
    default: {
      console.error(`Unknown action: ${action}`);
      console.error('Usage: zelto hook --install | --uninstall | --status');
      return 1;
    }
  }
});

export async function runCLI(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === 'help' || cmd === '--help') {
    return commands.help?.([]);
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}`);
    console.error('Run "zelto help" for usage.');
    return 1;
  }

  return handler(rest);
}
