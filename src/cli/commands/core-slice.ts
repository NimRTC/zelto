// Core slice lifecycle commands: slices, create, check, clarify, abandon, freeze, run, admit

import { createInterface } from 'node:readline';
import { writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Extract the value of a named flag from args, stopping at the next flag.
 * Returns undefined if the flag is not found or has no value.
 * E.g. extractFlagValue(['--title', 'hello', '--writes', 'x'], '--title') → 'hello'
 */
function extractFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const parts: string[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    parts.push(args[i]);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
import { ClarifyEngine, type LlmQuestionGenerator } from '../../core/clarify/engine.js';
import { Scheduler } from '../../core/sched/engine.js';
import { BudgetCollector } from '../../core/budget/collector.js';
import { GateExecutor } from '../../core/gate/executor.js';
import { SignManager } from '../../core/gate/sign.js';
import type { GateConfig } from '../../core/gate/types.js';
import { detectSliceType } from '../../core/gate/types.js';
import { classifyStall, isAutoResolvable } from '../../core/stall/classifier.js';
import { register } from './shared.js';
import { store, events, ZELTO_DIR, loadPolicyConfig, hashSpecFile, loadConfig, createLlmFromConfig, createExecutorAdapter } from './shared.js';
import { generateClarifyQuestions } from '../../llm/generators/clarify.js';

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
  let [id] = args;

  // Show usage for --help
  if (id === '--help' || id === '-h') {
    console.error('Usage: zelto create <slice-id> [--title <title>] [--writes <path1,path2,...>] [--from-spec]');
    console.error('');
    console.error('  --from-spec    Parse spec markdown (specs/slices/<id>.md) to auto-populate');
    console.error('                 writes, requirements, baseline, and acceptance test fields.');
    console.error('                 Also detects v0- prefix as baseline slice.');
    return 0;
  }

  // Interactive mode: prompt for values if not provided
  if (!id || id.startsWith('--')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

    console.log('Creating a new slice (interactive mode)');
    console.log('');

    id = (await ask('  Slice ID (e.g. "my-feature"): ')).trim();
    if (!id) {
      console.error('Error: Slice ID is required.');
      rl.close();
      return 1;
    }

    const titleInput = await ask('  Title (optional, defaults to ID): ');
    const writesInput = await ask('  Write-set (comma-separated paths, optional): ');

    rl.close();

    args = [id];
    if (titleInput) {
      args.push('--title', titleInput);
    }
    if (writesInput) {
      args.push('--writes', ...writesInput.split(',').map((w) => w.trim()).filter(Boolean));
    }
  }

  // Re-parse after potential interactive input
  id = args[0];
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto create <slice-id> [--title <title>] [--writes <path1,path2,...>]');
    return 1;
  }

  const title = extractFlagValue(args, '--title') ?? id;

  const writesRaw = extractFlagValue(args, '--writes');
  const writes = writesRaw ? writesRaw.split(',').map((w: string) => w.trim()).filter(Boolean) : [];

  const isJson = args.includes('--json');
  const fromSpec = args.includes('--from-spec');

  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    if (isJson) {
      console.log(JSON.stringify({ success: false, error: `Invalid slice ID: "${id}"` }));
    } else {
      console.error(`Invalid slice ID: "${id}". Use only letters, numbers, hyphens, and underscores.`);
    }
    return 1;
  }

  if (await store.exists(id)) {
    if (isJson) {
      console.log(JSON.stringify({ success: false, error: `Slice "${id}" already exists.` }));
    } else {
      console.error(`Slice "${id}" already exists.`);
    }
    return 1;
  }

  // If --from-spec, parse the spec markdown to populate slice fields
  if (fromSpec) {
    return await createSliceFromSpec(id, title, writes, isJson);
  }

  const slice = store.create(id, title, { writes });
  await store.write(slice);
  await events.append(id, 'spec.drafted', 'cli', { sliceId: id, title, specPath: slice.spec.path });

  if (isJson) {
    console.log(JSON.stringify({
      success: true, id, title, state: slice.state,
      writes, spec: slice.spec.path,
    }));
    return 0;
  }

  console.log(`zelto create ${id} — ✅ Created`);
  console.log(`  ID:     ${id}`);
  console.log(`  Title:  ${title}`);
  console.log(`  State:  ${slice.state}`);
  console.log(`  Writes: ${writes.length > 0 ? writes.join(', ') : '(none)'}`);
  console.log(`  Spec:   ${slice.spec.path}`);
  console.log(`  Next:   zelto check ${id} && zelto freeze ${id}`);
  return 0;
});

// ─── create from spec (helper for --from-spec) ────────────────────────────

/**
 * Create a slice from a spec markdown file.
 * Parses ## 范围 for writes, ## 验收标准 for requirements.
 * Detects v0- prefix as baseline slices.
 */
