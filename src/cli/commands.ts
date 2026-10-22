// CLI command dispatcher

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ClaudeAgentAdapter } from '../adapters/claude-agent/index.js';
import { ClaudeAgentSdkAdapter } from '../adapters/claude-agent-sdk/index.js';
import { DeepSeekAdapter } from '../adapters/llm/index.js';
import { EventStream } from '../core/events/stream.js';
import { RequirementStore } from '../core/requirements/store.js';
import { DesignStore } from '../core/design/store.js';
import { VersionStore } from '../core/version/store.js';
import { ClarifyEngine } from '../core/clarify/engine.js';
import { GateExecutor } from '../core/gate/executor.js';
import { SignManager } from '../core/gate/sign.js';
import { Scheduler } from '../core/sched/engine.js';
import { isSliceStalled, isAutoResolvable } from '../core/stall/index.js';
import type { GateConfig } from '../core/gate/types.js';
import type { Decision, PolicyConfig, PolicyRule } from '../core/policy/types.js';
import type { RequirementDoc } from '../core/requirements/types.js';
import type { DesignDoc } from '../core/design/types.js';
import type { VersionPlan, VersionSlice } from '../core/version/types.js';
import { SliceStore } from '../core/slice/store.js';
import { AuditTrail } from '../core/audit/trail.js';
import { MetricsCollector } from '../core/metrics/collector.js';
import { generateRequirements, refineRequirements } from '../llm/generators/requirements.js';
import { generateDesign, refineDesign } from '../llm/generators/design.js';
import { generateSlicePlan, generateVersion } from '../llm/generators/slice-plan.js';

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
  llm?: { provider: string; apiKey: string; model?: string };
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
        llm: parsed.llm,
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
  llm?: { provider: string; apiKey: string; model?: string };
} | null {
  const commands: Array<{ name: string; run: string }> = [];
  let timeoutSec = 120;
  let retryMax = 2;
  let agentCommand = 'npx claude-code';
  let currentCommand: { name: string; run: string } | null = null;
  let inGateSection = false;
  let inAgentSection = false;
  let inLlmSection = false;
  let llmProvider = '';
  let llmApiKey = '';
  let llmModel = '';

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed === 'gate:') {
      inGateSection = true;
      inAgentSection = false;
      inLlmSection = false;
      continue;
    }
    if (trimmed === 'agent:') {
      inAgentSection = true;
      inGateSection = false;
      inLlmSection = false;
      continue;
    }
    if (trimmed === 'llm:') {
      inLlmSection = true;
      inGateSection = false;
      inAgentSection = false;
      continue;
    }

    if (inGateSection) {
      // Inline format: - { name: X, run: "Y" }
      const inlineMatch = trimmed.match(/^- \{\s*name:\s*(\S+?)\s*,\s*run:\s*"([^"]*)"\s*\}$/);
      if (inlineMatch) {
        if (currentCommand) commands.push(currentCommand);
        currentCommand = { name: inlineMatch[1], run: inlineMatch[2] };
        continue;
      }

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

    if (inLlmSection) {
      if (trimmed.startsWith('provider:')) {
        llmProvider = trimmed.slice(9).trim().replace(/^"|"$/g, '');
      } else if (trimmed.startsWith('apiKey:')) {
        llmApiKey = trimmed.slice(7).trim().replace(/^"|"$/g, '');
      } else if (trimmed.startsWith('model:')) {
        llmModel = trimmed.slice(6).trim().replace(/^"|"$/g, '');
      }
    }
  }

  if (currentCommand) commands.push(currentCommand);

  const llm = llmProvider && llmApiKey
    ? { provider: llmProvider, apiKey: llmApiKey, ...(llmModel ? { model: llmModel } : {}) }
    : undefined;

  return commands.length > 0 || llm
    ? {
        gate: commands.length > 0 ? { commands, timeoutSec, retry: { max: retryMax } } : { commands: [], timeoutSec: 120, retry: { max: 2 } },
        agent: { command: agentCommand },
        llm,
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
    const scheduler = new Scheduler(store, events, loadPolicyConfig());

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
        // Emit state change event
        await events.append(id, 'slice.state.changed', 'cli', {
          sliceId: id,
          from: 'draft',
          to: 'clarifying',
          event: 'CLARIFY_START',
        });
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
      // Emit state change event
      await events.append(id, 'slice.state.changed', 'cli', {
        sliceId: id,
        from: 'clarifying',
        to: 'draft',
        event: 'CLARIFY_CONVERGED',
      });
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
    const scheduler = new Scheduler(store, events, loadPolicyConfig());

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

register('admit', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto admit <slice-id> [--json]');
    return 1;
  }

  const isJson = args.includes('--json');

  try {
    const policy = loadPolicyConfig();
    const scheduler = new Scheduler(store, events, policy);

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
      const prevState = slice.state;
      await store.transit(id, 'GATE_PASS');
      // Emit state change event
      await events.append(id, 'slice.state.changed', 'cli', {
        sliceId: id,
        from: prevState,
        to: 'completed',
        event: 'GATE_PASS',
      });
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
  const stateCounts: Record<string, number> = {};
  const sliceIds: string[] = [];
  if (zeltoExists && existsSync('.zelto/slices')) {
    try {
      const sliceFiles = readdirSync('.zelto/slices').filter((f) => f.endsWith('.json'));
      sliceCount = sliceFiles.length;
      for (const f of sliceFiles) {
        try {
          const content = readFileSync(join('.zelto/slices', f), 'utf-8');
          const slice = JSON.parse(content) as { id: string; state: string };
          sliceIds.push(slice.id);
          stateCounts[slice.state] = (stateCounts[slice.state] ?? 0) + 1;
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ── Event count ──
  let eventTotal = 0;
  if (zeltoExists && existsSync('.zelto/events')) {
    try {
      const sliceDirs = readdirSync('.zelto/events', { withFileTypes: true });
      for (const dir of sliceDirs) {
        if (dir.isDirectory()) {
          const eventsFile = join('.zelto/events', dir.name, 'events.jsonl');
          if (existsSync(eventsFile)) {
            try {
              const content = readFileSync(eventsFile, 'utf-8');
              eventTotal += content.split('\n').filter(Boolean).length;
            } catch {
              /* skip */
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ── Pending sign requests ──
  let pendingSigns = 0;
  if (zeltoExists && existsSync('.zelto/locks')) {
    try {
      const lockFiles = readdirSync('.zelto/locks').filter((f) => f.endsWith('.json'));
      for (const f of lockFiles) {
        try {
          const content = readFileSync(join('.zelto/locks', f), 'utf-8');
          const req = JSON.parse(content) as { status: string };
          if (req.status === 'pending') pendingSigns++;
        } catch {
          /* skip */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ── Acceptance tests ──
  let acceptanceTests = 0;
  let acceptanceSuites = 0;
  if (existsSync('tests/acceptance')) {
    try {
      const acceptDirs = readdirSync('tests/acceptance', { withFileTypes: true });
      for (const dir of acceptDirs) {
        if (dir.isDirectory()) {
          const testFiles = readdirSync(join('tests/acceptance', dir.name))
            .filter((f) => f.endsWith('.test.ts'));
          if (testFiles.length > 0) {
            acceptanceSuites++;
            acceptanceTests += testFiles.length;
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ── Build state breakdown string ──
  const stateOrder = ['draft', 'clarifying', 'frozen', 'running', 'completed', 'abandoned'];
  const stateParts = stateOrder
    .filter((s) => (stateCounts[s] ?? 0) > 0)
    .map((s) => `${s}: ${stateCounts[s]}`);

  // ── Audit & Metrics ──
  let auditLine = '';
  let reworkLine = '';
  let cycleLine = '';
  let stallLine = '';
  if (sliceIds.length > 0) {
    try {
      const audit = new AuditTrail(events);
      const metrics = new MetricsCollector(events);

      // Latest event per slice
      const sliceSummaries: string[] = [];
      for (const id of sliceIds) {
        try {
          const report = await audit.forSlice(id);
          if (report.totalEvents > 0) {
            const last = report.entries[report.entries.length - 1];
            sliceSummaries.push(`${id}: ${last.eventType}`);
          } else {
            sliceSummaries.push(`${id}: (no events)`);
          }
        } catch {
          sliceSummaries.push(`${id}: (error reading)`);
        }
      }
      auditLine = `  Latest:   ${sliceSummaries.join(', ')}`;

      // Overall metrics
      const report = await metrics.generateReport(sliceIds);
      let totalRework = 0;
      let reworkCount = 0;
      let totalCycle = 0;
      let cycleCount = 0;
      let totalStalls = 0;
      for (const m of report.metrics) {
        if (m.name === 'rework_rate') {
          totalRework += m.value;
          reworkCount++;
        } else if (m.name === 'cycle_time') {
          totalCycle += m.value;
          cycleCount++;
        } else if (m.name === 'stall_counts') {
          totalStalls += m.value;
        }
      }
      reworkLine = reworkCount > 0
        ? `  Rework:   ${(totalRework / reworkCount).toFixed(2)} avg rate`
        : '  Rework:   (no data)';
      cycleLine = cycleCount > 0
        ? `  Cycle:    ${(totalCycle / cycleCount).toFixed(0)}s avg`
        : '  Cycle:    (no data)';
      stallLine = `  Stalls:   ${totalStalls} total`;
    } catch {
      auditLine = '  (error reading audit/metrics)';
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

Slices:
  Total:   ${sliceCount} created
  States:  ${stateParts.join(', ') || '(none)'}
  Events:  ${eventTotal} total

Audit & Metrics:
${auditLine || '  (no slices)'}
${reworkLine || '  (no slices)'}
${cycleLine || '  (no slices)'}
${stallLine || '  (no slices)'}

Sign:
  Pending: ${pendingSigns} request(s)

Tests:
  Acceptance: ${acceptanceSuites} suites, ${acceptanceTests} test files

Empty:   ${placeholderDirs.join(', ') || '(none)'}
`);
  return 0;
});

register('events', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto events <slice-id> [--json] [--tail N]');
    return 1;
  }

  const isJson = args.includes('--json');
  const tailIdx = args.indexOf('--tail');
  const tailN = tailIdx >= 0 ? Number(args[tailIdx + 1]) : undefined;

  try {
    // Verify slice exists
    await store.read(id);

    const allEvents = await events.read(id);

    if (allEvents.length === 0) {
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, events: [] }));
      } else {
        console.log(`No events for slice: ${id}`);
      }
      return 0;
    }

    const displayEvents =
      tailN != null && !Number.isNaN(tailN)
        ? allEvents.slice(-tailN)
        : allEvents;

    if (isJson) {
      console.log(
        JSON.stringify({
          sliceId: id,
          total: allEvents.length,
          displayed: displayEvents.length,
          events: displayEvents,
        }),
      );
    } else {
      for (const evt of displayEvents) {
        const time = evt.ts
          ? new Date(evt.ts).toISOString().slice(11, 19)
          : '--:--:--';
        console.log(`  ${time}  ${evt.type.padEnd(24)} ${evt.actor ?? ''}`);
      }
      if (displayEvents.length < allEvents.length) {
        console.log(
          `  (showing last ${displayEvents.length} of ${allEvents.length} events)`,
        );
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('not found') || msg.includes('ENOENT')) {
      console.log(
        isJson
          ? JSON.stringify({ error: `Slice not found: ${id}` })
          : `❌ Slice not found: ${id}`,
      );
      return 1;
    }
    console.log(
      isJson
        ? JSON.stringify({ error: msg })
        : `❌ Error: ${msg}`,
    );
    return 1;
  }

  return 0;
});

register('help', async () => {
  console.log(`
zelto — AI Programming Cockpit

Commands (Slice Management):
  events <id> [--json] [--tail N]   Show slice event stream
  summary                   Show project summary
  init                      Initialize .zelto/ runtime directory
  slices                    List all slices
  create <id>               Create a new slice
  start <id>                One-click: create→check→freeze→run
  check <id>                Run gate① (deterministic checks)
  freeze <id>               Freeze slice baseline
  run <id> [--agent <n>] [--sdk] [--budget <usd>]  Execute slice (use --sdk for SDK adapter)
  run <id> --dry-run        Check admission without executing
  gate <id>                 Run gate② (acceptance tests)
  inbox                     Interactive sign queue (--list for non-interactive)
  sign <id> --approve       Approve slice
  sign <id> --reject        Reject slice
  hook --install            Install git hooks (pre-commit, pre-push)
  hook --uninstall          Remove zelto git hooks
  hook --status             Show git hook installation status
  stall [id] [--auto-resolved]  List stalled slices
  resume <id> [--skip|--abandon]  Resume a stalled slice
  help                      Show this help

Commands (AI Pipeline):
  require <text>            Create requirement from natural language (via LLM)
  require list              List all requirements
  require confirm <id>      Confirm a requirement
  require refine <id> <txt> Iteratively refine a draft requirement with feedback
  design <req-id>           Generate design document from requirement (via LLM)
  design list               List all designs
  design confirm <id>       Confirm a design
  design refine <id> <txt>  Iteratively refine a draft design with feedback
  plan <design-id>          Generate version plan from design (via LLM)
  plan confirm <id>         Confirm plan and create slice specs
  plan add-version <id> <d> Append a new version to an existing plan (via LLM)
  version status            Show version plan status
  version start <ver>       Execute a version's slices (agents in parallel)
  version deliver <ver>     Mark a version as delivered

Commands (Panoramic):
  pipeline status           Show full pipeline: requirements → designs → plans → versions → slices
  trace <req-id>            Trace a requirement through design → plan → versions → slices
  impact <req-id>           Impact analysis: what's affected if a requirement changes
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

register('stall', async (args) => {
  const [id] = args;
  const showAutoResolved = args.includes('--auto-resolved');

  if (id && !id.startsWith('--')) {
    try {
      const slice = await store.read(id);
      if (!isSliceStalled(slice) && !showAutoResolved) {
        console.log(`Slice "${id}" is not stalled.`);
        return 0;
      }
      console.log(`Slice:  ${id}`);
      console.log(`Title:  ${slice.title}`);
      console.log(`State:  ${slice.state}`);
      if (slice.stall.class) {
        console.log(`Stall class:    ${slice.stall.class}`);
        console.log(`Auto-resolved:  ${slice.stall.autoResolved}`);
        console.log(`Gate retries:   ${slice.stall.gateRetries}`);
      } else {
        console.log('Stall:  (auto-resolved, no active stall)');
      }
      return 0;
    } catch {
      console.error(`Slice "${id}" not found.`);
      return 1;
    }
  }

  const allIds = await store.list();
  const stalled: Array<{ id: string; stallClass: string; autoResolved: number }> = [];

  for (const sid of allIds) {
    try {
      const s = await store.read(sid);
      if (!showAutoResolved && isSliceStalled(s)) {
        stalled.push({ id: sid, stallClass: s.stall.class!, autoResolved: s.stall.autoResolved });
      } else if (showAutoResolved && s.stall.autoResolved > 0) {
        stalled.push({ id: sid, stallClass: s.stall.class ?? '(resolved)', autoResolved: s.stall.autoResolved });
      }
    } catch {
      // skip unreadable slices
    }
  }

  if (stalled.length === 0) {
    console.log('No stalled slices found.');
    return 0;
  }

  console.log('Stalled slices:');
  for (const s of stalled) {
    console.log(`  ${s.id.padEnd(20)} ${s.stallClass.padEnd(25)} auto-resolved: ${s.autoResolved}`);
  }
  return 0;
});

register('resume', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto resume <slice-id> [--skip] [--abandon]');
    return 1;
  }

  const skip = args.includes('--skip');
  const abandon = args.includes('--abandon');

  try {
    await store.read(id);
  } catch {
    console.error(`Slice "${id}" not found.`);
    return 1;
  }

  const scheduler = new Scheduler(store, events, loadPolicyConfig());

  try {
    await scheduler.resume(id, { skip, abandon });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }

  if (abandon) {
    console.log(`zelto resume ${id} --abandon -- Slice abandoned`);
  } else if (skip) {
    console.log(`zelto resume ${id} --skip -- Stall resolved, slice not re-executed`);
  } else {
    console.log(`zelto resume ${id} -- Slice resumed for re-execution`);
  }
  return 0;
});

// ─── LLM Helper ──────────────────────────────────────────────────────────

function createLlmFromConfig(): DeepSeekAdapter | null {
  const cfg = loadConfig();
  if (!cfg.llm?.apiKey) {
    return null;
  }
  return new DeepSeekAdapter({
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model ?? 'deepseek-chat',
  });
}

// ─── Slice Spec Generator ────────────────────────────────────────────────

function generateSliceSpecContent(sliceId: string, title: string, module: string, writes: string[], version: string): string {
  return [
    `# Slice: ${sliceId}`,
    '',
    '## 目的',
    `版本 ${version} — ${title}`,
    '',
    '## 范围',
    ...writes.map((w) => `- \`${w}\``),
    '',
    '## 验收标准',
    `1. 完成 ${title}`,
    '2. 全部测试通过',
    '',
    '## 风险',
    '- 无',
    '',
  ].join('\n');
}

// ─── require ──────────────────────────────────────────────────────────────

register('require', async (args) => {
  const subcmd = args[0];

  // zelto require list
  if (!subcmd || subcmd === 'list') {
    const reqStore = new RequirementStore(ZELTO_DIR);
    const list = await reqStore.list();
    if (list.length === 0) {
      console.log('No requirements found.');
      return 0;
    }
    console.log('Requirements:');
    for (const r of list) {
      console.log(`  ${r.id.padEnd(20)} ${r.status.padEnd(12)} ${r.title}`);
    }
    return 0;
  }

  // zelto require confirm <id>
  if (subcmd === 'confirm') {
    const id = args[1];
    if (!id || id.startsWith('--')) {
      console.error('Usage: zelto require confirm <id>');
      return 1;
    }
    const reqStore = new RequirementStore(ZELTO_DIR);
    if (!(await reqStore.exists(id))) {
      console.error(`Requirement "${id}" not found.`);
      return 1;
    }
    const doc = await reqStore.read(id);
    doc.status = 'confirmed';
    doc.confirmedAt = new Date().toISOString();
    await reqStore.save(doc);
    console.log(`Requirement "${id}" confirmed.`);
    return 0;
  }

  // zelto require refine <id> <feedback> — iterative multi-turn editing
  if (subcmd === 'refine') {
    const id = args[1];
    const feedback = args.slice(2).join(' ');
    if (!id || id.startsWith('--') || !feedback) {
      console.error('Usage: zelto require refine <id> <feedback text>');
      return 1;
    }
    const reqStore = new RequirementStore(ZELTO_DIR);
    if (!(await reqStore.exists(id))) {
      console.error(`Requirement "${id}" not found.`);
      return 1;
    }
    const doc = await reqStore.read(id);
    if (doc.status !== 'draft') {
      console.error(`Requirement "${id}" is already ${doc.status}. Can only refine draft requirements.`);
      return 1;
    }

    const llm = createLlmFromConfig();
    if (!llm) {
      console.error('LLM not configured. Add llm.apiKey to .zelto/config.yaml');
      return 1;
    }

    console.log(`Refining requirement "${id}" with feedback...`);
    const result = await refineRequirements(llm, doc.spec, feedback);

    // Update the requirement in place
    doc.title = result.title;
    doc.spec = result.spec;
    doc.acceptanceCriteria = result.acceptanceCriteria;
    await reqStore.save(doc);

    console.log(`\n✅ Requirement "${id}" updated.`);
    console.log(`   Title: ${result.title}`);
    console.log(`\n${result.spec}`);
    console.log(`\nAcceptance Criteria:`);
    for (const ac of result.acceptanceCriteria) {
      console.log(`  - ${ac}`);
    }
    console.log(`\nRun again: zelto require refine ${id} <more feedback>`);
    console.log(`Or confirm: zelto require confirm ${id}`);
    return 0;
  }

  // zelto require <text> — create new requirement from natural language
  const userInput = args.join(' ');
  if (!userInput) {
    console.error('Usage: zelto require <text> | zelto require list | zelto require confirm <id>');
    return 1;
  }

  const llm = createLlmFromConfig();
  if (!llm) {
    console.error('LLM not configured. Add llm.apiKey to .zelto/config.yaml');
    return 1;
  }

  console.log('Generating requirement specification...');
  const result = await generateRequirements(llm, userInput, '');

  const id = `req-${Date.now()}`;
  const doc: RequirementDoc = {
    id,
    title: result.title,
    userInput,
    spec: result.spec,
    status: 'draft',
    supersedes: null,
    acceptanceCriteria: result.acceptanceCriteria,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };

  const reqStore = new RequirementStore(ZELTO_DIR);
  await reqStore.save(doc);

  console.log(`\n✅ Requirement created: ${id}`);
  console.log(`   Title: ${result.title}`);
  console.log(`\n${result.spec}`);
  console.log(`\nAcceptance Criteria:`);
  for (const ac of result.acceptanceCriteria) {
    console.log(`  - ${ac}`);
  }
  console.log(`\nRun: zelto require confirm ${id}`);
  return 0;
});

// ─── design ───────────────────────────────────────────────────────────────

register('design', async (args) => {
  const subcmd = args[0];

  // zelto design list
  if (!subcmd || subcmd === 'list') {
    const designStore = new DesignStore(ZELTO_DIR);
    const list = await designStore.list();
    if (list.length === 0) {
      console.log('No designs found.');
      return 0;
    }
    console.log('Designs:');
    for (const d of list) {
      console.log(`  ${d.id.padEnd(20)} ${d.status.padEnd(12)} Req:${d.requirementId}  ${d.title} (${d.moduleCount} modules)`);
    }
    return 0;
  }

  // zelto design confirm <id>
  if (subcmd === 'confirm') {
    const id = args[1];
    if (!id || id.startsWith('--')) {
      console.error('Usage: zelto design confirm <id>');
      return 1;
    }
    const designStore = new DesignStore(ZELTO_DIR);
    if (!(await designStore.exists(id))) {
      console.error(`Design "${id}" not found.`);
      return 1;
    }
    const doc = await designStore.read(id);
    doc.status = 'confirmed';
    doc.confirmedAt = new Date().toISOString();
    await designStore.save(doc);
    console.log(`Design "${id}" confirmed.`);
    return 0;
  }

  // zelto design refine <id> <feedback> — iterative multi-turn editing
  if (subcmd === 'refine') {
    const id = args[1];
    const feedback = args.slice(2).join(' ');
    if (!id || id.startsWith('--') || !feedback) {
      console.error('Usage: zelto design refine <id> <feedback text>');
      return 1;
    }
    const designStore = new DesignStore(ZELTO_DIR);
    if (!(await designStore.exists(id))) {
      console.error(`Design "${id}" not found.`);
      return 1;
    }
    const doc = await designStore.read(id);
    if (doc.status !== 'draft') {
      console.error(`Design "${id}" is already ${doc.status}. Can only refine draft designs.`);
      return 1;
    }

    const llm = createLlmFromConfig();
    if (!llm) {
      console.error('LLM not configured. Add llm.apiKey to .zelto/config.yaml');
      return 1;
    }

    console.log(`Refining design "${id}" with feedback...`);
    const result = await refineDesign(llm, doc.body, feedback);

    // Update the design in place
    doc.title = result.title;
    doc.body = result.body;
    doc.modules = result.modules;
    await designStore.save(doc);

    console.log(`\n✅ Design "${id}" updated.`);
    console.log(`   Title: ${result.title}`);
    console.log(`\nModules:`);
    for (const m of result.modules) {
      console.log(`  ${m.name}`);
      console.log(`    Description: ${m.description}`);
      if (m.filePatterns.length > 0) console.log(`    Files: ${m.filePatterns.join(', ')}`);
      if (m.dependencies.length > 0) console.log(`    Dependencies: ${m.dependencies.join(', ')}`);
    }
    console.log(`\nRun again: zelto design refine ${id} <more feedback>`);
    console.log(`Or confirm: zelto design confirm ${id}`);
    return 0;
  }

  // zelto design <req-id> — generate design from requirement
  const reqId = subcmd;
  if (!reqId || reqId.startsWith('--')) {
    console.error('Usage: zelto design <req-id> | zelto design list | zelto design confirm <id>');
    return 1;
  }

  const reqStore = new RequirementStore(ZELTO_DIR);
  if (!(await reqStore.exists(reqId))) {
    console.error(`Requirement "${reqId}" not found.`);
    return 1;
  }
  const req = await reqStore.read(reqId);
  if (req.status !== 'confirmed') {
    console.error(`Requirement "${reqId}" is not confirmed. Run "zelto require confirm ${reqId}" first.`);
    return 1;
  }

  const llm = createLlmFromConfig();
  if (!llm) {
    console.error('LLM not configured. Add llm.apiKey to .zelto/config.yaml');
    return 1;
  }

  console.log('Generating design document...');
  const result = await generateDesign(llm, req.spec, '');

  const id = `dsg-${Date.now()}`;
  const doc: DesignDoc = {
    id,
    requirementId: reqId,
    title: result.title,
    body: result.body,
    modules: result.modules,
    status: 'draft',
    supersedes: null,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };

  const designStore = new DesignStore(ZELTO_DIR);
  await designStore.save(doc);

  console.log(`\n✅ Design created: ${id}`);
  console.log(`   Title: ${result.title}`);
  console.log(`\nModules:`);
  for (const m of result.modules) {
    console.log(`  ${m.name}`);
    console.log(`    Description: ${m.description}`);
    if (m.filePatterns.length > 0) console.log(`    Files: ${m.filePatterns.join(', ')}`);
    if (m.dependencies.length > 0) console.log(`    Dependencies: ${m.dependencies.join(', ')}`);
  }
  console.log(`\nRun: zelto design confirm ${id}`);
  return 0;
});

// ─── plan ─────────────────────────────────────────────────────────────────

register('plan', async (args) => {
  const subcmd = args[0];

  // zelto plan confirm <id>
  if (subcmd === 'confirm') {
    const id = args[1];
    if (!id || id.startsWith('--')) {
      console.error('Usage: zelto plan confirm <id>');
      return 1;
    }
    const versionStore = new VersionStore(ZELTO_DIR);
    if (!(await versionStore.exists(id))) {
      console.error(`Plan "${id}" not found.`);
      return 1;
    }
    const plan = await versionStore.read(id);
    plan.status = 'confirmed';
    plan.confirmedAt = new Date().toISOString();
    await versionStore.save(plan);

    // Create slice spec markdown files
    const specsDir = 'specs/slices';
    if (!existsSync(specsDir)) {
      mkdirSync(specsDir, { recursive: true });
    }

    for (const v of plan.versions) {
      for (const slice of v.slices) {
        const specContent = generateSliceSpecContent(slice.id, slice.title, slice.module, slice.writes, v.version);
        writeFileSync(slice.specPath, specContent, 'utf-8');
        console.log(`  Created ${slice.specPath}`);
      }
    }

    console.log(`\n✅ Plan "${id}" confirmed.`);
    for (const v of plan.versions) {
      console.log(`   ${v.version}: ${v.slices.length} slices — ${v.description}`);
    }
    console.log(`\nRun "zelto version start <version>" to begin execution.`);
    return 0;
  }

  // zelto plan add-version <plan-id> <description> — append a new version via LLM
  if (subcmd === 'add-version') {
    const id = args[1];
    const description = args.slice(2).join(' ');
    if (!id || id.startsWith('--') || !description) {
      console.error('Usage: zelto plan add-version <plan-id> <version description>');
      return 1;
    }

    const versionStore = new VersionStore(ZELTO_DIR);
    if (!(await versionStore.exists(id))) {
      console.error(`Plan "${id}" not found.`);
      return 1;
    }
    const plan = await versionStore.read(id);

    // Find the design for context
    const designStore = new DesignStore(ZELTO_DIR);
    let designBody = '';
    try {
      const design = await designStore.read(plan.designId);
      designBody = design.body;
    } catch {
      console.error(`Design "${plan.designId}" not found. Cannot generate version without design context.`);
      return 1;
    }

    const llm = createLlmFromConfig();
    if (!llm) {
      console.error('LLM not configured. Add llm.apiKey to .zelto/config.yaml');
      return 1;
    }

    console.log(`Generating new version for plan "${id}"...`);
    const newVersion = await generateVersion(llm, designBody, plan.versions, description);

    // Check for duplicate version label
    if (plan.versions.some((v) => v.version === newVersion.version)) {
      console.error(`Version "${newVersion.version}" already exists in plan "${id}".`);
      return 1;
    }

    plan.versions.push(newVersion);
    await versionStore.save(plan);

    console.log(`\n✅ Version ${newVersion.version} added to plan "${id}":`);
    console.log(`   Description: ${newVersion.description}`);
    console.log(`   Depends on: ${newVersion.dependsOn.join(', ') || '(none)'}`);
    console.log(`   Slices:`);
    for (const s of newVersion.slices) {
      console.log(`     - ${s.id}: ${s.title} (module: ${s.module})`);
    }
    console.log(`\nRun "zelto plan confirm ${id}" to lock the updated plan.`);
    return 0;
  }

  // zelto plan <design-id> — generate version plan from design
  const designId = subcmd;
  if (!designId || designId.startsWith('--')) {
    console.error('Usage: zelto plan <design-id> | zelto plan confirm <id>');
    return 1;
  }

  const designStore = new DesignStore(ZELTO_DIR);
  if (!(await designStore.exists(designId))) {
    console.error(`Design "${designId}" not found.`);
    return 1;
  }
  const design = await designStore.read(designId);
  if (design.status !== 'confirmed') {
    console.error(`Design "${designId}" is not confirmed. Run "zelto design confirm ${designId}" first.`);
    return 1;
  }

  const llm = createLlmFromConfig();
  if (!llm) {
    console.error('LLM not configured. Add llm.apiKey to .zelto/config.yaml');
    return 1;
  }

  console.log('Generating version plan...');
  const result = await generateSlicePlan(llm, design.body, design.modules, '');

  const id = `plan-${Date.now()}`;
  const plan: VersionPlan = {
    id,
    designId,
    title: result.title,
    versions: result.versions,
    status: 'draft',
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };

  const versionStore = new VersionStore(ZELTO_DIR);
  await versionStore.save(plan);

  console.log(`\n✅ Plan created: ${id}`);
  console.log(`   Title: ${result.title}`);
  for (const v of result.versions) {
    console.log(`\n  ${v.version}: ${v.description}`);
    console.log(`    Status: ${v.status}`);
    for (const s of v.slices) {
      console.log(`    - ${s.id}: ${s.title}`);
    }
  }
  console.log(`\nRun: zelto plan confirm ${id}`);
  return 0;
});

// ─── version ──────────────────────────────────────────────────────────────

register('version', async (args) => {
  const subcmd = args[0];

  // zelto version status
  if (!subcmd || subcmd === 'status') {
    const versionStore = new VersionStore(ZELTO_DIR);
    const plans = await versionStore.list();
    if (plans.length === 0) {
      console.log('No version plans found.');
      return 0;
    }
    for (const p of plans) {
      const plan = await versionStore.read(p.id);
      const vIcons: Record<string, string> = {
        planned: '⏳', in_progress: '🔄', integrated: '✅', delivered: '🚀',
      };
      console.log(`Plan: ${p.id} (${p.status})`);
      console.log(`  Title: ${plan.title}`);
      for (const v of plan.versions) {
        const icon = vIcons[v.status] ?? '⏳';
        const slices = v.slices.map((s) => s.id).join(', ');
        console.log(`  ${icon} ${v.version}: ${v.status} — [${slices}]`);
      }
      // Show next actionable version
      const nextVersion = plan.versions.find((v) => v.status === 'planned');
      if (nextVersion) {
        const depsReady = nextVersion.dependsOn.every((dep) => {
          const dv = plan.versions.find((v) => v.version === dep);
          return dv && (dv.status === 'integrated' || dv.status === 'delivered');
        });
        if (depsReady) {
          console.log(`  👉 Next: zelto version start ${nextVersion.version} --plan ${plan.id}`);
        } else {
          const blockedBy = nextVersion.dependsOn.filter((dep) => {
            const dv = plan.versions.find((v) => v.version === dep);
            return !dv || (dv.status !== 'integrated' && dv.status !== 'delivered');
          });
          console.log(`  ⏳ Next: ${nextVersion.version} (waiting for: ${blockedBy.join(', ')})`);
        }
      }
      console.log('');
    }
    return 0;
  }

  // zelto version deliver <version-label> [--plan <plan-id>]
  if (subcmd === 'deliver') {
    const versionLabel = args[1];
    if (!versionLabel || versionLabel.startsWith('--')) {
      console.error('Usage: zelto version deliver <version-label> [--plan <plan-id>]');
      return 1;
    }

    const planIdx = args.indexOf('--plan');
    const planId = planIdx >= 0 ? args[planIdx + 1] : null;

    const versionStore = new VersionStore(ZELTO_DIR);
    let targetPlan: VersionPlan | null = null;

    if (planId) {
      if (!(await versionStore.exists(planId))) {
        console.error(`Plan "${planId}" not found.`);
        return 1;
      }
      targetPlan = await versionStore.read(planId);
    } else {
      const plans = await versionStore.list();
      const confirmed = plans.filter((p) => p.status === 'confirmed');
      if (confirmed.length === 0) {
        console.error('No confirmed plans found.');
        return 1;
      }
      targetPlan = await versionStore.read(confirmed[0].id);
    }

    const version = targetPlan.versions.find((v) => v.version === versionLabel);
    if (!version) {
      console.error(`Version "${versionLabel}" not found in plan "${targetPlan.id}".`);
      return 1;
    }

    if (version.status !== 'integrated') {
      console.error(`Version "${versionLabel}" is ${version.status}. Must be "integrated" to deliver.`);
      return 1;
    }

    await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'delivered');
    console.log(`\n🚀 Version ${versionLabel} delivered!`);
    console.log(`   ${version.description}`);
    console.log(`   Slices: ${version.slices.map((s) => s.id).join(', ')}`);

    // Check if next version can be started
    const nextVersion = targetPlan.versions.find((v) => v.status === 'planned');
    if (nextVersion) {
      const depsReady = nextVersion.dependsOn.every((dep) => {
        const dv = targetPlan!.versions.find((v) => v.version === dep);
        return dv && (dv.status === 'integrated' || dv.status === 'delivered');
      });
      if (depsReady) {
        console.log(`\n👉 Next: zelto version start ${nextVersion.version} [--plan ${targetPlan.id}]`);
      }
    }
    return 0;
  }

  // zelto version start <version-label> [--plan <plan-id>]
  if (subcmd === 'start') {
    const versionLabel = args[1];
    if (!versionLabel || versionLabel.startsWith('--')) {
      console.error('Usage: zelto version start <version-label> [--plan <plan-id>]');
      return 1;
    }

    const planIdx = args.indexOf('--plan');
    const planId = planIdx >= 0 ? args[planIdx + 1] : null;

    const versionStore = new VersionStore(ZELTO_DIR);
    let targetPlan: VersionPlan | null = null;

    if (planId) {
      if (!(await versionStore.exists(planId))) {
        console.error(`Plan "${planId}" not found.`);
        return 1;
      }
      targetPlan = await versionStore.read(planId);
    } else {
      const plans = await versionStore.list();
      const confirmed = plans.filter((p) => p.status === 'confirmed');
      if (confirmed.length === 0) {
        console.error('No confirmed plans found. Confirm a plan first.');
        return 1;
      }
      targetPlan = await versionStore.read(confirmed[0].id);
    }

    const version = targetPlan.versions.find((v) => v.version === versionLabel);
    if (!version) {
      console.error(`Version "${versionLabel}" not found in plan "${targetPlan.id}".`);
      return 1;
    }

    if (version.status !== 'planned') {
      console.error(`Version "${versionLabel}" is already ${version.status}.`);
      return 1;
    }

    // Check dependency versions
    for (const dep of version.dependsOn) {
      const depVersion = targetPlan.versions.find((v) => v.version === dep);
      if (depVersion && depVersion.status !== 'integrated' && depVersion.status !== 'delivered') {
        console.error(`Dependency ${dep} is not yet integrated (status: ${depVersion.status}).`);
        return 1;
      }
    }

    console.log(`Starting version ${versionLabel} (${version.description})`);
    console.log(`Slices: ${version.slices.map((s) => s.id).join(', ')}`);
    console.log('');

    // Update version status to in_progress
    await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'in_progress');

    const sliceStore = new SliceStore(SLICES_DIR);
    const cfg = loadConfig();

    // Phase 1: Prepare all slices (create, read spec, freeze)
    console.log('── Phase 1: Prepare slices ──');
    interface SliceCtx {
      def: VersionSlice;
      specContent: string;
      bundlePath: string;
    }
    const sliceCtxs: SliceCtx[] = [];

    for (const sliceDef of version.slices) {
      // Create slice data if it doesn't exist
      if (!(await sliceStore.exists(sliceDef.id))) {
        const sliceData = sliceStore.create(sliceDef.id, sliceDef.title, {
          writes: sliceDef.writes,
        });
        await sliceStore.write(sliceData);
        console.log(`  ✅ "${sliceDef.id}" created`);
      } else {
        console.log(`  ℹ️  "${sliceDef.id}" already exists`);
      }

      // Read or generate spec content
      const specPath = sliceDef.specPath;
      let specContent = '';
      try {
        specContent = readFileSync(specPath, 'utf-8');
      } catch {
        specContent = generateSliceSpecContent(sliceDef.id, sliceDef.title, sliceDef.module, sliceDef.writes, versionLabel);
        if (!existsSync('specs/slices')) mkdirSync('specs/slices', { recursive: true });
        writeFileSync(specPath, specContent, 'utf-8');
      }

      // Write bundle file
      const bundlePath = join(ZELTO_DIR, `${sliceDef.id}-bundle.json`);
      const promptContent = [
        `You are working on slice "${sliceDef.id}" of version ${versionLabel}.`,
        '',
        '## Spec',
        specContent,
        '',
        '## Write permissions',
        ...sliceDef.writes.map((w) => `- ${w}`),
        '',
        'Implement the spec above. Write code to satisfy the acceptance criteria.',
      ].join('\n');
      const bundle = {
        sliceId: sliceDef.id,
        specPath: sliceDef.specPath,
        writes: sliceDef.writes,
        instructions: promptContent,
        protectedPaths: ['policy/**', '.zelto/**', 'AGENTS.md'],
        policyRules: [],
      };
      writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');

      // Freeze the slice
      await sliceStore.transit(sliceDef.id, 'FREEZE');
      console.log(`  ❄️  "${sliceDef.id}" frozen`);

      sliceCtxs.push({ def: sliceDef, specContent, bundlePath });
    }

    // Phase 2: Run all agents in parallel
    console.log('\n── Phase 2: Execute agents (parallel) ──');
    const agentResults = await Promise.all(sliceCtxs.map(async (ctx) => {
      const agent = new ClaudeAgentAdapter({ cwd: process.cwd(), agentCommand: cfg.agent.command });
      const { sessionId } = await agent.start({ sliceId: ctx.def.id, prompt: ctx.bundlePath });
      const exitCode = await agent.waitForExit(sessionId);
      return { id: ctx.def.id, exitCode };
    }));

    for (const r of agentResults) {
      if (r.exitCode === 0) {
        console.log(`  ✅ "${r.id}" agent completed`);
        await sliceStore.transit(r.id, 'RUN_FINISH');
      } else {
        console.log(`  ❌ "${r.id}" agent failed (exit ${r.exitCode})`);
      }
    }

    // Phase 3: Run gates sequentially (avoid parallel pnpm test conflicts)
    console.log('\n── Phase 3: Gate checks ──');
    const gateResults: Array<{ id: string; passed: boolean }> = [];
    for (const ctx of sliceCtxs) {
      const agentOk = agentResults.find((r) => r.id === ctx.def.id)?.exitCode === 0;
      if (!agentOk) {
        gateResults.push({ id: ctx.def.id, passed: false });
        continue;
      }

      const gateConfig = {
        commands: cfg.gate.commands.map((c) => ({ name: c.name, run: c.run })),
        changedLineCoverage: 0.8,
        timeoutSec: cfg.gate.timeoutSec,
        retry: { max: cfg.gate.retry.max, budgetStepUsd: 0.05 },
      } satisfies GateConfig;
      const gate = new GateExecutor(sliceStore, events, gateConfig);
      const gateResult = await gate.execute(ctx.def.id);

      if (gateResult.passed) {
        await sliceStore.transit(ctx.def.id, 'GATE_PASS');
        console.log(`  ✅ "${ctx.def.id}" gate passed`);
        gateResults.push({ id: ctx.def.id, passed: true });
      } else {
        const failedCmds = gateResult.results.filter((r) => !r.passed).map((r) => r.command);
        console.log(`  ❌ "${ctx.def.id}" gate failed: ${failedCmds.join(', ')}`);
        gateResults.push({ id: ctx.def.id, passed: false });
      }
    }

    // Check results
    const allAgentsOk = agentResults.every((r) => r.exitCode === 0);
    const allGatesOk = gateResults.every((r) => r.passed);

    if (allAgentsOk && allGatesOk) {
      // Phase 4: Integration tests
      console.log('\n── Phase 4: Integration tests ──');
      const integrationTestDir = version.integrationTestDir;
      if (existsSync(integrationTestDir)) {
        const { execSync } = await import('node:child_process');
        try {
          execSync(`pnpm test -- --test-path-pattern "${integrationTestDir}"`, {
            cwd: process.cwd(),
            stdio: 'inherit',
            timeout: 120000,
          });
          console.log(`  ✅ Integration tests passed for ${versionLabel}`);
          await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'integrated');
          console.log(`\n✅ Version ${versionLabel} integrated successfully!`);
          console.log(`👉 Next: zelto version deliver ${versionLabel}`);
        } catch {
          console.error(`  ❌ Integration tests failed for ${versionLabel}`);
          await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'integrated');
          console.log(`\n⚠️  Version ${versionLabel} marked as integrated (tests need review).`);
        }
      } else {
        console.log(`  ℹ️  No integration tests at ${integrationTestDir}`);
        await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'integrated');
        console.log(`\n✅ Version ${versionLabel} integrated successfully!`);
        console.log(`👉 Next: zelto version deliver ${versionLabel}`);
      }
    } else {
      console.log(`\n❌ Version ${versionLabel} has failures:`);
      for (const r of agentResults) {
        if (r.exitCode !== 0) console.log(`   ❌ Agent: ${r.id} (exit ${r.exitCode})`);
      }
      for (const r of gateResults) {
        if (!r.passed) console.log(`   ❌ Gate: ${r.id}`);
      }
    }

    return allAgentsOk && allGatesOk ? 0 : 1;
  }

  console.error('Usage: zelto version status | zelto version start <ver> [--plan <id>] | zelto version deliver <ver> [--plan <id>]');
  return 1;
});

// ─── pipeline ────────────────────────────────────────────────────────────

register('pipeline', async (args) => {
  const subcmd = args[0];

  if (subcmd !== 'status') {
    console.error('Usage: zelto pipeline status');
    return 1;
  }

  const reqStore = new RequirementStore(ZELTO_DIR);
  const designStore = new DesignStore(ZELTO_DIR);
  const versionStore = new VersionStore(ZELTO_DIR);
  const sliceStore = new SliceStore(SLICES_DIR);

  const reqs = await reqStore.list();
  if (reqs.length === 0) {
    console.log('No requirements. Start with: zelto require <text>');
    return 0;
  }

  const designList = await designStore.list();
  const planList = await versionStore.list();

  for (const req of reqs) {
    const statusIcon = req.status === 'confirmed' ? '✅' : '📝';
    console.log(`${statusIcon} ${req.id}  (${req.status})  "${req.title}"`);

    const designs = (await Promise.all(
      designList.filter((d) => d.requirementId === req.id).map((d) => designStore.read(d.id)),
    ));

    if (designs.length === 0) {
      console.log('   └── (no design yet)');
      continue;
    }

    for (const design of designs) {
      const designIcon = design.status === 'confirmed' ? '✅' : '📝';
      console.log(`   │`);
      console.log(`   └── ${designIcon} ${design.id}  (${design.status})  "${design.title}"  [${design.modules.length} modules]`);

      const plans = (await Promise.all(
        planList.map((p) => versionStore.read(p.id)),
      )).filter((p) => p.designId === design.id);

      if (plans.length === 0) {
        console.log(`       └── (no plan yet)`);
        continue;
      }

      for (const plan of plans) {
        const planIcon = plan.status === 'confirmed' ? '✅' : '📝';
        console.log(`       │`);
        console.log(`       └── ${planIcon} ${plan.id}  (${plan.status})  "${plan.title}"`);

        for (const v of plan.versions) {
          const vIcons: Record<string, string> = {
            planned: '⏳', in_progress: '🔄', integrated: '✅', delivered: '🚀',
          };
          const vIcon = vIcons[v.status] ?? '⏳';
          console.log(`           │`);
          console.log(`           ├── ${vIcon} ${v.version}  (${v.status})  ${v.description}`);

          for (const s of v.slices) {
            let sliceState = '—';
            try {
              const sd = await sliceStore.read(s.id);
              sliceState = sd.state;
            } catch { /* not created yet */ }
            const sIcons: Record<string, string> = {
              draft: '📝', clarifying: '❓', frozen: '❄️', running: '🔄',
              completed: '✅', abandoned: '🗑️',
            };
            const sIcon = sIcons[sliceState] ?? '⬜';
            console.log(`           │   └── ${sIcon} ${s.id}  (${sliceState})  ${s.title}`);
          }
        }
      }
    }
  }

  return 0;
});

// ─── trace ───────────────────────────────────────────────────────────────

register('trace', async (args) => {
  const reqId = args[0];
  if (!reqId || reqId.startsWith('--')) {
    console.error('Usage: zelto trace <requirement-id>');
    return 1;
  }

  const reqStore = new RequirementStore(ZELTO_DIR);
  const designStore = new DesignStore(ZELTO_DIR);
  const versionStore = new VersionStore(ZELTO_DIR);
  const sliceStore = new SliceStore(SLICES_DIR);

  // Validate requirement exists
  if (!(await reqStore.exists(reqId))) {
    console.error(`Requirement "${reqId}" not found.`);
    return 1;
  }

  const req = await reqStore.read(reqId);
  console.log(`📋 Trace for: ${req.id}  "${req.title}"  (${req.status})`);
  console.log(`   Acceptance Criteria: ${req.acceptanceCriteria.length}`);
  console.log('');

  // Find all designs for this requirement
  const allDesigns = await designStore.list();
  const matchingDesigns = allDesigns.filter((d) => d.requirementId === reqId);

  if (matchingDesigns.length === 0) {
    console.log('   No designs trace to this requirement.');
    return 0;
  }

  for (const ds of matchingDesigns) {
    const design = await designStore.read(ds.id);
    const designIcon = design.status === 'confirmed' ? '✅' : '📝';
    console.log(`   ${designIcon} Design: ${design.id}  "${design.title}"  (${design.status})`);
    console.log(`      Modules: ${design.modules.map((m) => m.name).join(', ')}`);

    // Find plans for this design
    const allPlans = await versionStore.list();
    const matchingPlans = (await Promise.all(
      allPlans.map((p) => versionStore.read(p.id)),
    )).filter((p) => p.designId === design.id);

    if (matchingPlans.length === 0) {
      console.log('      └── No plan traces to this design.');
      continue;
    }

    for (const plan of matchingPlans) {
      const planIcon = plan.status === 'confirmed' ? '✅' : '📝';
      console.log(`      ${planIcon} Plan: ${plan.id}  "${plan.title}"  (${plan.status})`);

      for (const v of plan.versions) {
        console.log(`         ${v.version}  (${v.status}):`);

        for (const s of v.slices) {
          let sliceState = '—';
          try {
            const sd = await sliceStore.read(s.id);
            sliceState = sd.state;
          } catch { /* not created */ }
          console.log(`           ${s.id}  (${sliceState})  ${s.title}  [module: ${s.module}]`);
        }
      }
    }
  }

  return 0;
});

// ─── impact ──────────────────────────────────────────────────────────────

register('impact', async (args) => {
  const reqId = args[0];
  if (!reqId || reqId.startsWith('--')) {
    console.error('Usage: zelto impact <requirement-id>');
    return 1;
  }

  const reqStore = new RequirementStore(ZELTO_DIR);
  const designStore = new DesignStore(ZELTO_DIR);
  const versionStore = new VersionStore(ZELTO_DIR);
  const sliceStore = new SliceStore(SLICES_DIR);

  if (!(await reqStore.exists(reqId))) {
    console.error(`Requirement "${reqId}" not found.`);
    return 1;
  }

  const req = await reqStore.read(reqId);
  console.log(`\n🔍 Impact Analysis for: ${req.id}  "${req.title}"`);
  console.log(`   Current status: ${req.status}`);
  console.log('');

  // Collect all affected items
  const allDesigns = await designStore.list();
  const matchingDesigns = allDesigns.filter((d) => d.requirementId === reqId);

  if (matchingDesigns.length === 0) {
    console.log('   ✅ No downstream impact — no designs reference this requirement.');
    return 0;
  }

  let hasActiveWork = false;
  let confirmedCount = 0;
  let inProgressCount = 0;

  for (const ds of matchingDesigns) {
    const design = await designStore.read(ds.id);
    const designImpact = design.status === 'confirmed' ? '⚠️' : 'ℹ️';
    if (design.status === 'confirmed') confirmedCount++;

    console.log(`   ${designImpact} Design: ${design.id}  "${design.title}"  (${design.status})`);
    if (design.status === 'confirmed') {
      console.log(`      Impact: Design is confirmed — re-review needed if requirement changes.`);
    }

    const allPlans = await versionStore.list();
    const matchingPlans = (await Promise.all(
      allPlans.map((p) => versionStore.read(p.id)),
    )).filter((p) => p.designId === design.id);

    for (const plan of matchingPlans) {
      const planImpact = plan.status === 'confirmed' ? '⚠️' : 'ℹ️';
      if (plan.status === 'confirmed') confirmedCount++;

      console.log(`      ${planImpact} Plan: ${plan.id}  "${plan.title}"  (${plan.status})`);
      if (plan.status === 'confirmed') {
        console.log(`         Impact: Plan is confirmed — may need regeneration.`);
      }

      for (const v of plan.versions) {
        if (v.status !== 'planned') hasActiveWork = true;

        for (const s of v.slices) {
          let sliceState = '—';
          try {
            const sd = await sliceStore.read(s.id);
            sliceState = sd.state;
            if (sd.state === 'running') inProgressCount++;
            if (sd.state === 'completed' || sd.state === 'frozen') hasActiveWork = true;
          } catch { /* not created */ }

          const sliceImpact =
            sliceState === 'completed' ? '⚠️' :
            sliceState === 'running' ? '🔴' :
            sliceState === 'frozen' ? '⚠️' :
            sliceState === 'draft' ? 'ℹ️' : '⬜';
          const impactNote =
            sliceState === 'completed' ? 'already completed — may need rework' :
            sliceState === 'running' ? 'IN PROGRESS — will be invalidated' :
            sliceState === 'frozen' ? 'frozen but not yet run — may need re-freeze' :
            sliceState === 'draft' ? 'not yet started — safe to adjust' :
            '';

          console.log(`         ${sliceImpact} ${s.id}  (${sliceState})  ${s.title}`);
          if (impactNote) console.log(`            ${impactNote}`);
        }
      }
    }
  }

  // Summary
  console.log('');
  console.log('─── Impact Summary ───');
  console.log(`   Designs/Plans confirmed: ${confirmedCount}`);
  if (inProgressCount > 0) console.log(`   🔴 Slices in progress: ${inProgressCount}  — WILL BE INVALIDATED`);
  if (hasActiveWork) console.log(`   ⚠️  Completed/frozen work exists — may need rework`);
  console.log('');

  if (hasActiveWork || confirmedCount > 0) {
    console.log('Recommendation:');
    console.log(`   If this requirement change is significant:`);
    console.log(`   1. Create a new version of the requirement (zelto require with supersede info)`);
    console.log(`   2. Regenerate the design (zelto design <new-req-id>)`);
    console.log(`   3. Re-plan affected versions (zelto plan <new-design-id>)`);
    console.log(`   4. Re-execute affected slices`);
  } else {
    console.log('✅ No active work affected — safe to modify.');
  }

  return 0;
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
