// AI pipeline commands: require, design, plan, version

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { VersionPlan } from '../../core/version/types.js';
import { RequirementStore } from '../../core/requirements/store.js';
import { DesignStore } from '../../core/design/store.js';
import { deriveModules } from '../../core/design/derive.js';
import { VersionStore } from '../../core/version/store.js';
import { SliceStore } from '../../core/slice/store.js';
import type { SliceData } from '../../core/slice/store.js';
import type { RequirementDoc } from '../../core/requirements/types.js';
import type { DesignDoc } from '../../core/design/types.js';
import { generateRequirements, refineRequirements } from '../../llm/generators/requirements.js';
import { generateDesign, refineDesign } from '../../llm/generators/design.js';
import { generateSlicePlan, generateVersion } from '../../llm/generators/slice-plan.js';
import { register } from './shared.js';
import { events, ZELTO_DIR, SLICES_DIR, EVENTS_DIR, loadConfig, createLlmFromConfig, hashSpecFile } from './shared.js';
import { createSpecDraft } from './slice-spec.js';
import { RevisionStore } from '../../core/review/index.js';
import { designFacts, planFacts, requirementFacts, showDraft } from './draft-review.js';
import { executeSlicesByPhase, printParallelSummary } from './parallel-executor.js';
import { buildExecutionPlan, printExecutionPlan } from './execution-plan.js';
import { branchExists, isMergedIntoHead, isMergedIntoRef } from './merge-executor.js';
import {
  branchOfVersion,
  prepareVersionWorkspace,
  formatCrossVersionConflicts,
  detectCrossVersionConflictsFor,
} from './version-runtime.js';
import { worktreeManager } from './shared.js';
import { resolveWriteSet } from './run-support.js';
import { describeGuardKinds, designGuard, loadWholeGraphGuard } from './arch-guard.js';
import { getDefaultFormatter } from '../output-formatter.js';
import { evaluateFreezeTrace } from '../../core/spec/trace-extract.js';
import { ContractBaselineStore, ContractRegistry, diffSchemas } from '../../core/contracts/index.js';
import {
  RegressionBaselineStore,
  compareRegression,
  hasRegression,
  mergeTapResults,
  parseTapResults,
  renderRegression,
} from '../../core/regression/index.js';

// ─── 版本级验收 ──────────────────────────────────────────────────────────────

/**
 * 版本级事件在事件流里的归属键。
 *
 * 事件流是按切片分目录的（`.zelto/events/<slice>/events.jsonl`），
 * 版本不是切片，但版本级动作同样要留痕（C4）——所以用 `version-<label>` 当键，
 * 不与任何切片 id 冲突。
 */
function versionEventKey(versionLabel: string): string {
  return `version-${versionLabel}`;
}

/**
 * 收集各版本的写集（跨版本冲突检测用，ADR-056 §3.6）。
 *
 * 只收集 **in_progress** 的版本 —— 已交付的版本产物已经在主仓上了，
 * 跟正在跑的版本冲突是「主干前进」的问题，不是「两个版本并行」的问题。
 *
 * 写集来自切片文件（`resolveWriteSet` 会把规格里的写集解析出来并写回）。
 *
 * @param planId 计划 id —— **重新读盘**而不是用内存里的副本。
 *   `updateVersionStatus` 写的是盘，内存副本的 status 还是旧的
 *   （本版本刚被设成 in_progress，内存里还是 planned），
 *   用内存副本会把本版本自己过滤掉。
 */
async function collectVersionWriteSets(
  planId: string,
): Promise<Array<{ version: string; writes: string[] }>> {
  const sliceStore = new SliceStore(SLICES_DIR);
  const versionStore = new VersionStore(ZELTO_DIR);
  const plan = await versionStore.read(planId);
  const result: Array<{ version: string; writes: string[] }> = [];

  for (const version of plan.versions) {
    if (version.status !== 'in_progress') continue;
    const writes = new Set<string>();
    for (const sliceDef of version.slices) {
      const slice = await sliceStore.read(sliceDef.id).catch(() => null);
      if (!slice) continue;
      const resolved = await resolveWriteSet(sliceDef.id, false);
      for (const w of resolved.writes.length > 0 ? resolved.writes : slice.writes) {
        writes.add(w);
      }
    }
    if (writes.size > 0) {
      result.push({ version: version.version, writes: [...writes].sort() });
    }
  }

  return result;
}

/**
 * 草稿（需求 / 设计 / 版本计划）的事件归属键。
 *
 * 草稿不是切片，但草稿的每一次改动同样要留痕（C4）——
 * 「这一版规划是谁改的、改了什么」必须能查。
 */
function draftEventKey(kind: string, id: string): string {
  return `draft-${kind}-${id}`;
}

/**
 * 版本级验收：在主仓跑项目自己的门禁命令。
 *
 * 判据是「合入主干之后的整体能不能过验收」，所以：
 * - 跑在主仓（cwd = 当前项目根），跑的是真实的主干代码
 * - 命令取自 `.zelto/config.yaml` 的 `gate.commands` —— 项目自己的验收口径
 * - 超时按 `gate.timeoutSec`，超时算失败
 *
 * 判定是确定性的：不调模型、不触网（C3）。
 */