async function createSliceFromSpec(
  id: string,
  title: string,
  cliWrites: string[],
  isJson: boolean,
): Promise<number> {
  const specPath = `specs/slices/${id}.md`;

  let content: string;
  try {
    content = await readFile(specPath, 'utf-8');
  } catch {
    if (isJson) {
      console.log(JSON.stringify({ success: false, error: `Spec file not found: ${specPath}` }));
    } else {
      console.error(`Spec file not found: ${specPath}`);
    }
    return 1;
  }

  const lines = content.split('\n');

  // Parse title from # Slice: <id> heading
  let parsedTitle = title;
  for (const line of lines) {
    const sliceMatch = line.match(/^#\s*Slice:\s*(.+)$/i);
    if (sliceMatch) {
      parsedTitle = sliceMatch[1].trim();
      break;
    }
  }

  // Parse writes and requirements in a single pass
  const writes: string[] = [];
  const requirements: string[] = [];
  const cliWritesProvided = cliWrites.length > 0;

  let inScope = false;
  let inAcceptance = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inScope = /范围|scope|range/i.test(line);
      inAcceptance = /验收标准|acceptance|criter/i.test(line);
      continue;
    }
    if (inScope && !cliWritesProvided) {
      const writeMatch = line.match(/^\s*[-*]\s*`([^`]+)`/);
      if (writeMatch) {
        writes.push(writeMatch[1]);
      }
    }
    if (inAcceptance) {
      const reqMatch = line.match(/^\s*\d+\.\s+(.+)/);
      if (reqMatch) {
        requirements.push(reqMatch[1].trim());
      }
    }
  }

  // Detect baseline slices (v0- prefix)
  const isBaseline = id.startsWith('v0-');

  // Auto-detect traceWaiver for non-TypeScript projects
  const hasTypeScriptFiles = writes.some((w) => w.endsWith('.ts') || w.endsWith('.tsx') || w.includes('.ts'));
  const traceWaiver = isBaseline && !hasTypeScriptFiles ? '基线切片 — 不修改代码，无需契约追踪' : null;

  // Auto-detect acceptance test file
  const acceptanceTestPath = `tests/acceptance/${id}.test.ts`;
  const hasAcceptanceTest = existsSync(acceptanceTestPath);
  const acceptanceTests = hasAcceptanceTest ? [acceptanceTestPath] : [];

  const finalWrites = cliWritesProvided ? cliWrites : writes;

  // Auto-detect slice type from write-set
  const sliceType = detectSliceType(finalWrites);

  const slice = store.create(id, parsedTitle, {
    writes: finalWrites,
    type: sliceType,
    trace: { requirements, contracts: [], tests: acceptanceTests },
    traceWaiver,
    baseline: isBaseline,
  });

  // Update acceptance.dir if test file detected
  if (hasAcceptanceTest) {
    slice.acceptance.dir = acceptanceTestPath;
  }
  await store.write(slice);
  await events.append(id, 'spec.drafted', 'cli', { sliceId: id, title: parsedTitle, specPath, fromSpec: true });

  if (isJson) {
    console.log(JSON.stringify({
      success: true, id, title: parsedTitle, state: slice.state,
      writes: finalWrites, spec: slice.spec.path,
      baseline: isBaseline, traceWaiver,
      requirements: requirements.length,
      acceptanceTest: hasAcceptanceTest ? acceptanceTestPath : null,
    }));
    return 0;
  }

  console.log(`zelto create ${id} — ✅ Created from spec (${specPath})`);
  console.log(`  ID:       ${id}`);
  console.log(`  Title:    ${parsedTitle}`);
  console.log(`  State:    ${slice.state}`);
  console.log(`  Baseline: ${isBaseline ? '✅ (v0- prefix detected)' : 'no'}`);
  console.log(`  Writes:   ${finalWrites.length > 0 ? finalWrites.join(', ') : '(none — add with --writes)'}`);
  console.log(`  Reqs:     ${requirements.length} parsed from spec`);
  if (hasAcceptanceTest) console.log(`  Accept:   ✅ ${acceptanceTestPath}`);
  if (traceWaiver) console.log(`  Waiver:   ${traceWaiver}`);
  console.log(`  Spec:     ${slice.spec.path}`);
  console.log(`  Next:     zelto check ${id} && zelto freeze ${id}`);
  return 0;
}

// ─── check ───────────────────────────────────────────────────────────────────

register('check', async (args) => {
  const [id] = args;
  if (!id) {
    console.error('Usage: zelto check <slice-id>');
    return 1;
  }

  const isJson = args.includes('--json');

  try {
    const slice = await store.read(id);

    // For completed/abandoned slices, just show state without warnings
    if (slice.state === 'completed' || slice.state === 'abandoned') {
      if (isJson) {
        console.log(JSON.stringify({
          sliceId: id, state: slice.state, passed: true,
          issues: [], message: `Slice is ${slice.state} — no checks needed`,
        }));
      } else {
        console.log(`zelto check ${id} — ✅ Slice is ${slice.state}, no checks needed.`);
        console.log(`  Use --retry with gate to re-run, or "zelto slice ${id}" for details.`);
      }
      return 0;
    }

    console.log(`zelto check ${id} — running gate① checks...`);
    console.log(`  Slice:   ${slice.title}`);
    console.log(`  State:   ${slice.state}`);
    console.log(`  Spec:    ${slice.spec.path}`);
    const waiverNote = slice.traceWaiver ? ` (waived: ${slice.traceWaiver})` : '';
    console.log(`  Traces:  ${slice.trace.requirements.length} reqs, ${slice.trace.contracts.length} contracts${waiverNote}, ${slice.trace.tests.length} tests`);

    const issues: string[] = [];
    if (slice.trace.requirements.length === 0) issues.push('No requirements traced');
    if (slice.trace.contracts.length === 0 && !slice.traceWaiver) issues.push('No contracts traced');
    if (slice.trace.tests.length === 0) issues.push('No tests traced');
    if (slice.drift.detected) issues.push(`Drift detected: ${slice.drift.reason}`);

    // Validate write-set paths exist in the repo
    const missingWrites = slice.writes.filter((w) => {
      // Glob patterns with * are hard to verify; skip those
      if (w.includes('*') || w.includes('?')) return false;
      return !existsSync(w);
    });
    if (missingWrites.length > 0) {
      issues.push(`Write-set paths not found: ${missingWrites.join(', ')}`);
    }

    // Validate acceptance test path exists
    if (slice.acceptance.dir && !slice.acceptance.dir.includes('*') && slice.state !== 'draft') {
      const acceptPath = slice.acceptance.dir.endsWith('/')
        ? slice.acceptance.dir.slice(0, -1)
        : slice.acceptance.dir;
      if (!existsSync(acceptPath) && !existsSync(`${acceptPath}.test.ts`)) {
        issues.push(`Acceptance test path not found: ${slice.acceptance.dir}`);
      }
    }

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

    if (isJson) {
      console.log(JSON.stringify({
        sliceId: id, state: slice.state, passed: issues.length === 0,
        issues, traces: slice.trace,
      }));
      return issues.length === 0 ? 0 : 1;
    }

    if (issues.length === 0) {
      console.log('  Result:  ✅ All checks passed');
    } else if (slice.state === 'frozen') {
      console.log(`  Issues:  ${issues.join(', ')}`);
      console.log('  Result:  ⚠️  Fix issues before gate');
    } else {
      console.log(`  Issues:  ${issues.join(', ')}`);
      console.log('  Result:  ⚠️  Fix issues before freezing');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, error: msg }));
    } else {
      console.error(`Error reading slice "${id}": ${msg}`);
    }
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

    // Create LLM-powered question generator if LLM is configured
    const llm = createLlmFromConfig('clarify', 'cli');
    const llmGenerator: LlmQuestionGenerator | null = llm
      ? async (s, round) => {
          const questions = await generateClarifyQuestions(llm, {
            id: s.id,
            title: s.title,
            writes: s.writes,
            requirements: s.trace.requirements,
            contracts: s.trace.contracts,
            tests: s.trace.tests,
            acceptanceDir: s.acceptance.dir,
            oracleSrc: s.acceptance.oracleSrc,
          }, round);
          if (questions.length === 0) return null;
          return questions.map((q) => ({
            ...q,
            selfAnswered: false,
          }));
        }
      : null;

    const engine = new ClarifyEngine(events, llmGenerator);

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
      const result = await engine.generateQuestions(current, round);

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
    const result = await engine.generateQuestions(current, round);

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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error clarifying slice "${id}": ${msg}`);
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error abandoning slice "${id}": ${msg}`);
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

  const isJson = args.includes('--json');

  try {
    const slice = await store.read(id);
    if (slice.state !== 'draft' && slice.state !== 'clarifying') {
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, success: false, error: `Cannot freeze slice in state "${slice.state}"` }));
      } else {
        console.error(`Slice "${id}" is in state "${slice.state}", cannot freeze.`);
      }
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

    if (isJson) {
      console.log(JSON.stringify({
        sliceId: id, success: true, state: 'frozen',
        frozenHash: slice.spec.frozenHash, frozenAt: slice.spec.frozenAt,
      }));
    } else {
      console.log(`zelto freeze ${id} — ✅ Slice frozen at ${slice.spec.frozenAt}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, success: false, error: msg }));
    } else {
      console.error(`Error freezing slice "${id}": ${msg}`);
    }
    return 1;
  }
  return 0;
});

