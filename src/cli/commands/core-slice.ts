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

/**
 * Extract every occurrence of a repeatable flag.
 * Each occurrence takes exactly one value (the next argument).
 * E.g. extractFlagValues(['--requirement', 'R1', '--requirement', 'R2'], '--requirement')
 * → ['R1', 'R2']
 *
 * 为什么需要它：需求追溯引用可以有多条（一片往往追溯到多条需求），
 * 而 extractFlagValue 会把多条值拼成一个字符串——追溯引用要能一条一条列出来。
 */
function extractFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) continue;
    const trimmed = value.trim();
    if (trimmed) values.push(trimmed);
  }
  return values;
}
import { ClarifyEngine, type LlmQuestionGenerator } from '../../core/clarify/engine.js';
import { Scheduler } from '../../core/sched/engine.js';
import type { SliceData } from '../../core/slice/store.js';
import { GateExecutor } from '../../core/gate/executor.js';
import { SignManager } from '../../core/gate/sign.js';
import type { GateConfig } from '../../core/gate/types.js';
import { detectSliceType } from '../../core/gate/types.js';
import { classifyStall, isAutoResolvable } from '../../core/stall/classifier.js';
import { type WorktreeInfo } from '../../core/worktree/index.js';
import { parseScopePaths } from '../../core/spec/scope.js';
import { evaluateWriteSet } from '../../core/spec/write-set.js';
import { judgeTrace, traceCountsOf, blockingViolations, advisoryViolations } from '../../core/trace/index.js';
import { validateDeterministic } from '../../core/spec/deterministic/validator.js';
import { analyzeSemantic } from '../../core/spec/semantic/analyzer.js';
import { materializeRequirements, evaluateFreezeTrace } from '../../core/spec/trace-extract.js';
import { register } from './shared.js';
import { store, events, ZELTO_DIR, loadPolicyConfig, hashSpecFile, loadConfig, createLlmFromConfig, createExecutorAdapter, worktreeManager, ensureWorktree, removeWorktree } from './shared.js';
import { executeSlicesByPhase, printParallelSummary, zeltoOwnedPaths } from './parallel-executor.js';
import { buildExecutionPlan, printExecutionPlan } from './execution-plan.js';
import { generateClarifyQuestions } from '../../llm/generators/clarify.js';
import { detectQuestion, suspendSliceForQuestion } from './question.js';
import {
  agentFailedMessage,
  budgetExhaustedMessage,
  printOutcome,
  writeSetOutcomeLines,
} from './run-messages.js';
import { resolveWriteSet, checkBudget, autoGateAfterRun, handleAgentFailure, detectDefaultWrites, settleRunCost, gateCommandsForSlice, markSliceStalled } from './run-support.js';
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
 *
 * 实现在 ./parallel-executor.ts —— 单切片运行与并行执行器共用同一份定义。
 */

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
    console.error('Usage: zelto create <slice-id> [--title <title>] [--writes <path1,path2,...>] [--requirement <ref>]... [--from-spec]');
    console.error('');
    console.error('  --from-spec    Parse spec markdown (specs/slices/<id>.md) to auto-populate');
    console.error('                 writes, requirements, baseline, and acceptance test fields.');
    console.error('                 Also detects v0- prefix as baseline slice.');
    console.error('  --requirement  Declare a requirement reference (repeatable). Required unless the');
    console.error('                 spec has acceptance criteria — the freeze gate refuses slices');
    console.error('                 with no traceable origin (ADR-032).');
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
  // 需求追溯引用（人批准的出处）：可以给多条。
  // 没有规格可解析时，这是人唯一能声明「这段代码为什么存在」的入口（ADR-032 §3.3）。
  const declaredRequirements = extractFlagValues(args, '--requirement');

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
    return await createSliceFromSpec(id, title, writes, isJson, declaredRequirements);
  }

  const slice = store.create(id, title, {
    writes,
    trace: { requirements: declaredRequirements, contracts: [], tests: [] },
  });
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
  console.log(`  Reqs:   ${declaredRequirements.length > 0 ? declaredRequirements.join('; ') : '(none — 没有规格章节可物化，冻结准入会拦住它)'}`);
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
  declaredRequirements: string[] = [],
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

  // 已声明的需求追溯优先于从规格里读出来的（ADR-032 §3.1：声明优先，规格是兜底）
  const finalRequirements = declaredRequirements.length > 0 ? declaredRequirements : requirements;

  const slice = store.create(id, parsedTitle, {
    writes: finalWrites,
    type: sliceType,
    trace: { requirements: finalRequirements, contracts: [], tests: acceptanceTests },
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
  console.log(`  Reqs:     ${finalRequirements.length} ${declaredRequirements.length > 0 ? 'declared' : 'parsed from spec'}`);
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

    // 追溯判据要与 `freeze` 同源（ADR-032 §3.3）。
    // freeze 会先从规格的「验收标准」/「需求」物化需求追溯再判定；check 若
    // 直接拿未物化的 slice.trace 判，就会报出 freeze 根本不拦的假阻断
    // （规格里明明写了编号验收标准，check 仍说「No requirements traced」）。
    let specContent = '';
    try {
      specContent = await readFile(slice.spec.path, 'utf-8');
    } catch {
      specContent = '';
    }
    const freezeGate = evaluateFreezeTrace(slice, specContent);

    console.log(`  Traces:  ${freezeGate.requirements.length} reqs, ${slice.trace.contracts.length} contracts${waiverNote}, ${slice.trace.tests.length} tests`);
    if (freezeGate.requirements.length > slice.trace.requirements.length) {
      console.log(`          (${freezeGate.requirements.length} reqs materialized from spec — written on freeze)`);
    }

    const issues: string[] = [];
    const advisories: string[] = [];
    // 追溯判据唯一真源：core/trace/judgment.ts —— 这里只做呈现翻译
    // 阻断项（blocking）决定退出码；提示项（advisory）只提示，不阻断（ADR-032 §3.2）
    const traceJudgment = judgeTrace({
      trace: traceCountsOf({ ...slice.trace, requirements: freezeGate.requirements }),
      waiver: slice.traceWaiver,
    });
    for (const v of freezeGate.blocking) issues.push(v.short);
    for (const v of advisoryViolations(traceJudgment)) advisories.push(v.short);
    if (slice.drift.detected) issues.push(`Drift detected: ${slice.drift.reason}`);

    // 写集判定（ADR-042 §3.1）：
    //   - 写集写进保护域 / 逃出项目根 → 阻断（跑之前就注定跑不起来）
    //   - 写集路径还不存在 → 提示（那是 agent 要**新建**的文件，
    //     不是错误；原来这里直接阻断，导致「新建文件型切片」永远过不了门禁①）
    if (slice.writes.length > 0) {
      const writeSetResult = evaluateWriteSet({
        writes: slice.writes,
        projectRoot: process.cwd(),
      });
      for (const issue of writeSetResult.issues) issues.push(issue);
      for (const advisory of writeSetResult.advisories) advisories.push(advisory);
      if (writeSetResult.toCreate.length > 0) {
        console.log(
          `  New files: ${writeSetResult.toCreate.length} path(s) will be created by the agent`,
        );
      }
    }

    // Validate acceptance test path exists
    // 提示级而不是阻断级：验收测试跑不跑得通是门禁②的事（ADR-032 §3.2），
    // 门禁①只管「追溯到没追溯」与「规格写没写清楚」。
    if (slice.acceptance.dir && !slice.acceptance.dir.includes('*') && slice.state !== 'draft') {
      const acceptPath = slice.acceptance.dir.endsWith('/')
        ? slice.acceptance.dir.slice(0, -1)
        : slice.acceptance.dir;
      if (!existsSync(acceptPath) && !existsSync(`${acceptPath}.test.ts`)) {
        advisories.push(`Acceptance test path not found: ${slice.acceptance.dir}`);
      }
    }

    // 规格引擎接线（ADR-032 §3.4）：
    //   - 确定性判据（validateDeterministic）：error 阻断、warning 提示
    //   - 语义启发式（analyzeSemantic）：只提示、不阻断（C7：语义分析不参与判定）
    // 「追溯」与「哈希」两类由上面的追溯判定与哈希比对负责，这里跳过避免重复报。
    // specContent 已在上面读过（追溯物化要用它）。
    if (specContent) {
      for (const issue of validateDeterministic(slice, specContent).issues) {
        if (issue.category === 'trace' || issue.category === 'hash') continue;
        const line = `${issue.message} — ${issue.suggestion ?? ''}`.trim();
        if (issue.severity === 'error') issues.push(line);
        else advisories.push(line);
      }
      for (const issue of analyzeSemantic(slice, specContent).issues) {
        advisories.push(`${issue.message} — ${issue.suggestion ?? ''}`.trim());
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
        issues, traces: slice.trace, advisories,
      }));
      return issues.length === 0 ? 0 : 1;
    }

    for (const a of advisories) {
      console.log(`  Warn:    ${a}`);
    }

    if (issues.length === 0) {
      console.log('  Result:  ✅ All checks passed');
    } else if (slice.state === 'frozen') {
      console.log(`  Issues:  ${issues.join(', ')}`);
      console.log('  Result:  ❌ Fix issues before gate');
    } else {
      console.log(`  Issues:  ${issues.join(', ')}`);
      console.log('  Result:  ❌ Fix issues before freezing');
    }
    // 门禁①的退出码：有问题 = 1（ADR-032 §3.2）。
    // 文本模式以前永远返回 0，脚本与 hook 串不起来——那是 bug，不是语义。
    return issues.length === 0 ? 0 : 1;
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
    // 澄清轮次（ADR-041 §3.1）：轮次号会进澄清问题 ID（`<slice>-<category>-<round>`），
    // 必须单调递增。之前这里读的是 `runs.length` —— 那是「跑过几次」，
    // 和澄清轮次根本不是一回事，于是轮次永远停在第 1 轮，
    // 人澄清了三轮，zelto 还在问第一轮的问题。
    const round = isDryRun
      ? (current.clarifyRounds ?? 0) + 1
      : await store.nextClarifyRound(id);
    // 记住新轮次：下面的 `store.write(current)` 会把整份快照写回去，
    // 不带上这个值就等于把刚记上的轮次抹掉。
    current.clarifyRounds = round;

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
    console.error('Usage: zelto freeze <slice-id> [--refreeze]');
    return 1;
  }

  const isJson = args.includes('--json');
  // --refreeze：允许对已冻结的切片重新冻结。
  //
  // 为什么需要：规格冻结之后人可能还要改它——最常见的是**写集越界之后
  // 扩写集**（写集写在规格的「范围」章节里，改规格 = 改哈希）。
  // 没有这条路径，那个切片就永久卡住：check 报 hash mismatch，
  // freeze 又说「已经是 frozen，不能 freeze」。
  const isRefreeze = args.includes('--refreeze');

  try {
    // `let` 而非 `const`：--refreeze 分支会把 slice 换成刷新后的对象
    // （transit 会覆写盘上的状态，局部变量必须跟着换）。
    let slice = await store.read(id);
    if (slice.state !== 'draft' && slice.state !== 'clarifying') {
      // 只有 frozen 能重新冻结。running / completed / abandoned 的规格
      // 变了要另走流程 —— 那些状态里可能已经有 agent 的产物了。
      const canRefreeze = isRefreeze && slice.state === 'frozen';
      if (!canRefreeze) {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, success: false, error: `Cannot freeze slice in state "${slice.state}"` }));
        } else {
          console.error(`Slice "${id}" is in state "${slice.state}", cannot freeze.`);
          if (slice.state === 'frozen') {
            console.error(`        规格已改？用 zelto freeze ${id} --refreeze 重新冻结。`);
          }
        }
        return 1;
      }

      // 重新冻结 = 人确认了新规格。退回 draft 让 FREEZE 转换合法可用。
      //
      // 顺序要紧：`store.transit` 会重新读盘并整份覆写，所以字段修改
      // 必须在 transit **之后**再做（否则刚改的字段会被冲掉）。
      await store.transit(id, 'REFREEZE');

      const refreshed = await store.read(id);
      refreshed.spec.frozenHash = null;
      refreshed.spec.frozenAt = null;
      // 追溯重新物化：规格改了，需求条目也可能变了
      refreshed.trace.requirements = [];
      await store.write(refreshed);
      // 后面的追溯物化与 FREEZE 转换都基于这个对象继续 —— 不换掉的话
      // 局部变量还停在旧状态（frozen），FREEZE 转换会直接抛 Invalid transition。
      slice = refreshed;

      // 事件留痕：规格变更是人做的，必须能在事件流里看到（C4）。
      await events.append(id, 'slice.state.changed', 'cli', {
        sliceId: id, from: 'frozen', to: 'draft', event: 'REFREEZE',
      });
      console.log(`  ↻ 重新冻结：${id} 已退回 draft（规格哈希已重置，追溯待重新物化）`);
    }

    // 追溯物化 + 准入闸门（ADR-032 §3.1 / §3.3）：
    //   人显式声明过的追溯优先；没声明时，从规格正文的「验收标准」物化——
    //   那份验收标准就是人批准的出处（`zelto create --from-spec` 早就在这么用）。
    //   物化只读规格、不改规格，也不替人写需求。
    //   需求追溯为空 = 没有出处 → 拒绝冻结；契约 / 测试缺失只提示，不阻断。
    let specContent = '';
    try {
      specContent = await readFile(slice.spec.path, 'utf-8');
    } catch {
      specContent = '';
    }
    const gate = evaluateFreezeTrace(slice, specContent);
    const materialized = gate.requirements.length !== slice.trace.requirements.length;
    if (materialized) {
      slice.trace.requirements = gate.requirements;
      await store.write(slice);
    }

    if (gate.blocking.length > 0) {
      const details = gate.blocking.map((v) => v.message);
      await events.append(id, 'spec.checked', 'cli', {
        sliceId: id, issues: gate.blocking.length, passed: false, details, phase: 'freeze',
      });
      const advice = [
        `  在规格里写「## 验收标准」（编号条目）→ zelto 会自动物化成需求追溯`,
        `  或显式声明需求追溯： zelto set ${id} --field trace.requirements --value "<需求引用>"`,
        `  或写明豁免理由： zelto set ${id} --field traceWaiver --value "<理由>"`,
      ].join('\n');
      if (isJson) {
        console.log(JSON.stringify({
          sliceId: id, success: false,
          error: `追溯不合格，拒绝冻结：${details.join('；')}`,
          issues: gate.blocking.map((v) => v.short),
        }));
      } else {
        console.error(`zelto freeze ${id} — ❌ 追溯不合格，拒绝冻结`);
        for (const d of details) console.error(`  - ${d}`);
        console.error(advice);
      }
      return 1;
    }

    // 物化追溯也是一次状态变更（C4）：留痕挂在同一次冻结动作的事件上——
    // 单独再写一条 spec.checked 会让「本片 check 过几次」这种统计失真。
    const specHash = hashSpecFile(slice.spec.path);
    slice.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    await store.transit(id, 'FREEZE');
    await events.append(id, 'spec.frozen', 'cli', {
      sliceId: id, frozenHash: slice.spec.frozenHash, frozenAt: slice.spec.frozenAt,
      materializedRequirements: gate.requirements.length,
      traceSource: materialized ? 'spec' : 'declared',
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

  // hotfix 跳过门禁② —— 等于放弃「签字前必须过门禁」这条约束。
  // 所以必须显式确认（ADR-015 §3.1）：--hotfix 必须配 --yes。
  if (isHotfix && !args.includes('--yes') && !args.includes('-y')) {
    if (isJson) {
      console.log(JSON.stringify({
        sliceId: id,
        error: 'hotfix requires --yes',
        message: 'zelto run <slice-id> --hotfix --yes',
      }));
    } else {
      console.error('zelto run --hotfix 会跳过门禁②（验收测试），并把切片直接置为已签字。');
      console.error('        这等于放弃「签字前必须过门禁」这条约束，所以必须显式确认：');
      console.error('        zelto run <slice-id> --hotfix --yes');
    }
    return 1;
  }

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
    // `checkBudget` 内部已经打印统一措辞（并写 stall.classified 事件）
    const budgetOk = await checkBudget(id);
    if (!budgetOk) {
      return 1;
    }

    const isDryRun = args.includes('--dry-run');

    if (isDryRun) {
      const bundle = scheduler.buildConstraints(slice, null, gateCommandsForSlice(slice.writes));
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

    const bundle = scheduler.buildConstraints(slice, null, gateCommandsForSlice(slice.writes));
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

      // 停机只做一次：`handleAgentFailure` 返回 'stall' 时它已经把切片
      // 停机了（退 frozen + 写分类 + 留痕，ADR-047）—— 不要再调一遍，
      // 否则会写两遍事件、迁两次状态。
      let stalled = false;
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
        stalled = true;
      }

      // Not retrying — write stall and stop
      if (!stalled) {
        await handleAgentFailure(id, exitCode, { maxRetries });
      }
      finalExitCode = exitCode;
      break;
    }

    // 记账（ADR-041 §3.1）：一次 agent 运行 = 一条运行记录。
    // 记在写集审计之前 —— 审计只判「有没有越界」，不改变「agent 跑没跑完」这个事实。
    await store.recordRun(id, { ok: finalExitCode === 0, exitCode: finalExitCode });

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

      if (!withinBounds.ok) {
        // 越界：不进 gate、不自动签字 —— 等人处理。
        // `enforceWriteSet` 已经把切片退回 frozen（可重跑）并写了 run.aborted 事件。
        //
        // 审计失败与越界分开说 —— 前者是「边界未知」，下一步是修环境；
        // 后者是「越界已证实」，下一步是扩写集。混着说会让人白跑一轮。
        console.log('');
        printOutcome(writeSetOutcomeLines({ sliceId: id }, withinBounds));
        return 1;
      }

      await store.transit(id, 'RUN_FINISH');
      // 花费结算（ADR-035）：先记账，再复判预算。
      // 超预算的切片**不进 gate、不发签字请求** —— 现场交回给人（与 ADR-020 一致）。
      const cost = await settleRunCost(id, adapter, sessionId);
      await events.append(id, 'run.finished', 'zelto', { sliceId: id, exitCode: 0, costUsd: cost.costUsd });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`✅ Agent completed successfully (${elapsed}s)`);

      if (cost.exhausted) {
        printOutcome(budgetExhaustedMessage({ sliceId: id }, cost.spent, cost.limit));
        return 0;
      }

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
      console.log('');
      printOutcome(agentFailedMessage({ sliceId: id }, finalExitCode, attempt + 1, elapsed));
      // agent 失败 ≠ 没有越界 —— 失败的那一轮同样可能写了越界的文件。
      // 越界文件清单是人决定「扩写集还是重做规格」的唯一依据；
      // 只报 agent 失败，人会以为「只是没写完」，白跑一轮。
      const outcomeLines = writeSetOutcomeLines({ sliceId: id }, withinBounds);
      if (outcomeLines.length > 0) {
        printOutcome(outcomeLines);
      }
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