async function runVersionAcceptance(
  versionLabel: string,
  commands: Array<{ name: string; run: string }>,
  timeoutSec: number,
  codeRoot: string = process.cwd(),
): Promise<{
  passed: boolean;
  results: Array<{ name: string; passed: boolean; code: number | null; output: string }>;
}> {
  const { exec } = await import('node:child_process');
  const results: Array<{ name: string; passed: boolean; code: number | null; output: string }> = [];

  for (const cmd of commands) {
    process.stdout.write(`  ▸ ${cmd.name}: ${cmd.run}\n`);
    const outcome = await new Promise<{ code: number | null; output: string }>((resolve) => {
      exec(
        cmd.run,
        { cwd: codeRoot, timeout: timeoutSec * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
          resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}` });
        },
      );
    });
    results.push({ name: cmd.name, passed: outcome.code === 0, code: outcome.code, output: outcome.output });
  }

  const passed = results.every((r) => r.passed);
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    process.stdout.write(`    ${icon} ${r.name}（exit ${r.code ?? 'signal'}）\n`);
    if (!r.passed) {
      const tail = r.output.split('\n').filter((l) => l.trim()).slice(-8);
      for (const line of tail) {
        process.stdout.write(`       ${line.slice(0, 200)}\n`);
      }
    }
  }

  return { passed, results };
}

/**
 * 契约演进检查（ADR-036）：当前契约 vs 人工确认过的基线。
 *
 * 没有基线时不判 —— 「还没确认过基线」不是「没有问题」，
 * 但它也不该拦住一个从没用过这个功能的项目（老项目无感）。
 *
 * 判据是纯计算：读文件、算差集。不调模型、不触网（C3）。
 */
async function runContractEvolutionCheck(
  codeRoot: string = process.cwd(),
): Promise<{
  hasBaseline: boolean;
  breaking: number;
  details: string[];
}> {
  const store = new ContractBaselineStore(ZELTO_DIR);
  const baseline = await store.read();
  if (!baseline) return { hasBaseline: false, breaking: 0, details: [] };

  const dir = join(codeRoot, 'contracts', 'schemas');
  if (!existsSync(dir)) return { hasBaseline: true, breaking: 0, details: [] };

  const registry = new ContractRegistry(dir);
  const schemas = await registry.loadAll();
  const current: Record<string, Record<string, unknown>> = {};
  for (const contract of schemas) current[contract.name] = contract.schema;

  const names = new Set([...Object.keys(baseline.contracts), ...Object.keys(current)]);
  const details: string[] = [];
  let breaking = 0;

  for (const name of [...names].sort()) {
    const changes = diffSchemas(baseline.contracts[name] ?? null, current[name] ?? {});
    for (const change of changes) {
      if (!change.breaking) continue;
      breaking += 1;
      const label = change.direction === 'writer' ? '写入方破坏' : '读取方破坏';
      details.push(`${name}  ${change.path}  [${label}]  ${change.message}`);
    }
  }

  return { hasBaseline: true, breaking, details };
}

/**
 * 找「上一个已交付且有回归基线」的版本。
 *
 * 找不到就没有可比对象 —— 第一个版本没有上版本，回归无从谈起。
 */
function findPreviousDeliveredVersion(
  plan: VersionPlan,
  currentVersion: string,
  store: RegressionBaselineStore,
): string | null {
  for (let i = plan.versions.length - 1; i >= 0; i -= 1) {
    const candidate = plan.versions[i];
    if (candidate.version === currentVersion) continue;
    if (candidate.status !== 'delivered' && candidate.status !== 'integrated') continue;
    if (!store.exists(plan.id, candidate.version)) continue;
    return candidate.version;
  }
  return null;
}

// ─── require ─────────────────────────────────────────────────────────────────

register('require', async (args) => {
  const subcmd = args[0];
  const f = getDefaultFormatter();

  if (!subcmd) {
    f.error('USAGE', 'Usage: zelto require <description>');
    f.out('       zelto require list');
    f.out('       zelto require show <id>   摘要 + 决策点 + 差异');
    f.out('       zelto require confirm <id>');
    f.out('       zelto require refine <id> <feedback>');
    return 1;
  }

  if (subcmd === 'list') {
    const reqStore = new RequirementStore(ZELTO_DIR);
    const list = await reqStore.list();
    if (list.length === 0) {
      f.out('No requirements found.');
      return 0;
    }
    f.data(list.map((r) => ({ id: r.id, status: r.status, title: r.title })));
    return 0;
  }

  if (subcmd === 'show') {
    const id = args[1];
    if (!id || id.startsWith('--')) {
      f.error('USAGE', 'Usage: zelto require show <id> [--diff] [--no-diff] [--full]');
      return 1;
    }
    return showDraft('requirement', id, {
      diff: !args.includes('--no-diff'),
      full: args.includes('--full'),
    });
  }

  if (subcmd === 'confirm') {
    const id = args[1];
    if (!id || id.startsWith('--')) {
      f.error('USAGE', 'Usage: zelto require confirm <id>');
      return 1;
    }
    const reqStore = new RequirementStore(ZELTO_DIR);
    if (!(await reqStore.exists(id))) {
      f.error('NOT_FOUND', `Requirement "${id}" not found.`);
      return 1;
    }
    const doc = await reqStore.read(id);
    doc.status = 'confirmed';
    doc.confirmedAt = new Date().toISOString();
    await reqStore.save(doc);
    await events.append(draftEventKey('requirement', id), 'draft.confirmed', 'zelto', {
      kind: 'requirement',
      id,
      title: doc.title,
    });
    f.success(`Requirement "${id}" confirmed.`);
    return 0;
  }

  if (subcmd === 'refine') {
    const id = args[1];
    const feedback = args.slice(2).join(' ');
    if (!id || id.startsWith('--') || !feedback) {
      f.error('USAGE', 'Usage: zelto require refine <id> <feedback text>');
      return 1;
    }
    const reqStore = new RequirementStore(ZELTO_DIR);
    if (!(await reqStore.exists(id))) {
      f.error('NOT_FOUND', `Requirement "${id}" not found.`);
      return 1;
    }
    const doc = await reqStore.read(id);
    if (doc.status !== 'draft') {
      f.error('INVALID_STATE', `Requirement "${id}" is already ${doc.status}. Can only refine draft requirements.`);
      return 1;
    }

    const llm = createLlmFromConfig('ai-pipeline', 'cli');
    if (!llm) {
      f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Set ZELTO_LLM_API_KEY (or add llm.apiKey to .zelto/config.yaml).');
      return 1;
    }

    f.out(`Refining requirement "${id}" with feedback...`);

    // 覆盖前先留一份快照 —— 之后 `show --diff` 才有得可对（G-5）
    const revisions = new RevisionStore(ZELTO_DIR);
    await revisions.snapshot('requirement', id, requirementFacts(doc));

    const result = await refineRequirements(llm, doc.spec, feedback);

    doc.title = result.title;
    doc.spec = result.spec;
    doc.acceptanceCriteria = result.acceptanceCriteria;
    await reqStore.save(doc);

    await events.append(draftEventKey('requirement', id), 'draft.revised', 'zelto', {
      kind: 'requirement',
      id,
      title: doc.title,
      feedback,
    });

    f.success(`Requirement "${id}" updated.`);
    f.out(`   Title: ${result.title}`);
    f.out(`\nAcceptance Criteria:`);
    f.data(result.acceptanceCriteria);
    f.out(`Review the change: zelto require show ${id} --diff`);
    f.out(`Run again: zelto require refine ${id} <more feedback>`);
    f.out(`Or confirm: zelto require confirm ${id}`);
    return 0;
  }

  // zelto require <description> — generate requirement from text
  const text = args.join(' ');
  if (!text) {
    f.error('USAGE', 'Usage: zelto require <description>');
    return 1;
  }

  const llm = createLlmFromConfig('ai-pipeline', 'cli');
  if (!llm) {
    f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Set ZELTO_LLM_API_KEY (or add llm.apiKey to .zelto/config.yaml).');
    return 1;
  }

  f.out('Generating requirement document...');
  const result = await generateRequirements(llm, text, '');

  const id = `req-${Date.now()}`;
  const doc: RequirementDoc = {
    id,
    title: result.title,
    spec: result.spec,
    userInput: text,
    acceptanceCriteria: result.acceptanceCriteria,
    status: 'draft',
    supersedes: null,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };

  const reqStore = new RequirementStore(ZELTO_DIR);
  await reqStore.save(doc);

  await events.append(draftEventKey('requirement', id), 'draft.created', 'zelto', {
    kind: 'requirement',
    id,
    title: doc.title,
  });

  f.success(`Requirement created: ${id}`);
  f.out(`   Title: ${result.title}`);
  f.out(`\nAcceptance Criteria:`);
  f.data(result.acceptanceCriteria);
  f.out(`Review it: zelto require show ${id}`);
  f.out(`Run: zelto require confirm ${id}`);
  return 0;
});

// ─── design ──────────────────────────────────────────────────────────────────

register('design', async (args) => {
  const subcmd = args[0];
  const f = getDefaultFormatter();

  if (!subcmd) {
    f.error('USAGE', 'Usage: zelto design <req-id>');
    f.out('       zelto design list');
    f.out('       zelto design show <id>   摘要 + 决策点 + 差异');
    f.out('       zelto design confirm <id>');
    f.out('       zelto design refine <id> <feedback>');
    f.out('       zelto design patch <id> --module <name> --path <glob>   修正已确认设计的模块字段');
    return 1;
  }

  if (subcmd === 'list') {
    const designStore = new DesignStore(ZELTO_DIR);
    const list = await designStore.list();
    if (list.length === 0) {
      f.out('No designs found.');
      return 0;
    }
    f.data(list.map((d) => ({ id: d.id, status: d.status, reqId: d.requirementId, title: d.title, modules: d.moduleCount })));
    return 0;
  }

  if (subcmd === 'show') {
    const id = args[1];
    if (!id || id.startsWith('--')) {
      f.error('USAGE', 'Usage: zelto design show <id> [--diff] [--no-diff] [--full]');
      return 1;
    }
    return showDraft('design', id, {
      diff: !args.includes('--no-diff'),
      full: args.includes('--full'),
    });
  }

  if (subcmd === 'confirm') {
    const id = args[1];
    if (!id || id.startsWith('--')) {
      f.error('USAGE', 'Usage: zelto design confirm <id>');
      return 1;
    }
    const designStore = new DesignStore(ZELTO_DIR);
    if (!(await designStore.exists(id))) {
      f.error('NOT_FOUND', `Design "${id}" not found.`);
      return 1;
    }
    const doc = await designStore.read(id);
    doc.status = 'confirmed';
    doc.confirmedAt = new Date().toISOString();
    await designStore.save(doc);
    await events.append(draftEventKey('design', id), 'draft.confirmed', 'zelto', {
      kind: 'design',
      id,
      title: doc.title,
    });
    f.success(`Design "${id}" confirmed.`);
    return 0;
  }

  if (subcmd === 'refine') {
    const id = args[1];
    const feedback = args.slice(2).join(' ');
    if (!id || id.startsWith('--') || !feedback) {
      f.error('USAGE', 'Usage: zelto design refine <id> <feedback text>');
      return 1;
    }
    const designStore = new DesignStore(ZELTO_DIR);
    if (!(await designStore.exists(id))) {
      f.error('NOT_FOUND', `Design "${id}" not found.`);
      return 1;
    }
    const doc = await designStore.read(id);
    if (doc.status !== 'draft') {
      f.error('INVALID_STATE', `Design "${id}" is already ${doc.status}. Can only refine draft designs.`);
      return 1;
    }

    const llm = createLlmFromConfig('ai-pipeline', 'cli');
    if (!llm) {
      f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Set ZELTO_LLM_API_KEY (or add llm.apiKey to .zelto/config.yaml).');
      return 1;
    }

    f.out(`Refining design "${id}" with feedback...`);

    // 覆盖前先留一份快照 —— 之后 `show --diff` 才有得可对（G-5）
    const revisions = new RevisionStore(ZELTO_DIR);
    await revisions.snapshot('design', id, designFacts(doc));

    const result = await refineDesign(llm, doc.body, feedback);

    doc.title = result.title;
    doc.body = result.body;
    // 存的 modules 只是快照：判定时一律从正文重新推导（core/design/derive.ts）
    doc.modules = deriveModules({ body: result.body, modules: result.modules });
    await designStore.save(doc);

    await events.append(draftEventKey('design', id), 'draft.revised', 'zelto', {
      kind: 'design',
      id,
      title: doc.title,
      feedback,
    });

    f.success(`Design "${id}" updated.`);
    f.out(`   Title: ${result.title}`);
    f.out(`\nModules:`);
    f.data(result.modules.map((m) => ({
      name: m.name,
      description: m.description,
      files: m.filePatterns.length > 0 ? m.filePatterns.join(', ') : '(none)',
      deps: m.dependencies.length > 0 ? m.dependencies.join(', ') : '(none)',
    })));
    f.out(`Review the change: zelto design show ${id} --diff`);
    f.out(`Run again: zelto design refine ${id} <more feedback>`);
    f.out(`Or confirm: zelto design confirm ${id}`);
    return 0;
  }

  if (subcmd === 'patch') {
    // 确定性修正（不经 LLM）—— ADR-063
    const { designPatch } = await import('./design-patch.js');
    return designPatch(args.slice(1));
  }

  // zelto design <req-id>
  const reqId = subcmd;
  if (!reqId || reqId.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto design <req-id> | zelto design list | zelto design confirm <id>');
    return 1;
  }

  const reqStore = new RequirementStore(ZELTO_DIR);
  if (!(await reqStore.exists(reqId))) {
    f.error('NOT_FOUND', `Requirement "${reqId}" not found.`);
    return 1;
  }
  const req = await reqStore.read(reqId);
  if (req.status !== 'confirmed') {
    f.error('INVALID_STATE', `Requirement "${reqId}" is not confirmed. Run "zelto require confirm ${reqId}" first.`);
    return 1;
  }

  const llm = createLlmFromConfig('ai-pipeline', 'cli');
  if (!llm) {
    f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Set ZELTO_LLM_API_KEY (or add llm.apiKey to .zelto/config.yaml).');
    return 1;
  }

  f.out('Generating design document...');
  const result = await generateDesign(llm, req.spec, '');

  const id = `dsg-${Date.now()}`;
  const doc: DesignDoc = {
    id,
    requirementId: reqId,
    title: result.title,
    body: result.body,
    // 存的 modules 只是快照：判定时一律从正文重新推导（core/design/derive.ts）
    modules: deriveModules({ body: result.body, modules: result.modules }),
    status: 'draft',
    supersedes: null,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };

  const designStore = new DesignStore(ZELTO_DIR);
  await designStore.save(doc);

  await events.append(draftEventKey('design', id), 'draft.created', 'zelto', {
    kind: 'design',
    id,
    title: doc.title,
    requirementId: reqId,
  });

  f.success(`Design created: ${id}`);
  f.out(`   Title: ${result.title}`);
  f.out(`\nModules:`);
  f.data(result.modules.map((m) => ({
    name: m.name,
    description: m.description,
    files: m.filePatterns.length > 0 ? m.filePatterns.join(', ') : '(none)',
    deps: m.dependencies.length > 0 ? m.dependencies.join(', ') : '(none)',
  })));
  f.out(`Run: zelto design confirm ${id}`);
  f.out(`Review it: zelto design show ${id}`);
  return 0;
});

// ─── plan ────────────────────────────────────────────────────────────────────

register('plan', async (args) => {
  const subcmd = args[0];
  const f = getDefaultFormatter();

  if (!subcmd) {
    f.error('USAGE', 'Usage: zelto plan <design-id>');
    f.out('       zelto plan list');
    f.out('       zelto plan show <id>   摘要 + 决策点 + 差异');
    f.out('       zelto plan confirm <id>');
    f.out('       zelto plan add-version <id> <description>');
    f.out('       zelto plan patch <id> --version <v> [--add-slice <id> | --remove-slice <id> | --slice <id> --write <p>...]');
    return 1;
  }

  if (subcmd === 'list') {
    const versionStore = new VersionStore(ZELTO_DIR);
    const list = await versionStore.list();
    if (list.length === 0) {
      f.out('No plans found.');
      return 0;
    }
    f.data(list.map((p) => ({ id: p.id, status: p.status, title: p.title, versions: p.versionCount })));
    return 0;
  }

  if (subcmd === 'show') {
    const id = args[1];
    if (!id || id.startsWith('--')) {
      f.error('USAGE', 'Usage: zelto plan show <id> [--diff] [--no-diff] [--full]');
      return 1;
    }
    return showDraft('plan', id, {
      diff: !args.includes('--no-diff'),
      full: args.includes('--full'),
    });
  }

  if (subcmd === 'confirm') {
    const id = args[1];
    if (!id || id.startsWith('--')) {
      f.error('USAGE', 'Usage: zelto plan confirm <id>');
      return 1;
    }
    const versionStore = new VersionStore(ZELTO_DIR);
    if (!(await versionStore.exists(id))) {
      f.error('NOT_FOUND', `Plan "${id}" not found.`);
      return 1;
    }
    const plan = await versionStore.read(id);
    plan.status = 'confirmed';
    plan.confirmedAt = new Date().toISOString();
    await versionStore.save(plan);

    // 计划确认**不代填规格**（ADR-034）。
    // 工具自动写的规格会物化成本片的需求追溯，于是「追溯合格」变成
    // zelto 替人批准的需求（ADR-032 §4 方案四）。规格由人确认的草稿产生：
    //   zelto spec draft <slice-id>   → 生成草稿 + 验收测试骨架
    //   zelto spec confirm <slice-id> → 人确认后写进正式规格
    const plannedSlices = plan.versions.flatMap((v) => v.slices.map((s) => s.id));

    f.success(`Plan "${id}" confirmed.`);
    for (const v of plan.versions) {
      f.out(`   ${v.version}: ${v.slices.length} slices — ${v.description}`);
    }
    await events.append(draftEventKey('plan', id), 'draft.confirmed', 'zelto', {
      kind: 'plan',
      id,
      title: plan.title,
      versions: plan.versions.map((v) => v.version),
    });
    f.out('下一步：给每一片生成规格草稿并由你确认：');
    for (const sliceId of plannedSlices) {
      f.out(`   zelto spec draft ${sliceId}   →   zelto spec confirm ${sliceId}`);
    }
    f.out('确认完再跑 zelto version start —— 没有确认过的规格不会被冻结。');
    return 0;
  }

  if (subcmd === 'patch') {
    const { planPatch } = await import('./plan-patch.js');
    return planPatch(args.slice(1));
  }

  if (subcmd === 'add-version') {
    const id = args[1];
    const description = args.slice(2).join(' ');
    if (!id || id.startsWith('--') || !description) {
      f.error('USAGE', 'Usage: zelto plan add-version <plan-id> <version description>');
      return 1;
    }

    const versionStore = new VersionStore(ZELTO_DIR);
    if (!(await versionStore.exists(id))) {
      f.error('NOT_FOUND', `Plan "${id}" not found.`);
      return 1;
    }
    const plan = await versionStore.read(id);

    const designStore = new DesignStore(ZELTO_DIR);
    let designBody = '';
    try {
      const design = await designStore.read(plan.designId);
      designBody = design.body;
    } catch {
      f.error('NOT_FOUND', `Design "${plan.designId}" not found. Cannot generate version without design context.`);
      return 1;
    }

    const llm = createLlmFromConfig('ai-pipeline', 'cli');
    if (!llm) {
      f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Set ZELTO_LLM_API_KEY (or add llm.apiKey to .zelto/config.yaml).');
      return 1;
    }

    f.out(`Generating new version for plan "${id}"...`);

    // 覆盖前先留一份快照 —— 之后 `show --diff` 才有得可对（G-5）
    const revisions = new RevisionStore(ZELTO_DIR);
    await revisions.snapshot('plan', id, planFacts(plan));

    const newVersion = await generateVersion(llm, designBody, plan.versions, description);

    if (plan.versions.some((v) => v.version === newVersion.version)) {
      f.error('DUPLICATE', `Version "${newVersion.version}" already exists in plan "${id}".`);
      return 1;
    }

    plan.versions.push(newVersion);
    await versionStore.save(plan);

    await events.append(draftEventKey('plan', id), 'draft.revised', 'zelto', {
      kind: 'plan',
      id,
      title: plan.title,
      addedVersion: newVersion.version,
    });

    f.success(`Version ${newVersion.version} added to plan "${id}":`);
    f.out(`   Description: ${newVersion.description}`);
    f.out(`   Depends on: ${newVersion.dependsOn.join(', ') || '(none)'}`);
    f.out(`   Slices:`);
    f.data(newVersion.slices.map((s) => ({ id: s.id, title: s.title, module: s.module })));
    f.out(`Review the change: zelto plan show ${id} --diff`);
    f.out(`Run "zelto plan confirm ${id}" to lock the updated plan.`);
    return 0;
  }

  // zelto plan <design-id>
  const designId = subcmd;
  if (!designId || designId.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto plan <design-id> | zelto plan list | zelto plan confirm <id> | zelto plan add-version <id> <desc>');
    return 1;
  }

  const designStore = new DesignStore(ZELTO_DIR);
  if (!(await designStore.exists(designId))) {
    f.error('NOT_FOUND', `Design "${designId}" not found.`);
    return 1;
  }
  const design = await designStore.read(designId);
  if (design.status !== 'confirmed') {
    f.error('INVALID_STATE', `Design "${designId}" is not confirmed. Run "zelto design confirm ${designId}" first.`);
    return 1;
  }

  const llm = createLlmFromConfig('ai-pipeline', 'cli');
  if (!llm) {
    f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Set ZELTO_LLM_API_KEY (or add llm.apiKey to .zelto/config.yaml).');
    return 1;
  }

  f.out('Generating version plan...');
  // 模块声明从正文推导（正文是真源），存的 modules 只是缓存
  const result = await generateSlicePlan(llm, design.body, deriveModules(design), '');

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

  await events.append(draftEventKey('plan', id), 'draft.created', 'zelto', {
    kind: 'plan',
    id,
    title: plan.title,
    versions: plan.versions.map((v) => v.version),
  });

  f.success(`Plan created: ${id}`);
  f.out(`   Title: ${result.title}`);
  for (const v of result.versions) {
    f.out(`\n  ${v.version}: ${v.description}`);
    f.out(`    Status: ${v.status}`);
    f.data(v.slices.map((s) => `- ${s.id}: ${s.title}`));
  }
  f.out(`Run: zelto plan confirm ${id}`);
  return 0;
});

// ─── version ─────────────────────────────────────────────────────────────────

/**
 * 这个版本**实际**做完没有（D-57）。
 *
 * 病灶（实测 nimrtc-zelto v3，2026-11-18）：
 *   合并时把「切片分支不存在」当「已合入」→ 一片都没跑的版本被判成 integrated。
 *   `version status` 照着计划显示「✅ integrated」→ 人以为这版做完了，
 *   实际有一片还冻着、一次都没跑。
 *
 * 判据：**每一片的切片状态都得是 completed**。
 * 读不出来（文件不在 / 坏了）→ 当作没做完 —— 「不知道」不等于「做完了」。
 *
 * @returns 实际状态；返回 null = 计划记的没错，按计划显示。
 */
export async function realVersionState(
  version: VersionPlan['versions'][number],
  _plan: VersionPlan,
): Promise<'planned' | 'in_progress' | 'integrated' | 'delivered' | null> {
  if (version.status !== 'integrated' && version.status !== 'delivered') {
    // 只在计划说「做完了」的时候才需要复核。
    return null;
  }
  const store = new SliceStore(SLICES_DIR);
  for (const s of version.slices) {
    let state: string | undefined;
    try {
      const slice: SliceData = await store.read(s.id);
      state = slice.state;
    } catch {
      return 'in_progress';
    }
    if (state !== 'completed') return 'in_progress';
  }
  return null;
}

register('version', async (args) => {
  const subcmd = args[0];
  const f = getDefaultFormatter();

  // zelto version ship —— 版本分支合入主干（ADR-056 §3.5）
  //
  // 独立显式动作：不与签字绑定，不自动合并。
  if (subcmd === 'ship') {
    const { handleVersionShip } = await import('./version-ship.js');
    return handleVersionShip(args, f);
  }

  // zelto version cleanup —— 清理版本工作目录（分支与 tag 保留）
  if (subcmd === 'cleanup') {
    const { handleVersionCleanup } = await import('./version-ship.js');
    return handleVersionCleanup(args, f);
  }

  // zelto version adopt —— 给老版本补建版本分支（ADR-056 迁移）
  //
  // 老项目升级后版本已在跑（in_progress）但版本分支从不存在 →
  // 没有这一步就永远 ship 不了。
  if (subcmd === 'adopt') {
    const { handleVersionAdopt } = await import('./version-adopt.js');
    return handleVersionAdopt(args, f);
  }

  // zelto version status
  if (!subcmd || subcmd === 'status') {
    const versionStore = new VersionStore(ZELTO_DIR);
    const plans = await versionStore.list();
    if (plans.length === 0) {
      f.out('No version plans found.');
      return 0;
    }
    for (const p of plans) {
      const plan = await versionStore.read(p.id);
      const vIcons: Record<string, string> = {
        planned: '⏳', in_progress: '🔄', integrated: '✅', delivered: '🚀',
      };
      f.out(`Plan: ${p.id} (${p.status})`);
      f.out(`  Title: ${plan.title}`);
      for (const v of plan.versions) {
        // D-57：显示的是**事实**，不是计划里存的那个词。
        //
        // 病灶（实测 nimrtc-zelto v3，2026-11-18）：
        //   合并时把「分支不存在」当「已合入」→ 一片都没做的版本被判成 integrated。
        //   `version status` 老老实实显示「✅ integrated」——
        //   人看到的是「这版做完了」，实际有一片还冻着、一次都没跑。
        //
        // 所以这里重新核一遍：标 integrated/delivered 之前，
        // 先确认这一版的切片**真的都走到 completed**。
        // 对不上就如实显示「实际没做完」，而不是跟着计划说谎。
        const realState = await realVersionState(v, plan);
        const shown = realState ?? v.status;
        const icon = vIcons[shown] ?? '⏳';
        const slices = v.slices.map((s) => s.id).join(', ');
        const note = realState && realState !== v.status ? ` （计划记的是 ${v.status}）` : '';
        f.out(`  ${icon} ${v.version}: ${shown} — [${slices}]${note}`);
      }
      const nextVersion = plan.versions.find((v) => v.status === 'planned');
      if (nextVersion) {
        const depsReady = nextVersion.dependsOn.every((dep) => {
          const dv = plan.versions.find((v) => v.version === dep);
          return dv && (dv.status === 'integrated' || dv.status === 'delivered');
        });
        if (depsReady) {
          f.out(`  👉 Next: zelto version start ${nextVersion.version} --plan ${plan.id}`);
        } else {
          const blockedBy = nextVersion.dependsOn.filter((dep) => {
            const dv = plan.versions.find((v) => v.version === dep);
            return !dv || (dv.status !== 'integrated' && dv.status !== 'delivered');
          });
          f.out(`  ⏳ Next: ${nextVersion.version} (waiting for: ${blockedBy.join(', ')})`);
        }
      }
    }
    return 0;
  }

// zelto version deliver
  if (subcmd === 'deliver') {
    const versionLabel = args[1];
    if (!versionLabel || versionLabel.startsWith('--')) {
      f.error('USAGE', 'Usage: zelto version deliver <version-label> [--plan <plan-id>]');
      return 1;
    }

    const planIdx = args.indexOf('--plan');
    const planId = planIdx >= 0 ? args[planIdx + 1] : null;

    const versionStore = new VersionStore(ZELTO_DIR);
    let targetPlan: VersionPlan | null = null;

    if (planId) {
      if (!(await versionStore.exists(planId))) {
        f.error('NOT_FOUND', `Plan "${planId}" not found.`);
        return 1;
      }
      targetPlan = await versionStore.read(planId);
    } else {
      const plans = await versionStore.list();
      const confirmed = plans.filter((p) => p.status === 'confirmed');
      if (confirmed.length === 0) {
        f.error('NOT_FOUND', 'No confirmed plans found. Confirm a plan first.');
        return 1;
      }
      targetPlan = await versionStore.read(confirmed[0].id);
    }

    const version = targetPlan.versions.find((v) => v.version === versionLabel);
    if (!version) {
      f.error('NOT_FOUND', `Version "${versionLabel}" not found in plan "${targetPlan.id}".`);
      return 1;
    }

    if (version.status !== 'in_progress' && version.status !== 'integrated') {
      f.error('INVALID_STATE', `Version "${versionLabel}" is ${version.status}. Must be "in_progress" to deliver.`);
      return 1;
    }

    // ── 第一步：前置条件 —— 切片都已完成，且产物已合入版本分支 ──────
    // 「合入」由显式的 zelto merge 完成（ADR-018），zelto 不自己合。
    // 这里只检查这件事是否真的发生了——分支没进版本分支，版本就不可交付。
    //
    // ADR-056 §3.4：判据从「合入主干」改成「合入版本分支」。
    // 版本分支存在 → 按版本分支判；不存在（老项目）→ 按主干判（向后兼容）。
    f.out(`── 版本级验收：${versionLabel} ──`);

    const versionBranch = branchOfVersion(version);
    const manager = worktreeManager();
    const hasVersionBranch = manager.isGitRepo() && branchExists(versionBranch, process.cwd());
    const versionWorktreeExists = manager.versionExists(versionLabel);

    // 验收在哪个目录跑：版本工作目录（有这个目录时）；否则主仓（老项目）
    const codeRoot = versionWorktreeExists ? manager.versionPathFor(versionLabel) : process.cwd();

    const sliceStore = new SliceStore(SLICES_DIR);
    const problems: string[] = [];
    // 被放弃的切片不阻塞版本交付，但要显式列出来 —— 不能静默吞掉
    // 「这个版本少了哪几片」。这与 report-analyzer 对版本进度的
    // 口径一致（completed || abandoned 算已了结）。
    const abandonedSlices: string[] = [];

    for (const s of version.slices) {
      const data = await sliceStore.read(s.id).catch(() => null);
      if (!data) {
        problems.push(`${s.id}：切片不存在`);
        continue;
      }
      if (data.state === 'abandoned') {
        abandonedSlices.push(s.id);
        continue;
      }
      if (data.state !== 'completed') {
        problems.push(`${s.id}：状态是 ${data.state}，还没到「已完成」`);
      }
      const branch = `slice/${s.id}`;
      if (!branchExists(branch, process.cwd())) continue;

      if (hasVersionBranch) {
        // 判「合入版本分支」—— 不是合入主干
        if (!isMergedIntoRef(branch, `refs/heads/${versionBranch}`, process.cwd())) {
          problems.push(`${s.id}：分支 ${branch} 还没合入 ${versionBranch}`);
        }
      } else if (!isMergedIntoHead(branch, process.cwd())) {
        problems.push(`${s.id}：分支 ${branch} 还没合入主干`);
      }
    }

    if (abandonedSlices.length > 0) {
      f.out(`   ⚠️ 本版本有 ${abandonedSlices.length} 个切片被放弃（不阻塞交付）：`);
      for (const id of abandonedSlices) f.out(`      - ${id}`);
    }

    if (problems.length > 0) {
      f.out('');
      f.out('❌ 验收前置条件不满足：');
      for (const p of problems) f.out(`   - ${p}`);
      f.out('');
      f.out('👉 先签字，再显式合并：zelto sign <slice-id> --approve  然后  zelto merge <slice-id>');
      return 1;
    }

    if (hasVersionBranch) {
      f.out(`   验收目录：${versionWorktreeExists ? manager.versionRelativePathFor(versionLabel) : '主仓（版本工作目录不存在）'}`);
    }

    // ── 第二步：架构护栏（整图结论作为交付门，ADR-027 Q2）────────
    // 判据是「这个版本的整体架构偏离」，扫**版本工作目录**、读主仓的设计与 policy。
    // ADR-056 §3.4：验收对象从「主干代码」改成「这个版本的代码状态」。
    // 无确认设计时跳过（老项目无感）；ask 只提示不拦，deny 才拦。
    const archGuard = await loadWholeGraphGuard({
      designRoot: process.cwd(),
      scanRoot: codeRoot,
    });
    if (archGuard) {
      // 版本级看的是「本设计的模块范围」之外还是之内（ADR-073 §3.2）——
      // 设计之外的仓库文件不属于这份设计的账。
      const designVerdict = designGuard(archGuard);
      if (designVerdict.verdict.blocked) {
        f.out('');
        f.out(`❌ 版本 ${versionLabel} 的架构护栏未通过 —— 状态保持 in_progress`);
        f.out(`   ${describeGuardKinds(designVerdict.verdict, 'blocked')}`);
        f.out(`   设计：${archGuard.designId}「${archGuard.designTitle}」`);
        f.out('');
        f.out('👉 修好偏离，或改 policy.yaml 的 arch 段后重新验收：zelto version deliver ' + versionLabel);
        return 1;
      }
      const pending = designVerdict.verdict.perKind.filter((k) => k.needsConfirm && k.count > 0);
      if (pending.length > 0) {
        f.out('');
        f.out(`⚠️  架构护栏待确认（不拦）：${describeGuardKinds(archGuard.guard, 'pending')}`);
      }
    }

    // ── 第二步之二：契约演进检查（ADR-036）────────────────────────
    // 契约改坏了，别的程序读不懂 —— 这件事在「版本交付」这一层最该被拦住：
    // 交付是版本对外生效的边界，契约破坏留到交付之后才发现，代价已经出去了。
    // 没有基线时不判（老项目无感）；有基线且检出破坏 → 阻断交付。
    const contractCheck = await runContractEvolutionCheck(codeRoot);
    if (contractCheck.breaking > 0) {
      f.out('');
      f.out(`❌ 版本 ${versionLabel} 的契约演进检查未通过 —— 状态保持 in_progress`);
      for (const line of contractCheck.details) f.out(`   ${line}`);
      f.out('');
      f.out('👉 确认这次契约变化可以接受后更新基线：zelto contract baseline');
      f.out('   然后重新验收：zelto version deliver ' + versionLabel);
      return 1;
    }

    // ── 第三步：版本级验收 —— 在版本工作目录跑项目自己的门禁命令 ────
    // 判据是「这个版本的整体能不能过验收」，所以跑在版本工作目录、跑这个版本的代码。
    const cfg = loadConfig();
    const acceptance = await runVersionAcceptance(
      versionLabel,
      cfg.gate.commands,
      cfg.gate.timeoutSec,
      codeRoot,
    );

    if (!acceptance.passed) {
      f.out('');
      f.out(`❌ 版本 ${versionLabel} 的版本级验收未通过 —— 状态保持 in_progress`);
      for (const r of acceptance.results) {
        if (!r.passed) f.out(`   - ${r.name}（exit ${r.code ?? 'signal'}）`);
      }
      f.out('');
      f.out('👉 修好之后重新验收：zelto version deliver ' + versionLabel);
      return 1;
    }

    // ── 第三步之二：跨版本回归基线（ADR-036）──────────────────────
    // 版本级验收只给一个「过 / 不过」，看不出「上个版本验证过的东西，
    // 这个版本还在不在」。这里把用例状态记下来，与上一个已交付版本对比：
    // 用例消失、退化成空壳、或直接失败 —— 都是回归。
    const regressionStore = new RegressionBaselineStore(ZELTO_DIR);
    const tapResults = mergeTapResults(acceptance.results.map((r) => parseTapResults(r.output)));

    if (!tapResults.known) {
      f.out('');
      f.out('ℹ️  验收输出里读不出 TAP 用例列表 —— 本次不记录回归基线（不猜别的运行器格式）');
    } else {
      const previousVersion = findPreviousDeliveredVersion(targetPlan, versionLabel, regressionStore);

      if (previousVersion) {
        const previousBaseline = await regressionStore.read(targetPlan.id, previousVersion);
        const report = compareRegression(
          previousBaseline?.tests ?? [],
          tapResults.tests,
          previousVersion,
          versionLabel,
        );

        if (hasRegression(report)) {
          await events.append(versionEventKey(versionLabel), 'version.regression_detected', 'zelto', {
            version: versionLabel,
            previousVersion,
            regressed: report.regressed.length,
            degraded: report.degraded.length,
            missing: report.missing.length,
            fixed: report.fixed.length,
          });

          if (!args.includes('--accept-regression')) {
            f.out('');
            f.out(`❌ 版本 ${versionLabel} 相对版本 ${previousVersion} 有回归 —— 状态保持 in_progress`);
            f.out(renderRegression(report));
            f.out('');
            f.out('👉 修好回归，或显式接受这次回归：zelto version deliver ' + versionLabel + ' --accept-regression');
            return 1;
          }

          f.out('');
          f.out('⚠️  已显式接受本次回归：');
          f.out(renderRegression(report));
          await events.append(versionEventKey(versionLabel), 'version.regression_detected', 'zelto', {
            version: versionLabel,
            previousVersion,
            regressed: report.regressed.length,
            degraded: report.degraded.length,
            missing: report.missing.length,
            fixed: report.fixed.length,
            accepted: true,
          });
        }
      }

      await regressionStore.write({
        format: 1,
        planId: targetPlan.id,
        version: versionLabel,
        capturedAt: new Date().toISOString(),
        source: 'version-acceptance',
        tests: tapResults.tests,
      });
      await events.append(versionEventKey(versionLabel), 'version.regression_recorded', 'zelto', {
        version: versionLabel,
        tests: tapResults.tests.length,
      });
    }

    await events.append(versionEventKey(versionLabel), 'version.accepted', 'zelto', {
      version: versionLabel,
      commands: acceptance.results.map((r) => ({ name: r.name, passed: r.passed })),
      slices: version.slices.map((s) => s.id),
    });

    // 版本状态 → integrated
    //
    // **只到 integrated，不到 delivered**（ADR-056 §3.5）：
    // `delivered` 的含义是「这个版本已经进了主干」——
    // 只有 `zelto version ship` 合入主干之后才能给。
    // `version deliver` 到此为止：切片已进版本分支、版本级验收已通过。
    //
    // 之前这里一路设到 delivered，等于「验收一过就宣布交付」——
    // 但版本分支还没进主干，主干上根本没有这个版本。
    // 那会让 `version status` 报出假的交付状态。
    await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'integrated');

    f.out('');
    f.out(`✅ 版本 ${versionLabel} 验收通过（状态：integrated）`);
    f.out(`   ${version.description}`);
    f.out(`   切片：${version.slices.map((s) => s.id).join(', ')}`);
    f.out('   版本分支已包含本版本全部切片产物，但**还没进主干**。');
    f.out('   合入主干（显式动作，不与签字绑定）：');
    f.out(`     zelto version ship ${versionLabel}`);

    const nextVersion = targetPlan.versions.find((v) => v.status === 'planned');
    if (nextVersion) {
      const depsReady = nextVersion.dependsOn.every((dep) => {
        const dv = targetPlan!.versions.find((v) => v.version === dep);
        return dv && (dv.status === 'integrated' || dv.status === 'delivered');
      });
      if (depsReady) {
        f.out(`\n👉 下一步：zelto version start ${nextVersion.version} [--plan ${targetPlan.id}]`);
      }
    }
    return 0;
  }

  // zelto version start
  if (subcmd === 'start') {
    const versionLabel = args[1];
    if (!versionLabel || versionLabel.startsWith('--')) {
      f.error('USAGE', 'Usage: zelto version start <version-label> [--plan <plan-id>] [--retry-failed]');
      return 1;
    }

    if (args.includes('--auto')) {
      f.error('INVALID_ARGS', 'zelto version start --auto 已移除：签字必须由人行使（AGENTS.md 禁区：一键批准 / 自动合并）。');
      f.out('   请逐个签字：zelto sign <slice-id> --approve');
      return 1;
    }

    const isRetry = args.includes('--retry-failed');
    const planIdx = args.indexOf('--plan');
    const planId = planIdx >= 0 ? args[planIdx + 1] : null;

    const versionStore = new VersionStore(ZELTO_DIR);
    let targetPlan: VersionPlan | null = null;

    if (planId) {
      if (!(await versionStore.exists(planId))) {
        f.error('NOT_FOUND', `Plan "${planId}" not found.`);
        return 1;
      }
      targetPlan = await versionStore.read(planId);
    } else {
      const plans = await versionStore.list();
      const confirmed = plans.filter((p) => p.status === 'confirmed');
      if (confirmed.length === 0) {
        f.error('NOT_FOUND', 'No confirmed plans found. Confirm a plan first.');
        return 1;
      }
      targetPlan = await versionStore.read(confirmed[0].id);
    }

    const version = targetPlan.versions.find((v) => v.version === versionLabel);
    if (!version) {
      f.error('NOT_FOUND', `Version "${versionLabel}" not found in plan "${targetPlan.id}".`);
      return 1;
    }

    if (version.status !== 'planned') {
      if (!isRetry || version.status !== 'in_progress') {
        f.error('INVALID_STATE', `Version "${versionLabel}" is already ${version.status}.`);
        return 1;
      }
      f.out(`  ℹ️  Version "${versionLabel}" is in_progress — retrying failed slices`);
    }

    for (const dep of version.dependsOn) {
      const depVersion = targetPlan.versions.find((v) => v.version === dep);
      if (depVersion && depVersion.status !== 'integrated' && depVersion.status !== 'delivered') {
        f.error('BLOCKED', `Dependency ${dep} is not yet integrated (status: ${depVersion.status}).`);
        return 1;
      }
    }

    f.out(`Starting version ${versionLabel} (${version.description})`);
    f.out(`Slices: ${version.slices.map((s) => s.id).join(', ')}`);

    // ── Phase 0: 版本工作目录（ADR-056）─────────────────────────────
    //
    // 版本分支 `version/<label>` + 集成目录 `.zelto/version-worktrees/<label>/`。
    // 这个版本里的切片从这里出发，产物也合回这里 —— 不碰主仓。
    //
    // 基点（D1-A + D2-A）：
    // - 有前置版本 → 从前置版本的分支 tip（否则 dependsOn 是假的依赖）
    // - 无前置版本 → 从主干 HEAD
    // - 第一次确定后**钉死**进版本计划，之后不重算（基点可复现）
    const versionBranch = branchOfVersion(version);
    let versionBaseCommit: string | null = version.baseCommit ?? null;
    let versionBaseSource = '版本计划里已钉死的基点';

    if (!versionBaseCommit) {
      const manager = worktreeManager();
      if (manager.isGitRepo()) {
        const workspace = await prepareVersionWorkspace(version, targetPlan, {
          repoRoot: process.cwd(),
          manager,
        });
        if (workspace.error) {
          f.error('BLOCKED', workspace.error);
          return 1;
        }
        versionBaseCommit = workspace.baseCommit;
        versionBaseSource = workspace.baseSource;
        if (workspace.dependencyNote) f.out(`  ${workspace.dependencyNote}`);
        f.out(`  📂 版本分支 ${versionBranch}（基点：${versionBaseSource}）`);
        f.out(`     工作目录 ${manager.versionRelativePathFor(versionLabel)}`);

        // 基点钉死进版本计划 —— 之后重跑不再重算（ADR-056 D1-A）
        version.baseCommit = versionBaseCommit;
        await versionStore.save(targetPlan);
        await events.append(versionEventKey(versionLabel), 'worktree.created', 'zelto', {
          sliceId: versionLabel,
          path: manager.versionRelativePathFor(versionLabel),
          branch: versionBranch,
          baseCommit: versionBaseCommit,
          kind: 'version',
        });
      } else {
        f.out('  ℹ️  不在 git 仓库中 —— 版本分支不可用，切片将在当前目录执行');
      }
    } else {
      f.out(`  📂 版本分支 ${versionBranch}（基点已钉死：${versionBaseCommit}）`);
    }

    await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'in_progress');

    const sliceStore = new SliceStore(SLICES_DIR);

    // ── Phase 1: 准备切片（建切片文件 → 写规格 → 冻结）──────────────
    f.out('\n── Phase 1: Prepare slices ──');
    const prepared: string[] = [];
    const pendingConfirm: string[] = [];

    for (const sliceDef of version.slices) {
      const existing = await sliceStore.read(sliceDef.id).catch(() => null);

      if (existing && existing.state === 'completed') {
        f.out(`  ✅ "${sliceDef.id}" 已完成 —— 跳过`);
        continue;
      }

      if (existing && existing.state !== 'draft' && existing.state !== 'clarifying' && existing.state !== 'frozen') {
        f.error('INVALID_STATE', `"${sliceDef.id}" 处于 ${existing.state}，不能直接开跑。先处理它（zelto resume / zelto abandon）。`);
        return 1;
      }

      if (!existing) {
        const created = sliceStore.create(sliceDef.id, sliceDef.title, { writes: sliceDef.writes });
        await sliceStore.write(created);
        f.out(`  ✅ "${sliceDef.id}" 已创建`);
      }

      const sliceData = await sliceStore.read(sliceDef.id);

      // 规格写到切片自己的路径 —— worktree 复制的是这一份
      const specPath = sliceData.spec.path;
      let specContent = '';
      try {
        specContent = readFileSync(specPath, 'utf-8');
      } catch {
        // 正式规格不存在 → 生成**草稿**，等人确认（ADR-034）。
        // 这一片不冻结：追溯的出处必须是人确认过的规格，而不是工具刚写的东西。
        const draft = await createSpecDraft(sliceDef.id);
        f.out(`  📝 "${sliceDef.id}" 还没有确认过的规格 —— 已生成草稿：${draft?.path ?? '(生成失败)'}`);
        pendingConfirm.push(sliceDef.id);
        continue;
      }
      const specDir = dirname(specPath);
      if (!existsSync(specDir)) mkdirSync(specDir, { recursive: true });
      writeFileSync(specPath, specContent, 'utf-8');

      // 计划里指定的规格路径也同步一份 —— 那是给人看的版本
      if (sliceDef.specPath && sliceDef.specPath !== specPath) {
        const planSpecDir = dirname(sliceDef.specPath);
        if (!existsSync(planSpecDir)) mkdirSync(planSpecDir, { recursive: true });
        writeFileSync(sliceDef.specPath, specContent, 'utf-8');
      }

      // 冻结：规格哈希 + 时间戳 + 事件 —— 与 `zelto freeze` 同一套判据
      if (sliceData.state !== 'frozen') {
        // 追溯准入闸门（ADR-032 §3.1）：需求追溯为空 → 不许冻结。
        // 规格里的「验收标准」会物化成本片的需求追溯（人批准的出处）。
        const gate = evaluateFreezeTrace(sliceData, specContent);
        if (gate.requirements.length !== sliceData.trace.requirements.length) {
          sliceData.trace.requirements = gate.requirements;
          await sliceStore.write(sliceData);
        }
        if (gate.blocking.length > 0) {
          f.error('BLOCKED', `"${sliceDef.id}" 追溯不合格，拒绝冻结：${gate.blocking.map((v) => v.message).join('；')}`);
          return 1;
        }

        sliceData.spec.frozenHash = hashSpecFile(specPath) ?? `sha256:${Date.now()}`;
        sliceData.spec.frozenAt = new Date().toISOString();
        await sliceStore.write(sliceData);
        await sliceStore.transit(sliceDef.id, 'FREEZE');
        await events.append(sliceDef.id, 'spec.frozen', 'cli', {
          sliceId: sliceDef.id,
          frozenHash: sliceData.spec.frozenHash,
          frozenAt: sliceData.spec.frozenAt,
        });
        f.out(`  ❄️  "${sliceDef.id}" 已冻结`);
      } else {
        f.out(`  ❄️  "${sliceDef.id}" 已经是冻结状态`);
      }

      prepared.push(sliceDef.id);
    }

    // 有片还没拿到「人确认过的规格」→ 这一轮不开跑。
    // 追溯的出处必须是人批准的规格；工具刚生成的草稿不算（ADR-034 / ADR-032 §4）。
    if (pendingConfirm.length > 0) {
      f.out('');
      f.error(
        'BLOCKED',
        `${pendingConfirm.length} 个切片还没有确认过的规格，本轮不启动执行：${pendingConfirm.join('、')}`,
      );
      f.out('   审阅草稿（.zelto/drafts/specs/）并确认后重跑：');
      for (const id of pendingConfirm) {
        f.out(`     zelto spec confirm ${id}`);
      }
      return 1;
    }

    // ── 跨版本冲突检测（ADR-056 §3.6 / D5-B）─────────────────────
    //
    // 两个版本是两个批次 —— 跨批次的冲突没人比。这里把本版本的写集
    // 与其它 in_progress 版本比一比。
    //
    // **提示但不阻断**（D5-B）：跨版本判定是启发式的 —— 它挡得住
    // 「两个版本都改 types.ts」，挡不住「一个版本改了语义、另一个按旧语义写」。
    // 拿启发式判定硬阻断会误伤，与 ADR-019 把「整批 abort」改成
    // 「降级为串行」是同一个思路。
    //
    // 另给 `--strict` 让想硬拦的人用。
    //
    // 位置：Phase 1 之后、Phase 2 之前 —— 「没有待执行切片」的早退也在
    // 它后面，这样重跑一个已跑完的版本时冲突仍然会被报出来。
    const crossConflicts = await detectCrossVersionConflictsFor(
      versionLabel,
      await collectVersionWriteSets(targetPlan.id),
    );
    if (crossConflicts.length > 0) {
      const lines = formatCrossVersionConflicts(crossConflicts);
      f.out('');
      for (const line of lines) f.out(`  ${line}`);

      if (args.includes('--strict')) {
        f.error('BLOCKED', '检出跨版本冲突，--strict 模式下中止。');
        await events.append(versionEventKey(versionLabel), 'artifact.conflict_detected', 'zelto', {
          version: versionLabel,
          conflicts: crossConflicts,
          strict: true,
        });
        return 1;
      }

      await events.append(versionEventKey(versionLabel), 'artifact.conflict_detected', 'zelto', {
        version: versionLabel,
        conflicts: crossConflicts,
        strict: false,
      });
      f.out('');
      f.out('  ℹ️  继续执行（跨版本冲突默认只提示）。要硬拦加 --strict。');
    }

    if (prepared.length === 0) {
      f.out('');
      f.out(`ℹ️  版本 ${versionLabel} 没有待执行的切片（全部已完成）`);
      return 0;
    }

    // ── Phase 2: 排阶段 + 并行执行 ─────────────────────────────────
    // 与 `zelto run --parallel` 走同一条路径：每个切片一份隔离 worktree、
    // 一份写集预约守卫、一次门禁②、一次签名请求（ADR-012 / ADR-014）。
    //
    // 阶段怎么排（G-1 + G-2）：
    //   - 依赖分层：规格「前置切片」章节里的依赖，阶段之间串行
    //   - 写集降级：同阶段写集撞了自动拆成两个阶段，不整批 abort
    f.out('\n── Phase 2: Execute agents (phased, isolated) ──');
    const cfg = loadConfig();

    const plan = await buildExecutionPlan(prepared, args);

    if (plan.cycle) {
      await events.append(`version-${versionLabel}`, 'coord.cycle_detected', 'zelto', {
        version: versionLabel,
        cycle: plan.cycle,
        slices: prepared,
      });
      f.error('BLOCKED', `依赖成环：${plan.cycle.join(' → ')}`);
      f.out('   环里的切片没法排先后 —— 先解开依赖，再跑 version start。');
      return 1;
    }

    printExecutionPlan(plan);

    const result = await executeSlicesByPhase({
      ids: prepared,
      phases: plan.phases,
      agentName: cfg.agent.command,
      title: `版本 ${versionLabel}`,
      eventKey: `version-${versionLabel}`,
      affinity: plan.affinity,
      affinityPrevious: plan.affinityPrevious,
      baseCommitOverride: versionBaseCommit,
    });

    if (result.aborted) {
      f.error('BLOCKED', `并行执行未开始：${result.abortReason}`);
      return 1;
    }

    // ── Phase 3: 结果 ───────────────────────────────────────────────
    f.out('\n── Phase 3: 结果 ──');
    printParallelSummary(result);

    if (!result.ok) {
      f.out('');
      f.out(`❌ 版本 ${versionLabel} 未全部通过 —— 状态保持 in_progress`);
      for (const o of result.outcomes) {
        if (o.status !== 'completed') f.out(`   - ${o.id}: ${o.status}`);
      }
      f.out('');
      f.out(`👉 处理完之后重跑：zelto version start ${versionLabel} --retry-failed`);
      return 1;
    }

    f.out('');
    f.out(`✅ 版本 ${versionLabel} 的切片全部通过门禁 —— 等人签字`);
    f.out('   先签字（签字只改状态，不碰主干）：');
    for (const o of result.outcomes) {
      f.out(`     zelto sign ${o.id} --approve`);
    }
    f.out('   再显式合入主干：zelto merge');
    f.out(`   全部合入之后：zelto version deliver ${versionLabel}`);

    return 0;
  }

  f.error(
    'USAGE',
    'Usage: zelto version status | zelto version start <ver> [--plan <id>] | ' +
    'zelto version deliver <ver> [--plan <id>] | zelto version adopt <ver> [--plan <id>] | ' +
    'zelto version ship <ver> [--plan <id>] | zelto version cleanup <ver>',
  );
  return 1;
});