// ─── run ─────────────────────────────────────────────────────────────────────

register('run', async (args) => {
  // Dispatch to parallel runner if --parallel flag is present
  if (args.includes('--parallel')) {
    return runParallel(args);
  }

  const [id] = args;
  if (!id) {
    console.error('Usage: zelto run <slice-id> [--agent <name>] [--adapter <type>] [--dry-run]');
    console.error('       zelto run --parallel <id1> [id2 ...] [--agent <name>]');
    console.error('       zelto run --hotfix <slice-id> [--agent <name>]');
    return 1;
  }

  const isHotfix = args.includes('--hotfix');
  const isDetach = args.includes('--detach');

  const isJson = args.includes('--json');

  try {
    const scheduler = new Scheduler(store, events, loadPolicyConfig());

    const result = await scheduler.admit(id);
    if (result.decision !== 'admitted') {
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, decision: 'blocked', reason: result.reason, blockedBy: result.blockedBy }));
      } else {
        console.error(`zelto run ${id} — ❌ Cannot run: ${result.reason}`);
        if (result.blockedBy.length > 0) {
          console.error(`  Blocked by: ${result.blockedBy.join(', ')}`);
        }
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
      const bundle = scheduler.buildConstraints(slice);
      if (isJson) {
        console.log(JSON.stringify({
          sliceId: id, decision: 'admitted', dryRun: true,
          spec: bundle.specPath, frozenHash: bundle.frozenHash,
          writes: bundle.writes, policyRules: bundle.policyRules.length,
        }));
      } else {
        console.log(`zelto run ${id} — ✅ Would admit (dry-run)`);
        console.log(`  Spec:          ${bundle.specPath}`);
        console.log(`  Frozen hash:   ${bundle.frozenHash}`);
        console.log(`  Write-set:     ${bundle.writes.join(', ') || '(none)'}`);
        console.log(`  Policy rules:  ${bundle.policyRules.length}`);
        console.log(`  Instructions:  ${bundle.instructions.split('\n').length} lines`);
      }
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

    // Create feature branch for this slice
    const branchName = `slice/${id}`;
    try {
      const { execSync } = await import('node:child_process');

      // Check for uncommitted changes
      const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (status) {
        console.warn(`  ⚠️  You have uncommitted changes. They will be included in slice "${id}".`);
        console.warn(`       Commit them first if they belong to a different slice.`);
      }

      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (currentBranch === 'main' || currentBranch === 'master') {
        execSync(`git checkout -b ${branchName}`, { cwd: process.cwd(), timeout: 10000 });
        console.log(`  Branch:        ${branchName} (created from ${currentBranch})`);
      } else {
        console.log(`  Branch:        ${currentBranch} (already on feature branch)`);
      }
    } catch {
      console.log(`  Branch:        (not a git repository or git unavailable)`);
    }

    const cfg = loadConfig();
    const agentCmd = cfg.agent.command;
    const agentName = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : agentCmd;

    console.log(`  Agent:         ${agentName}`);
    console.log(`  Bundle:        ${bundlePath}`);
    console.log('');

    const adapterType = args.includes('--adapter') ? args[args.indexOf('--adapter') + 1] : undefined;

    // Check agent availability before starting
    try {
      const { ClaudeAgentAdapter } = await import('../../adapters/claude-agent/index.js');
      const agentError = await ClaudeAgentAdapter.checkAgentAvailable(agentName);
      if (agentError) {
        console.error(`  ❌ ${agentError}`);
        return 1;
      }
    } catch {
      // checkAgentAvailable might not exist in SDK adapter; skip check
    }

    // Show progress spinner during execution
    let startTime = Date.now();
    let progressTimer: ReturnType<typeof setInterval> | null = null;

    const sliceData = await store.read(id);
    const agentTimeout = sliceData.agentTimeout;
    let adapter = createExecutorAdapter(adapterType, agentName, agentTimeout);
    let { sessionId } = await adapter.start({ sliceId: id, prompt: bundlePath });

    await events.append(id, 'run.started', 'zelto', {
      sliceId: id, agent: agentName, bundlePath, writes: bundle.writes,
    });

    // ── Detach mode ─────────────────────────────────────────────────
    if (isDetach) {
      // Save task tracking info and return immediately
      const taskId = `task-${id}-${Date.now()}`;
      const taskInfo = {
        taskId,
        sliceId: id,
        sessionId,
        agentName,
        startedAt: new Date().toISOString(),
        status: 'running' as const,
      };
      const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const tasksDir = join(ZELTO_DIR, 'tasks');
      if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify(taskInfo, null, 2), 'utf-8');

      // Spawn background monitor to update task status
      monitorTaskInBackground(taskId, sessionId, adapter, id, startTime, isHotfix);
      console.log(`zelto run ${id} — ✅ Detached (task: ${taskId})`);
      console.log(`  Session: ${sessionId}`);
      console.log(`  Run: zelto status ${taskId}`);
      return 0;
    }

    // Start progress display
    progressTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      process.stdout.write(`\r  ⏱️  Agent running... ${mins}m ${secs}s`);
    }, 1000);

    // Retry loop: agent may auto-retry internally (adapter handles transient failures),
    // then handleAgentFailure handles auto-resolvable stalls at the CLI level
    const config = loadConfig();
    const maxRetries = config.agent.maxRetries ?? 2;
    let finalExitCode: number | null = null;
    let attempt = 0;

    while (attempt <= maxRetries) {
      const exitCode = await adapter.waitForExit(sessionId);

      // Clear progress display
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      process.stdout.write('\r' + ' '.repeat(50) + '\r');

      if (exitCode === 0) {
        finalExitCode = 0;
        break;
      }

      // Agent failed — try auto-retry at CLI level
      await events.append(id, 'run.aborted', 'zelto', { sliceId: id, exitCode });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`\n❌ Agent exited with code ${exitCode} (${elapsed}s)`);

      if (attempt < maxRetries) {
        const result = await handleAgentFailure(id, exitCode, { maxRetries });
        if (result.action === 'retry') {
          attempt = result.retryCount ?? attempt + 1;
          // Re-create adapter and re-start agent for retry
          adapter = createExecutorAdapter(adapterType, agentName, agentTimeout);
          const { sessionId: newSessionId } = await adapter.start({
            sliceId: id, prompt: bundlePath,
          });
          sessionId = newSessionId;

          // Restart progress display
          progressTimer = setInterval(() => {
            const e = Math.floor((Date.now() - startTime) / 1000);
            const mins = Math.floor(e / 60);
            const secs = e % 60;
            process.stdout.write(`\r  ⏱️  Agent running... ${mins}m ${secs}s`);
          }, 1000);

          continue; // Retry
        }
      }

      // Not retrying — write stall and stop
      await handleAgentFailure(id, exitCode, { maxRetries });
      finalExitCode = exitCode;
      break;
    }

    if (finalExitCode === 0) {
      await store.transit(id, 'RUN_FINISH');
      await events.append(id, 'run.finished', 'zelto', { sliceId: id, exitCode: 0 });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`✅ Agent completed successfully (${elapsed}s)`);

      if (isHotfix) {
        // Hotfix: skip gate, auto-sign, write hotfix event
        await store.transit(id, 'GATE_PASS');
        await events.append(id, 'slice.hotfix', 'zelto', {
          sliceId: id, elapsed, note: 'hotfix — gate skipped, auto-approved',
        });
        const signManager = new SignManager(ZELTO_DIR, events, store);
        const signReq = await signManager.request(id, 'zelto');
        await signManager.approve(signReq.id, 'zelto');
        console.log(`  🔥 Hotfix: gate skipped, auto-approved (${signReq.id})`);
      } else {
        // Auto-run gate and create sign request on pass
        await autoGateAfterRun(id);
      }
    } else {
      // All retries exhausted or non-resolvable — already handled by handleAgentFailure
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`\n❌ Slice "${id}" failed after ${attempt + 1} attempt(s) (${elapsed}s)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error running slice "${id}": ${msg}`);
    return 1;
  }
  return 0;
});