/**
 * Run multiple non-conflicting slices in parallel.
 *
 * Usage: zelto run --parallel <id1> [id2 ...] [--agent <name>] [--adapter <type>]
 *
 * 执行语义全部在 ./parallel-executor.ts —— `zelto version start` 走同一条路径，
 * 保证版本层的并行与单切片并行的隔离、守卫、门禁行为完全一致。
 */
async function runParallel(args: string[]): Promise<number> {
  // Collect slice IDs: all non-flag args, regardless of --parallel position
  const ids = args.filter((a) => !a.startsWith('--') && a !== '--parallel');

  if (ids.length < 2) {
    console.error('Usage: zelto run --parallel <slice-id-1> <slice-id-2> [...slice-id-N] [--agent <name>]');
    return 1;
  }

  const agentIdx = args.indexOf('--agent');
  const agentName = agentIdx >= 0 ? args[agentIdx + 1] : undefined;
  const adapterIdx = args.indexOf('--adapter');
  const adapterType = adapterIdx >= 0 ? args[adapterIdx + 1] : undefined;

  // 排阶段（G-1 + G-2）：依赖分层 + 写集冲突降级
  const plan = await buildExecutionPlan(ids, args);

  if (plan.cycle) {
    await events.append('batch', 'coord.cycle_detected', 'zelto', {
      cycle: plan.cycle,
      slices: ids,
    });
    console.error(`\n❌ 依赖成环：${plan.cycle.join(' → ')}`);
    console.error('   环里的切片没法排先后 —— 先解开依赖再跑。');
    return 1;
  }

  printExecutionPlan(plan);

  const result = await executeSlicesByPhase({
    ids,
    phases: plan.phases,
    agentName,
    adapterType,
    title: 'zelto run --parallel',
    eventKey: 'batch',
    affinity: plan.affinity,
    affinityPrevious: plan.affinityPrevious,
  });

  if (result.aborted) {
    console.error(`\n❌ 并行执行未开始：${result.abortReason}`);
    return 1;
  }

  printParallelSummary(result);

  if (result.skipped.length > 0) {
    console.log('');
    console.log(`⏸️  没来得及跑的切片：${result.skipped.join(', ')}`);
  }

  return result.ok ? 0 : 1;
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
    console.error('Usage: zelto start <slice-id> [--title <title>] [--writes <path1,path2,...>] [--requirement <ref>]... [--agent <name>] [--adapter <type>] [--yes]');
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

  // 需求追溯引用（人批准的出处）：start 常常没有规格可解析，
  // 这时人必须显式声明，否则冻结准入会拦住（ADR-032 §3.1）。
  const declaredRequirements = extractFlagValues(args, '--requirement');

  // Step 1: Create if not exists
  let isNew = false;
  if (!(await store.exists(id))) {
    const writes = customWrites ?? detectDefaultWrites();
    const slice = store.create(id, title, {
      writes,
      trace: { requirements: declaredRequirements, contracts: [], tests: [] },
    });
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
      // 人显式声明的需求追溯：切片已有出处就不覆盖（声明优先，但不覆盖更完整的声明）
      if (current.trace.requirements.length === 0 && declaredRequirements.length > 0) {
        current.trace.requirements = declaredRequirements;
        await store.write(current);
      }
      // Write a default spec if none exists
      const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
      const specPath = current.spec.path;
      if (!existsSync(specPath)) {
        const specDir = specPath.substring(0, specPath.lastIndexOf('/'));
        if (!existsSync(specDir)) {
          mkdirSync(specDir, { recursive: true });
        }
        // 占位规格：只有骨架，**验收标准留空**。
        //
        // 为什么不给一条默认的验收标准：那一句话会物化成本片的需求追溯，
        // 于是「追溯合格」变成 zelto 自己替人批准的需求——追溯链看着完整，
        // 实际是空的。假引用比缺失更有毒（ADR-032 §3.3）。
        // 所以这里写骨架，然后由冻结准入拦住人：先把验收标准写下来。
        writeFileSync(
          specPath,
          `# ${current.title}\n\n## Summary\n\n${current.title}\n\n## Scope\n\n## Acceptance Criteria\n\n## Risks\n`,
          'utf-8',
        );
      }

      // 追溯准入闸门（ADR-032 §3.1）：需求追溯为空 → 不许冻结、不许开跑
      const specContent = await readFile(specPath, 'utf-8').catch(() => '');
      const gate = evaluateFreezeTrace(current, specContent);
      if (gate.requirements.length !== current.trace.requirements.length) {
        current.trace.requirements = gate.requirements;
        await store.write(current);
      }
      if (gate.blocking.length > 0) {
        console.error(`  ❌ 追溯不合格，拒绝冻结：`);
        for (const v of gate.blocking) console.error(`     - ${v.message}`);
        console.error(`     在规格「${specPath}」里写「## 验收标准」（编号条目）→ 冻结准入会认它`);
        console.error(`     或显式声明需求追溯： zelto start ${id} --requirement "<需求引用>"`);
        console.error(`     或事后补声明： zelto set ${id} --field trace.requirements --value "<需求引用>"`);
        return 1;
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
    // `checkBudget` 内部已经打印统一措辞（并写 stall.classified 事件）
    const budgetOk = await checkBudget(id);
    if (!budgetOk) {
      return 1;
    }

    await scheduler.startRun(id);

    const slice = await store.read(id);
    const bundle = scheduler.buildConstraints(slice, null, gateCommandsForSlice(slice.writes));
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

      // 停机只做一次（ADR-047）：`handleAgentFailure` 返回 'stall' 时
      // 它已经把切片停机了（退 frozen + 写分类 + 留痕）—— 别调两遍。
      let stalled = false;
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
        stalled = true;
      }

      if (!stalled) {
        await handleAgentFailure(id, exitCode, { maxRetries });
      }
      finalExitCode = exitCode;
      break;
    }

    // 记账（ADR-041 §3.1）
    await store.recordRun(id, { ok: finalExitCode === 0, exitCode: finalExitCode });

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
      // 花费结算（ADR-035）：先记账，再复判预算；超预算则不进 gate。
      const cost = await settleRunCost(id, adapter, sessionId);
      await events.append(id, 'run.finished', 'zelto', { sliceId: id, exitCode: 0, costUsd: cost.costUsd });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`✅ Agent completed successfully (${elapsed}s)`);

      if (cost.exhausted) {
        printOutcome(budgetExhaustedMessage({ sliceId: id }, cost.spent, cost.limit));
        return 0;
      }

      // Auto-run gate and create sign request on pass
      await autoGateAfterRun(id);
    } else {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      printOutcome(agentFailedMessage({ sliceId: id }, finalExitCode, attempt + 1, elapsed));
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

    // 记账（ADR-041 §3.1）：后台运行同样是一次运行。
    await store.recordRun(sliceId, { ok: exitCode === 0, exitCode });

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
    const verdict = await enforceWriteSet(sliceId, guard ?? null);

    // Process result as if foreground (state transition, gate, etc.)
    if (exitCode === 0 && verdict.ok) {
      await store.transit(sliceId, 'RUN_FINISH');
      // 花费结算（ADR-035）：先记账，再复判预算；超预算则不进 gate。
      const cost = await settleRunCost(sliceId, adapter, sessionId);
      await events.append(sliceId, 'run.finished', 'zelto', { sliceId, exitCode: 0, costUsd: cost.costUsd });
      if (cost.exhausted) {
        // 超预算：停在 frozen 等人 —— 不进 gate、不发签字请求。
        console.error('');
        printOutcome(budgetExhaustedMessage({ sliceId }, cost.spent, cost.limit));
      } else if (isHotfix) {
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
      // 越界 / 审计失败：不进 gate、不自动签字 —— 等人处理。
      // `enforceWriteSet` 已经退回 frozen 并写了 run.aborted 事件，这里不重复写。
      console.error('');
      printOutcome(writeSetOutcomeLines({ sliceId }, verdict));
    } else {
      // agent 失败。若同一轮还发生了越界 / 审计失败，两件事都要说 ——
      // 只说 agent 失败，人会以为「只是没写完」，越界文件清单就丢了。
      const outcomeLines = writeSetOutcomeLines({ sliceId }, verdict);
      if (outcomeLines.length > 0) {
        console.error('');
        printOutcome(outcomeLines);
      } else {
        // 只有「没有越界」时才由这里写 run.aborted。
        // 有越界时 `enforceWriteSet` 已经写过一条（reason: write-set violation），
        // 再写一条只会让人误以为发生了两次。
        await events.append(sliceId, 'run.aborted', 'zelto', { sliceId, exitCode });
      }
      // Background tasks: write stall info without auto-retry (adapter already finished)
      const stallClass = classifyStall({
        type: exitCode === null ? 'build_failure' : 'test_failure',
        message: `Agent exited with code ${exitCode ?? 'signal'}`,
        attempts: 1,
      });
      // 后台路径同样走「停机的唯一落点」—— 退回 frozen + 写分类 + 留痕。
      // 后台任务也是一次运行，它的 agent 挂了，切片不能留在 running：
      // 留在 running 就再也跑不了（ADR-047）。
      await markSliceStalled(sliceId, stallClass, {
        exitCode,
        reason: `background agent failed: ${exitCode ?? 'signal'}`,
      });
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
