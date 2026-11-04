// Core slice lifecycle commands: slices, create, check, clarify, abandon, freeze, run, admit

import { createInterface } from 'node:readline';
import { writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
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
import { listFilesUnder } from '../../core/sched/audit.js';
import type { SliceData } from '../../core/slice/store.js';
import { BudgetCollector } from '../../core/budget/collector.js';
import { GateExecutor } from '../../core/gate/executor.js';
import { SignManager } from '../../core/gate/sign.js';
import type { GateConfig } from '../../core/gate/types.js';
import { detectSliceType } from '../../core/gate/types.js';
import { classifyStall, isAutoResolvable } from '../../core/stall/classifier.js';
import { type WorktreeInfo } from '../../core/worktree/index.js';
import { parseScopePaths } from '../../core/spec/scope.js';
import { register } from './shared.js';
import { store, events, ZELTO_DIR, loadPolicyConfig, hashSpecFile, loadConfig, createLlmFromConfig, createExecutorAdapter, worktreeManager, ensureWorktree, removeWorktree } from './shared.js';
import { generateClarifyQuestions } from '../../llm/generators/clarify.js';
import { detectQuestion, suspendSliceForQuestion } from './question.js';
import { resolveWriteSet, checkBudget, autoGateAfterRun, handleAgentFailure, detectDefaultWrites } from './run-support.js';
import {
  type RuntimeGuard,
  enforceWriteSet,
  installRuntimeGuard,
  releaseGuards,
} from './runtime-guard.js';

// 供其它命令复用（ai-pipeline.ts / question.ts）
export { autoGateAfterRun, handleAgentFailure } from './run-support.js';

// ─── Write-set resolution ──────────────────────────────────────────────────────
//
// resolveWriteSet / checkBudget / autoGateAfterRun / handleAgentFailure 已经移到
// ./run-support.ts — 并行执行器也要用它们，独立出来可以避免两个模块互相 import。

// ─── Worktree helpers ─────────────────────────────────────────────────────────

// `ensureWorktree` / `worktreeManager` / `removeWorktree` live in ./shared.ts so that
// gate, diff and sign commands can reuse the same worktree convention.

/**
 * zelto 自己写进 worktree 的文件（相对 worktree 的路径）。
 *
 * 规格副本、验收目录副本、约束包镜像 —— 这些是 zelto 放进去的，不是 agent 写的。
 * 审计时它们不能算成「agent 越界写入」（否则每次运行都会被自己的文件拦下）；
 * 但内容被改动就是篡改：改了规格副本等于自动改规格（AGENTS.md 禁区）。
 */
function zeltoOwnedPaths(worktreePath: string | null, slice: SliceData): string[] {
  if (!worktreePath) return [];

  const paths: string[] = [];
  if (slice.spec.path) paths.push(slice.spec.path);
  if (slice.acceptance.dir) {
    paths.push(...listFilesUnder(worktreePath, slice.acceptance.dir));
  }
  paths.push(join(ZELTO_DIR, `${slice.id}-bundle.json`));
  return paths;
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

  // Interactive mode: prompt for values if not provided.
  // Only when stdin is a TTY — in scripts/CI there is nobody to answer, and
  // waiting for input would hang forever.
  if ((!id || id.startsWith('--')) && process.stdin.isTTY) {
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
      console.log('  Result:  ??  Fix issues before gate');
    } else {
      console.log(`  Issues:  ${issues.join(', ')}`);
      console.log('  Result:  ??  Fix issues before freezing');
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

    // Remove the isolated worktree (if any) — failures are reported, not swallowed
    if (worktreeManager().exists(id)) {
      try {
        await removeWorktree(id, { force: true });
        console.log(`  Worktree:   removed (${worktreeManager().relativePathFor(id)})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ??  Worktree removal failed: ${msg}`);
        console.error(`     Remove it manually: git worktree remove --force ${worktreeManager().pathFor(id)}`);
      }
    }

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

  // 运行时守卫（C9）：预约 + 钩子。离开这个命令时必须释放 ——
  // 除非是 detach 模式，那时由后台监视器接管。
  let guard: RuntimeGuard | null = null;
  let guardTransferred = false;

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

    // Resolve write-set: slice.writes → spec 「范围」 → detectDefaultWrites()
    const resolved = await resolveWriteSet(id);
    if (resolved.changed) {
      console.log(
        resolved.source === 'spec'
          ? `  Write-set (from spec):  ${resolved.writes.join(', ')}`
          : `  Auto-detected write-set: ${resolved.writes.join(', ')}`,
      );
    }
    if (resolved.writes.length === 0) {
        console.warn('  ⚠️  No write-set detected — agent will have no files to modify');
    }

    // Re-read so the constraint bundle carries the resolved write-set
    const slice = await store.read(id);

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

    // Isolated worktree for this slice — the main working tree is never touched.
    // Not inside a git repo → no isolation possible, degrade to the current directory.
    let worktree: WorktreeInfo | null = null;
    try {
      worktree = await ensureWorktree(id);
      if (worktree) {
        console.log(`  Worktree:      ${worktree.relativePath}`);
        console.log(`  Branch:        ${worktree.branch}`);

        // Mirror the bundle into the worktree so the agent sees it under its own cwd
        const wtBundleDir = join(worktree.path, ZELTO_DIR);
        if (!existsSync(wtBundleDir)) mkdirSync(wtBundleDir, { recursive: true });
        writeFileSync(join(wtBundleDir, `${id}-bundle.json`), JSON.stringify(bundle, null, 2), 'utf-8');
      } else {
        console.log(`  Worktree:      (none — not a git repository, running in current directory)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ 无法创建隔离 worktree: ${msg}`);
      return 1;
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
    const workDir = worktree?.path ?? process.cwd();

    // 运行时守卫（C9）：取写集预约 + 装 PreToolUse 钩子。
    // 钩子装在 agent 真正工作的那个目录里 —— Claude Code 只读 cwd 下的
    // .claude/settings.local.json；预约与策略仍在主仓库（命令行里给了 --project-root）。
    let activeGuard: RuntimeGuard;
    try {
      activeGuard = await installRuntimeGuard({
        sliceId: id,
        writes: bundle.writes,
        worktree: worktree?.path ?? null,
        projectRoot: process.cwd(),
        baseCommit: worktree?.baseCommit ?? null,
        managedPaths: zeltoOwnedPaths(worktree?.path ?? null, slice),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ 无法取得写集预约: ${msg}`);
      return 1;
    }
    guard = activeGuard;
    console.log(`  Reservation:   ${bundle.writes.join(', ') || '(空)'}`);

    let adapter = createExecutorAdapter(adapterType, agentName, agentTimeout, workDir);
    let { sessionId } = await adapter.start({ sliceId: id, prompt: bundlePath });

    await events.append(id, 'run.started', 'zelto', {
      sliceId: id, agent: agentName, bundlePath, writes: bundle.writes,
      worktree: worktree?.relativePath ?? null,
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
      guardTransferred = true;
      monitorTaskInBackground(taskId, sessionId, adapter, id, startTime, isHotfix, activeGuard);
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
      process.stdout.write(`\r  ??  Agent running... ${mins}m ${secs}s`);
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
          adapter = createExecutorAdapter(adapterType, agentName, agentTimeout, workDir);
          const { sessionId: newSessionId } = await adapter.start({
            sliceId: id, prompt: bundlePath,
          });
          sessionId = newSessionId;

          // Restart progress display
          progressTimer = setInterval(() => {
            const e = Math.floor((Date.now() - startTime) / 1000);
            const mins = Math.floor(e / 60);
            const secs = e % 60;
            process.stdout.write(`\r  ??  Agent running... ${mins}m ${secs}s`);
          }, 1000);

          continue; // Retry
        }
      }

      // Not retrying — write stall and stop
      await handleAgentFailure(id, exitCode, { maxRetries });
      finalExitCode = exitCode;
      break;
    }

    // 写集审计（ADR-014 §5）：agent 跑完了，拿 git 的真实改动再对一次写集。
    // 静态分析拦不住的写（`node -e "fs.writeFileSync(...)"` 之类）到这里兜住。
    const withinBounds = await enforceWriteSet(id, activeGuard);

    if (finalExitCode === 0) {
      // 提问回路：agent 以问题收尾时，不算「运行成功」——挂起切片等人回答
      // （ADR-013 §3.6）。检测是确定性字符串解析，不调用模型。
      const question = await detectQuestion(id, adapter, sessionId);
      if (question) {
        await suspendSliceForQuestion(id, question);
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        console.log(`\n❓ Agent asked a question (${question.type}) after ${elapsed}s:`);
        console.log(`   ${question.question}`);
        if (question.options.length > 0) {
          console.log(`   Options: ${question.options.join(' | ')}`);
        }
        console.log(`   Slice "${id}" is suspended — answer with:`);
        console.log(`   zelto answer ${question.id} "<your answer>"`);
        return 0;
      }

      if (!withinBounds) {
        // 越界：不进 gate、不自动签字 —— 等人处理
        console.log(`\n❌ Slice "${id}" 写集越界 —— 未进入 gate，等人处理。`);
        return 1;
      }

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
        console.log(`  ?? Hotfix: gate skipped, auto-approved (${signReq.id})`);
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
  } finally {
    // 释放写集预约 + 撤掉钩子。detach 模式下预约交给后台监视器，这里不动。
    if (guard && !guardTransferred) {
      await guard.release();
    }
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
  /** Isolated worktree path for this slice */
  worktreePath: string | null;
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
    worktreePath: null,
  }));

  console.log(`zelto run --parallel — admitting ${ids.length} slices...`);

  for (const st of states) {
    const result = await scheduler.admit(st.id);
    if (result.decision !== 'admitted') {
      console.error(`  ❌ ${st.id}: ${result.reason}`);
      return 1;
    }
  }

  // Resolve write-sets first — conflict detection depends on the effective write-set
  for (const id of ids) {
    const resolved = await resolveWriteSet(id);
    if (resolved.changed) {
      console.log(
        resolved.source === 'spec'
          ? `  ??  ${id}: write-set from spec: ${resolved.writes.join(', ')}`
          : `  ??  ${id}: auto-detected write-set: ${resolved.writes.join(', ')}`,
      );
    }
  }

  // Read all slice data (after write-set resolution so conflicts use effective writes)
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

  // Check budgets
  for (const id of ids) {
    const ok = await checkBudget(id);
    if (!ok) {
      console.error(`  ❌ ${id}: budget exhausted`);
      return 1;
    }
  }

  // ── Phase 2: Create isolated worktrees & start agents ───────────
  const { execSync } = await import('node:child_process');
  const agentName = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : loadConfig().agent.command;
  const adapterType = args.includes('--adapter') ? args[args.indexOf('--adapter') + 1] : undefined;

  // 每个切片一份运行时守卫（C9）：写集预约 + PreToolUse 钩子
  const guards = new Map<string, RuntimeGuard>();

  // Check for uncommitted changes in the main worktree
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (status) {
      console.warn(`  ??  You have uncommitted changes in the main worktree. They are NOT copied into slice worktrees.`);
      console.warn(`       Commit them first if the slices depend on them.`);
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

    // Create isolated worktree — the main worktree keeps its current branch.
    // Not inside a git repo → no isolation possible, degrade to the current directory.
    let baseCommit: string | null = null;
    try {
      const wt = await ensureWorktree(st.id);
      if (wt) {
        st.worktreePath = wt.path;
        baseCommit = wt.baseCommit;
        const wtBundleDir = join(wt.path, ZELTO_DIR);
        if (!existsSync(wtBundleDir)) mkdirSync(wtBundleDir, { recursive: true });
        writeFileSync(join(wtBundleDir, `${st.id}-bundle.json`), JSON.stringify(bundle, null, 2), 'utf-8');
      } else {
        console.warn(`  ⚠️  ${st.id}: 不在 git 仓库中，无法隔离 worktree，将在当前目录执行`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${st.id}: 无法创建隔离 worktree: ${msg}`);
      await releaseGuards(guards);
      return 1;
    }

    // 写集预约 + PreToolUse 钩子（C9）
    try {
      const g = await installRuntimeGuard({
        sliceId: st.id,
        writes: bundle.writes,
        worktree: st.worktreePath,
        projectRoot: process.cwd(),
        baseCommit,
        managedPaths: zeltoOwnedPaths(st.worktreePath, slice),
      });
      guards.set(st.id, g);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${st.id}: 无法取得写集预约: ${msg}`);
      await releaseGuards(guards);
      return 1;
    }

    // Write event
    await events.append(st.id, 'run.started', 'zelto', {
      sliceId: st.id, agent: agentName, bundlePath, writes: slice.writes,
      worktree: st.worktreePath ? worktreeManager().relativePathFor(st.id) : null,
    });
  }

  // Start all agent sessions — each with its own timeout from slice config
  const adapters = states.map((st, i) => {
    const timeout = slices[i]?.agentTimeout;
    return createExecutorAdapter(adapterType, agentName, timeout, st.worktreePath ?? process.cwd());
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
            adapters[i] = createExecutorAdapter(
              adapterType,
              agentName,
              timeout,
              st.worktreePath ?? process.cwd(),
            );
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
  const asked: Array<{ id: string; questionId: string; question: string }> = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const st = result.value;
      if (st.exitCode === 0) {
        // 提问回路：某个切片以问题收尾 → 只挂起该切片，批次里其它切片不受影响
        // （ADR-013 §3.5）
        const idx = states.findIndex((s) => s.id === st.id);
        const adapter = idx >= 0 ? adapters[idx] : undefined;
        const sessionId = st.sessionId;
        const question = adapter && sessionId
          ? await detectQuestion(st.id, adapter, sessionId)
          : null;

        if (question) {
          await suspendSliceForQuestion(st.id, question);
          console.log(`❓ ${st.id}: asked a question (${question.type}) — suspended`);
          console.log(`   ${question.question}`);
          console.log(`   Answer with: zelto answer ${question.id} "<your answer>"`);
          asked.push({ id: st.id, questionId: question.id, question: question.question });
          continue;
        }

        // 写集审计（ADR-014 §5）—— 越界就不进 gate
        const withinBounds = await enforceWriteSet(st.id, guards.get(st.id) ?? null);
        if (!withinBounds) {
          console.log(`❌ ${st.id}: 写集越界 — 未进入 gate，等人处理`);
          await events.append(st.id, 'run.aborted', 'zelto', {
            sliceId: st.id, exitCode: 0, reason: 'write-set violation',
          });
          stalled.push({ id: st.id, exitCode: 0 });
          continue;
        }

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
  console.log(`?? Parallel run complete: ${completed.length} passed, ${stalled.length} stalled, ${asked.length} awaiting answer`);

  if (asked.length > 0) {
    console.log('');
    console.log(`❓ Slices waiting for an answer:`);
    for (const a of asked) {
      console.log(`  ❓ ${a.id} — ${a.question}`);
      console.log(`     zelto answer ${a.questionId} "<your answer>"`);
    }
  }

  if (stalled.length > 0) {
    console.log('');
    console.log(`??  Stalled slices (needs attention):`);
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

  // Note: the main worktree's branch is never switched — each slice runs in its own
  // worktree, so there is nothing to switch back to.

  await releaseGuards(guards);

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

// ─── start ────────────────────────────────────────────────────────────────────

register('start', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto start <slice-id> [--title <title>] [--writes <path1,path2,...>] [--agent <name>] [--adapter <type>] [--yes]');
    return 1;
  }

  // Confirmation prompt (skip with --yes, or when stdin is not a TTY).
  // Non-TTY means the command was invoked from a script/CI — there is nobody
  // to answer the prompt, so waiting for input would hang forever.
  if (!args.includes('--yes') && !args.includes('-y') && process.stdin.isTTY) {
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
    console.log(`  ??  Already exists: ${id}`);
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
      console.log(`  ??  Already frozen: ${id} (state=${current.state})`);
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
      process.stdout.write(`\r  ??  Agent running... ${mins}m ${secs}s`);
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
            process.stdout.write(`\r  ??  Agent running... ${mins}m ${secs}s`);
          }, 1000);
          continue;
        }
      }

      await handleAgentFailure(id, exitCode, { maxRetries });
      finalExitCode = exitCode;
      break;
    }

    if (finalExitCode === 0) {
      // 提问回路：agent 以问题收尾 → 挂起切片，不跑门禁（ADR-013 §3.6）
      const question = await detectQuestion(id, adapter, sessionId);
      if (question) {
        await suspendSliceForQuestion(id, question);
        console.log(`\n  ❓ Agent asked a question (${question.type}):`);
        console.log(`     ${question.question}`);
        console.log(`  Answer with: zelto answer ${question.id} "<your answer>"`);
        return 0;
      }

      await store.transit(id, 'RUN_FINISH');
      await events.append(id, 'run.finished', 'zelto', { sliceId: id, exitCode: 0 });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`✅ Agent completed successfully (${elapsed}s)`);

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
  guard?: RuntimeGuard,
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

    // 写集审计（ADR-014 §5）
    const withinBounds = await enforceWriteSet(sliceId, guard ?? null);

    // Process result as if foreground (state transition, gate, etc.)
    if (exitCode === 0 && withinBounds) {
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
    } else if (exitCode === 0) {
      // 越界：不进 gate、不自动签字 —— 等人处理
      console.error(`\n❌ Slice "${sliceId}" 写集越界 —— 未进入 gate，等人处理。`);
      await events.append(sliceId, 'run.aborted', 'zelto', {
        sliceId, exitCode: 0, reason: 'write-set violation',
      });
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
  } finally {
    // 后台任务结束 —— 预约与钩子在这里收尾
    if (guard) await guard.release();
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
    process.stdout.write(`\r  ??  Waiting... ${elapsed}s`);
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