// ─── run:parallel — concurrent slice execution ─────────────────────

interface ParallelRunState {
  id: string;
  status: 'admitted' | 'running' | 'completed' | 'failed';
  elapsedSec: number;
  exitCode: number | null;
  sessionId: string | null;
  branchName: string;
}

/**
 * Run multiple non-conflicting slices in parallel.
 *
 * Usage: zelto run --parallel <id1> [id2 ...] [--agent <name>] [--adapter <type>]
 *
 * Flow:
 * 1. Admit all slices + check cross-conflicts
 * 2. Create feature branches from same base commit
 * 3. Start all agent sessions concurrently
 * 4. Monitor progress with multi-line display
 * 5. Process results (gate + sign requests)
 */
async function runParallel(args: string[]): Promise<number> {
  // Collect slice IDs: all non-flag args, regardless of --parallel position
  const ids = args.filter((a) => !a.startsWith('--') && a !== '--parallel');

  if (ids.length < 2) {
    console.error('Usage: zelto run --parallel <slice-id-1> <slice-id-2> [...slice-id-N] [--agent <name>]');
    return 1;
  }

  const scheduler = new Scheduler(store, events, loadPolicyConfig());

  // ── Phase 1: Admit all slices ────────────────────────────────────
  const states: ParallelRunState[] = ids.map((id) => ({
    id,
    status: 'admitted',
    elapsedSec: 0,
    exitCode: null,
    sessionId: null,
    branchName: `slice/${id}`,
  }));

  console.log(`zelto run --parallel — admitting ${ids.length} slices...`);

  for (const st of states) {
    const result = await scheduler.admit(st.id);
    if (result.decision !== 'admitted') {
      console.error(`  ❌ ${st.id}: ${result.reason}`);
      return 1;
    }
  }

  // Read all slice data
  const slices = await Promise.all(ids.map((id) => store.read(id)));

  // Check cross-conflicts: no two parallel slices may write the same files
  const conflicts = scheduler.checkConflicts(slices.map((s) => s.writes));
  if (conflicts.length > 0) {
    for (const [i, j] of conflicts) {
      console.error(`  ❌ Write-set conflict: ${ids[i]} ↔ ${ids[j]}`);
      console.error(`     "${ids[i]}" writes: ${slices[i].writes.join(', ')}`);
      console.error(`     "${ids[j]}" writes: ${slices[j].writes.join(', ')}`);
    }
    return 1;
  }

  // Auto-detect writes for empty write-sets
  for (let i = 0; i < slices.length; i++) {
    if (slices[i].writes.length === 0) {
      const detected = detectDefaultWrites();
      if (detected.length > 0) {
        slices[i].writes = detected;
        await store.write(slices[i]);
        console.log(`  ℹ️  ${ids[i]}: auto-detected write-set: ${detected.join(', ')}`);
      }
    }
  }

  // Check budgets
  for (const id of ids) {
    const ok = await checkBudget(id);
    if (!ok) {
      console.error(`  ❌ ${id}: budget exhausted`);
      return 1;
    }
  }

  // ── Phase 2: Create feature branches & start agents ──────────────
  const { execSync } = await import('node:child_process');
  const agentName = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : loadConfig().agent.command;
  const adapterType = args.includes('--adapter') ? args[args.indexOf('--adapter') + 1] : undefined;

  // Record base commit for branch creation
  let baseCommit: string | null = null;
  try {
    baseCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    // Non-git repo
  }

  // Check for uncommitted changes
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (status) {
      console.warn(`  ⚠️  You have uncommitted changes. They will be included in all parallel slices.`);
      console.warn(`       Commit them first if they belong to a different slice.`);
    }
  } catch { /* ignore */ }

  for (let i = 0; i < ids.length; i++) {
    const st = states[i];
    const slice = slices[i];

    // Start run
    await scheduler.startRun(st.id);

    // Build constraint bundle
    const bundle = scheduler.buildConstraints(slice);
    const bundlePath = join(ZELTO_DIR, `${st.id}-bundle.json`);
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');

    // Create feature branch from base commit
    if (baseCommit) {
      try {
        execSync(`git checkout -b ${st.branchName} ${baseCommit}`, { cwd: process.cwd(), timeout: 10000 });
      } catch {
        // Branch may already exist; try switching
        try {
          execSync(`git checkout ${st.branchName}`, { cwd: process.cwd(), timeout: 10000 });
        } catch { /* give up */ }
      }
    }

    // Write event
    await events.append(st.id, 'run.started', 'zelto', {
      sliceId: st.id, agent: agentName, bundlePath, writes: slice.writes,
    });
  }

  // Switch back to main after creating all branches
  if (baseCommit) {
    try {
      execSync('git checkout main', { cwd: process.cwd(), timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      try {
        execSync('git checkout master', { cwd: process.cwd(), timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { /* ignore */ }
    }
  }

  // Start all agent sessions — each with its own timeout from slice config
  const adapters = states.map((st, i) => {
    const timeout = slices[i]?.agentTimeout;
    return createExecutorAdapter(adapterType, agentName, timeout);
  });

  const startTime = Date.now();
  console.log(`\nzelto run --parallel — starting ${ids.length} agents...`);

  for (let i = 0; i < states.length; i++) {
    const st = states[i];
    const adapter = adapters[i];
    const bundlePath = join(ZELTO_DIR, `${st.id}-bundle.json`);
    try {
      let sessionId: string | undefined;
      ({ sessionId } = await adapter.start({ sliceId: st.id, prompt: bundlePath }));
      st.sessionId = sessionId;
      st.status = 'running';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${st.id}: failed to start agent: ${msg}`);
      st.status = 'failed';
    }
  }

  // ── Phase 3: Monitor progress ────────────────────────────────────
  const statusLineCount = states.length + 2; // header + N slices + blank
  let progressTimer: ReturnType<typeof setInterval> | null = null;

  function renderProgress(): void {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const lines: string[] = [];
    const running = states.filter((s) => s.status === 'running').length;
    const done = states.filter((s) => s.status === 'completed' || s.status === 'failed').length;
    lines.push(`  ⏱️  ${elapsed}s elapsed — ${running} running, ${done} done`);
    for (const st of states) {
      const icon = st.status === 'completed' ? '✅' : st.status === 'failed' ? '❌' : st.status === 'running' ? '🔄' : '⏳';
      // Use frozen elapsedSec for completed/failed slices, live calculation for running
      const elapsedStr = st.elapsedSec > 0 ? `${st.elapsedSec}s` : st.status !== 'admitted' ? `${Math.floor((Date.now() - startTime) / 1000)}s` : '—';
      const exitStr = st.exitCode !== null ? ` exit=${st.exitCode}` : '';
      lines.push(`    ${icon} ${st.id.padEnd(22)} ${elapsedStr.padEnd(6)}${exitStr}`);
    }
    // Move cursor up and rewrite
    process.stdout.write(`\x1b[${statusLineCount}A` + lines.join('\n') + '\n');

    // Stop timer when all slices are done
    if (done === states.length && progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  // Initial status
  {
    const lines: string[] = [];
    lines.push(`  ⏱️  0s elapsed — ${states.length} starting...`);
    for (const st of states) {
      lines.push(`    ⏳ ${st.id.padEnd(22)} —`);
    }
    console.log(lines.join('\n'));
  }

  // Start progress updates
  progressTimer = setInterval(renderProgress, 2000);

  // ── Phase 4: Wait for all to complete with per-slice retry ─────────
  const config = loadConfig();
  const maxRetries = config.agent.maxRetries ?? 2;

  const results = await Promise.allSettled(
    states.map(async (st, i) => {
      if (st.sessionId === null) return { ...st, exitCode: -1, status: 'failed' as const };

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const exitCode = await adapters[i].waitForExit(st.sessionId);
        st.exitCode = exitCode;
        st.elapsedSec = Math.floor((Date.now() - startTime) / 1000);

        if (exitCode === 0) {
          st.status = 'completed';
          return st;
        }

        // Failed — try auto-retry at CLI level
        if (attempt < maxRetries) {
          await events.append(st.id, 'run.aborted', 'zelto', { sliceId: st.id, exitCode });
          const result = await handleAgentFailure(st.id, exitCode, { maxRetries });
          if (result.action === 'retry') {
            // Re-create adapter and re-start agent
            const timeout = slices[i]?.agentTimeout;
            adapters[i] = createExecutorAdapter(adapterType, agentName, timeout);
            const bundlePath = join(ZELTO_DIR, `${st.id}-bundle.json`);
            try {
              const { sessionId } = await adapters[i].start({ sliceId: st.id, prompt: bundlePath });
              st.sessionId = sessionId;
              st.status = 'running';
              continue; // Retry
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`  ❌ ${st.id}: retry start failed: ${msg}`);
            }
          }
        }

        // Not retrying — final failure
        await events.append(st.id, 'run.aborted', 'zelto', { sliceId: st.id, exitCode });
        st.status = 'failed';
        return st;
      }

      st.status = 'failed';
      return st;
    }),
  );

  // Clear progress display
  if (progressTimer) {
    clearInterval(progressTimer);
  }
  process.stdout.write(`\x1b[${statusLineCount}A` + ' '.repeat(80) + '\n');

  // ── Phase 5: Process results with enhanced summary ────────────────
  console.log('');
  const completed: Array<{ id: string; elapsedSec: number }> = [];
  const stalled: Array<{ id: string; exitCode: number | null }> = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const st = result.value;
      if (st.exitCode === 0) {
        await store.transit(st.id, 'RUN_FINISH');
        await events.append(st.id, 'run.finished', 'zelto', { sliceId: st.id, exitCode: 0 });
        console.log(`✅ ${st.id}: completed (${st.elapsedSec}s)`);
        await autoGateAfterRun(st.id);
        completed.push({ id: st.id, elapsedSec: st.elapsedSec });
      } else {
        stalled.push({ id: st.id, exitCode: st.exitCode });
      }
    } else {
      // Promise rejected
      stalled.push({ id: states.find((s) => s.status === 'failed')?.id ?? 'unknown', exitCode: -1 });
    }
  }

  // Enhanced summary
  console.log('');
  console.log(`📊 Parallel run complete: ${completed.length} passed, ${stalled.length} stalled`);

  if (stalled.length > 0) {
    console.log('');
    console.log(`⚠️  Stalled slices (needs attention):`);
    for (const s of stalled) {
      console.log(`  ❌ ${s.id} — exit ${s.exitCode ?? 'signal'} (zelto resume ${s.id})`);
    }
  }

  if (completed.length > 0) {
    console.log('');
    console.log(`✅  Completed slices:`);
    for (const s of completed) {
      console.log(`  ✅ ${s.id} — gate passed, sign created (${s.elapsedSec}s)`);
    }
  }

  // Switch back to main after parallel run
  if (baseCommit) {
    try {
      execSync('git checkout main', { cwd: process.cwd(), timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      try {
        execSync('git checkout master', { cwd: process.cwd(), timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { /* ignore */ }
    }
  }

  return stalled.length > 0 ? 1 : 0;
}

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
    const msg = err instanceof Error ? err.message : String(err);
    // Budget check failure is non-fatal — proceed without enforcement
    return true;
  }
}

// ─── auto gate after run (shared helper) ─────────────────────────────────────

async function autoGateAfterRun(id: string): Promise<void> {
  const config = loadConfig();
  const gateConfig: GateConfig = {
    commands: config.gate.commands.map((c) => ({ name: c.name, run: c.run })),
    profiles: config.gate.profiles,
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
    if (!r.passed && r.stderr) {
      const stderrLines = r.stderr.split('\n').filter((l) => l.trim()).slice(0, 5);
      for (const line of stderrLines) {
        console.log(`       ${line.slice(0, 200)}`);
      }
    }
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

// ─── handle agent failure with auto-retry support ─────────────────────────

/**
 * Handle a failed agent execution. For auto-resolvable stalls (permission_prompt,
 * environment_failure, context_exhaustion), automatically retry up to maxRetries.
 * For non-auto-resolvable stalls, write stall info and return 'stall'.
 *
 * @returns 'retry' if auto-retry is happening, 'stall' if the slice should stall
 */
export async function handleAgentFailure(
  id: string,
  exitCode: number | null,
  options?: { maxRetries?: number },
): Promise<{ action: 'retry' | 'stall'; retryCount?: number }> {
  const stallClass = classifyStall({
    type: exitCode === null ? 'build_failure' : 'test_failure',
    message: `Agent exited with code ${exitCode ?? 'signal'}`,
    attempts: 1,
  });

  const maxRetries = options?.maxRetries ?? 2;

  // Check if this stall class is auto-resolvable
  if (isAutoResolvable(stallClass)) {
    try {
      const slice = await store.read(id);
      const currentRetries = slice.stall.autoResolved ?? 0;

      if (currentRetries < maxRetries) {
        // Auto-retry: increment counter, log, return retry signal
        slice.stall.autoResolved = currentRetries + 1;
        // Don't set stall.class — slice is not stalled, just retrying
        await store.write(slice);

        await events.append(id, 'stall.classified', 'zelto', {
          sliceId: id, class: stallClass, exitCode,
          runAborted: true, autoRetry: true,
          retryCount: currentRetries + 1, maxRetries,
        });

        console.log(`  🔄 Auto-retrying (${currentRetries + 1}/${maxRetries})...`);
        return { action: 'retry', retryCount: currentRetries + 1 };
      }

      // Max retries exhausted — fall through to stall
      console.log(`  ⚠️ Auto-retry exhausted (${maxRetries}/${maxRetries}) — stalling`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ⚠️ Could not check retry state: ${msg}`);
      // Fall through to stall
    }
  }

  // Non-auto-resolvable or retries exhausted: write stall info
  try {
    const slice = await store.read(id);
    slice.stall.class = stallClass;
    slice.stall.gateRetries = 0;
    await store.write(slice);

    await events.append(id, 'stall.classified', 'zelto', {
      sliceId: id, class: stallClass, exitCode, runAborted: true,
    });

    // Prominent stall notification
    const border = '═'.repeat(46);
    console.log(`\n  ╔${border}╗`);
    console.log(`  ║  ⚠️  SLICE STALLED: ${id.padEnd(28)}║`);
    console.log(`  ║  Class: ${stallClass.padEnd(36)}║`);
    console.log(`  ║  Action: zelto resume ${id.padEnd(22)}║`);
    console.log(`  ╚${border}╝\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ⚠️ Could not write stall info: ${msg}`);
  }

  return { action: 'stall' };
}

// ─── start ────────────────────────────────────────────────────────────────────

register('start', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto start <slice-id> [--title <title>] [--writes <path1,path2,...>] [--agent <name>] [--adapter <type>] [--yes]');
    return 1;
  }

  // Confirmation prompt (skip with --yes)
  if (!args.includes('--yes') && !args.includes('-y')) {
    const title = extractFlagValue(args, '--title') ?? id;
    console.log(`About to execute slice "${id}" ("${title}")`);
    console.log(`  This will: create → freeze → run an AI agent`);
    console.log(`  The agent may modify files and incur API costs.`);
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question('  Proceed? [y/N] ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('Cancelled.');
      return 0;
    }
  }

  const title = extractFlagValue(args, '--title') ?? id;

  const writesRaw = extractFlagValue(args, '--writes');
  const customWrites = writesRaw ? writesRaw.split(',').map((w: string) => w.trim()).filter(Boolean) : null;

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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ Freeze failed: ${msg}`);
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

    // Check agent availability before starting
    try {
      const { ClaudeAgentAdapter } = await import('../../adapters/claude-agent/index.js');
      const agentError = await ClaudeAgentAdapter.checkAgentAvailable(agentName);
      if (agentError) {
        console.error(`  ❌ ${agentError}`);
        return 1;
      }
    } catch {
      // skip check
    }

    const adapterType = args.includes('--adapter') ? args[args.indexOf('--adapter') + 1] : undefined;
    const sliceForTimeout = await store.read(id);
    let adapter = createExecutorAdapter(adapterType, agentName, sliceForTimeout.agentTimeout);
    let { sessionId } = await adapter.start({ sliceId: id, prompt: bundlePath });

    await events.append(id, 'run.started', 'zelto', {
      sliceId: id, agent: agentName, bundlePath, writes: bundle.writes,
    });

    // Show progress
    let startTime = Date.now();
    let progressTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      process.stdout.write(`\r  ⏱️  Agent running... ${mins}m ${secs}s`);
    }, 1000);

    // Retry loop
    const maxRetries = cfg.agent.maxRetries ?? 2;
    let finalExitCode: number | null = null;
    let attempt = 0;

    while (attempt <= maxRetries) {
      const exitCode = await adapter.waitForExit(sessionId);

      clearInterval(progressTimer);
      process.stdout.write('\r' + ' '.repeat(50) + '\r');

      if (exitCode === 0) {
        finalExitCode = 0;
        break;
      }

      // Failed — try auto-retry
      await events.append(id, 'run.aborted', 'zelto', { sliceId: id, exitCode });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`  ❌ Agent exited with code ${exitCode} (${elapsed}s)`);

      if (attempt < maxRetries) {
        const result = await handleAgentFailure(id, exitCode, { maxRetries });
        if (result.action === 'retry') {
          attempt = result.retryCount ?? attempt + 1;
          adapter = createExecutorAdapter(adapterType, agentName, sliceForTimeout.agentTimeout);
          const { sessionId: newSessionId } = await adapter.start({ sliceId: id, prompt: bundlePath });
          sessionId = newSessionId;
          progressTimer = setInterval(() => {
            const e = Math.floor((Date.now() - startTime) / 1000);
            const mins = Math.floor(e / 60);
            const secs = e % 60;
            process.stdout.write(`\r  ⏱️  Agent running... ${mins}m ${secs}s`);
          }, 1000);
          continue;
        }
      }

      await handleAgentFailure(id, exitCode, { maxRetries });
      finalExitCode = exitCode;
      break;
    }

    if (finalExitCode === 0) {
      await store.transit(id, 'RUN_FINISH');
      await events.append(id, 'run.finished', 'zelto', { sliceId: id, exitCode: 0 });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`  ✅ Agent completed successfully (${elapsed}s)`);

      // Auto-run gate and create sign request on pass
      await autoGateAfterRun(id);
    } else {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`  ❌ Slice "${id}" failed after ${attempt + 1} attempt(s) (${elapsed}s)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ Agent execution failed: ${msg}`);
    return 1;
  }

  return 0;
});

// ─── Background task tracking ────────────────────────────────────────────

interface TaskInfo {
  taskId: string;
  sliceId: string;
  sessionId: string;
  agentName: string;
  startedAt: string;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  completedAt?: string;
  exitCode?: number;
  elapsedSec?: number;
}

function tasksDir(): string {
  return join(ZELTO_DIR, 'tasks');
}

function taskPath(taskId: string): string {
  return join(tasksDir(), `${taskId}.json`);
}

async function saveTask(info: TaskInfo): Promise<void> {
  const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
  if (!existsSync(tasksDir())) mkdirSync(tasksDir(), { recursive: true });
  writeFileSync(taskPath(info.taskId), JSON.stringify(info, null, 2), 'utf-8');
}

async function loadTask(taskId: string): Promise<TaskInfo | null> {
  const { readFileSync, existsSync } = await import('node:fs');
  const p = taskPath(taskId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as TaskInfo;
  } catch {
    return null;
  }
}

/**
 * Monitor a background task and update its status.
 * Runs asynchronously (not awaited) to allow immediate CLI return.
 */
async function monitorTaskInBackground(
  taskId: string,
  sessionId: string,
  adapter: ReturnType<typeof createExecutorAdapter>,
  sliceId: string,
  startTime: number,
  isHotfix: boolean,
): Promise<void> {
  try {
    const exitCode = await adapter.waitForExit(sessionId);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const status = exitCode === 0 ? 'completed' : 'failed';

    // Update task file
    const task = await loadTask(taskId);
    if (task) {
      task.status = status;
      task.exitCode = exitCode ?? undefined;
      task.elapsedSec = elapsed;
      task.completedAt = new Date().toISOString();
      await saveTask(task);
    }

    // Process result as if foreground (state transition, gate, etc.)
    if (exitCode === 0) {
      await store.transit(sliceId, 'RUN_FINISH');
      await events.append(sliceId, 'run.finished', 'zelto', { sliceId, exitCode: 0 });
      if (isHotfix) {
        await store.transit(sliceId, 'GATE_PASS');
        await events.append(sliceId, 'slice.hotfix', 'zelto', {
          sliceId, elapsed, note: 'hotfix — gate skipped, auto-approved',
        });
        const signManager = new SignManager(ZELTO_DIR, events, store);
        const signReq = await signManager.request(sliceId, 'zelto');
        await signManager.approve(signReq.id, 'zelto');
      } else {
        await autoGateAfterRun(sliceId);
      }
    } else {
      await events.append(sliceId, 'run.aborted', 'zelto', { sliceId, exitCode });
      // Background tasks: write stall info without auto-retry (adapter already finished)
      const stallClass = classifyStall({
        type: exitCode === null ? 'build_failure' : 'test_failure',
        message: `Agent exited with code ${exitCode ?? 'signal'}`,
        attempts: 1,
      });
      try {
        const bgSlice = await store.read(sliceId);
        bgSlice.stall.class = stallClass;
        await store.write(bgSlice);
        await events.append(sliceId, 'stall.classified', 'zelto', {
          sliceId, class: stallClass, exitCode, runAborted: true,
        });
      } catch { /* non-fatal */ }
    }
  } catch {
    // Background monitor failure is non-fatal
    const task = await loadTask(taskId);
    if (task && task.status === 'running') {
      task.status = 'failed';
      await saveTask(task);
    }
  }
}

// ─── task: list background tasks ──────────────────────────────────────────

register('tasks', async (args) => {
  const { readdirSync, existsSync } = await import('node:fs');
  const dir = tasksDir();
  if (!existsSync(dir)) {
    console.log('No background tasks.');
    return 0;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No background tasks.');
    return 0;
  }

  console.log('Background tasks:');
  for (const file of files) {
    const task = await loadTask(file.slice(0, -5));
    if (!task) continue;
    const icon = task.status === 'completed' ? '✅' : task.status === 'running' ? '🔄' : '❌';
    const elapsed = task.elapsedSec ? `${task.elapsedSec}s` : '—';
    console.log(`  ${icon} ${task.taskId.padEnd(30)} ${task.status.padEnd(10)} ${elapsed}`);
  }
  return 0;
});

// ─── task-status: show task status ────────────────────────────────────

register('task-status', async (args) => {
  const [target] = args;
  if (!target) {
    // Show all tasks summary
    const { readdirSync, existsSync } = await import('node:fs');
    const dir = tasksDir();
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      const running = [];
      for (const file of files) {
        const t = await loadTask(file.slice(0, -5));
        if (t?.status === 'running') running.push(t);
      }
      if (running.length > 0) {
        console.log(`Running tasks (${running.length}):`);
        for (const task of running) {
          const elapsed = Math.floor((Date.now() - new Date(task.startedAt).getTime()) / 1000);
          console.log(`  🔄 ${task.taskId} — ${task.sliceId} (${elapsed}s)`);
        }
        return 0;
      }
    }
    console.log('No running background tasks.');
    return 0;
  }

  // Check if target is a task ID (starts with "task-")
  if (target.startsWith('task-')) {
    const task = await loadTask(target);
    if (!task) {
      console.error(`Task not found: ${target}`);
      return 1;
    }
    const icon = task.status === 'completed' ? '✅' : task.status === 'running' ? '🔄' : '❌';
    console.log(`  ${icon} ${task.taskId}`);
    console.log(`    Slice:    ${task.sliceId}`);
    console.log(`    Status:   ${task.status}`);
    console.log(`    Agent:    ${task.agentName}`);
    console.log(`    Session:  ${task.sessionId}`);
    if (task.elapsedSec) console.log(`    Elapsed:  ${task.elapsedSec}s`);
    if (task.exitCode !== undefined) console.log(`    Exit:     ${task.exitCode}`);
    return 0;
  }

  // Otherwise, show slice status via slice-status command
  const handler = (await import('./shared.js')).commands['slice-status'];
  if (handler) {
    return handler([target]);
  }
  console.error(`Unknown status target: ${target}`);
  return 1;
});

// ─── wait: block until task completes ─────────────────────────────────────

register('wait', async (args) => {
  const [taskId] = args;
  if (!taskId || !taskId.startsWith('task-')) {
    console.error('Usage: zelto wait <task-id>');
    console.error('  Get task ID from "zelto run --detach" or "zelto tasks"');
    return 1;
  }

  let task = await loadTask(taskId);
  if (!task) {
    console.error(`Task not found: ${taskId}`);
    return 1;
  }

  if (task.status !== 'running') {
    const icon = task.status === 'completed' ? '✅' : '❌';
    console.log(`${icon} Task ${taskId}: ${task.status}`);
    return task.status === 'completed' ? 0 : 1;
  }

  // Poll for completion
  const startTime = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    task = await loadTask(taskId);
    if (!task || task.status !== 'running') break;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  ⏱️  Waiting... ${elapsed}s`);
  }

  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  if (!task) {
    console.error(`Task lost: ${taskId}`);
    return 1;
  }

  const icon = task.status === 'completed' ? '✅' : '❌';
  console.log(`${icon} Task ${taskId}: ${task.status} (${task.elapsedSec ?? '?'}s)`);
  return task.status === 'completed' ? 0 : 1;
});
