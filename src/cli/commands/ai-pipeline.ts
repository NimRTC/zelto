// AI pipeline commands: require, design, plan, version

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { VersionPlan } from '../../core/version/types.js';
import { RequirementStore } from '../../core/requirements/store.js';
import { DesignStore } from '../../core/design/store.js';
import { VersionStore } from '../../core/version/store.js';
import { SliceStore } from '../../core/slice/store.js';
import type { SliceData } from '../../core/slice/store.js';
import type { RequirementDoc } from '../../core/requirements/types.js';
import type { DesignDoc } from '../../core/design/types.js';
import { generateRequirements, refineRequirements } from '../../llm/generators/requirements.js';
import { generateDesign, refineDesign } from '../../llm/generators/design.js';
import { generateSlicePlan, generateVersion } from '../../llm/generators/slice-plan.js';
import { register } from './shared.js';
import { events, ZELTO_DIR, SLICES_DIR, EVENTS_DIR, loadConfig, createLlmFromConfig, generateSliceSpecContent, hashSpecFile } from './shared.js';
import { executeSlicesByPhase, printParallelSummary } from './parallel-executor.js';
import { buildExecutionPlan, printExecutionPlan } from './execution-plan.js';
import { branchExists, isMergedIntoHead } from './merge-executor.js';
import { getDefaultFormatter } from '../output-formatter.js';

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
        { cwd: process.cwd(), timeout: timeoutSec * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
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

// ─── require ─────────────────────────────────────────────────────────────────

register('require', async (args) => {
  const subcmd = args[0];
  const f = getDefaultFormatter();

  if (!subcmd) {
    f.error('USAGE', 'Usage: zelto require <description>');
    f.out('       zelto require list');
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
      f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Add llm.apiKey to .zelto/config.yaml');
      return 1;
    }

    f.out(`Refining requirement "${id}" with feedback...`);
    const result = await refineRequirements(llm, doc.spec, feedback);

    doc.title = result.title;
    doc.spec = result.spec;
    doc.acceptanceCriteria = result.acceptanceCriteria;
    await reqStore.save(doc);

    f.success(`Requirement "${id}" updated.`);
    f.out(`   Title: ${result.title}`);
    f.out(`\nAcceptance Criteria:`);
    f.data(result.acceptanceCriteria);
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
    f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Add llm.apiKey to .zelto/config.yaml');
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

  f.success(`Requirement created: ${id}`);
  f.out(`   Title: ${result.title}`);
  f.out(`\nAcceptance Criteria:`);
  f.data(result.acceptanceCriteria);
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
    f.out('       zelto design confirm <id>');
    f.out('       zelto design refine <id> <feedback>');
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
      f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Add llm.apiKey to .zelto/config.yaml');
      return 1;
    }

    f.out(`Refining design "${id}" with feedback...`);
    const result = await refineDesign(llm, doc.body, feedback);

    doc.title = result.title;
    doc.body = result.body;
    doc.modules = result.modules;
    await designStore.save(doc);

    f.success(`Design "${id}" updated.`);
    f.out(`   Title: ${result.title}`);
    f.out(`\nModules:`);
    f.data(result.modules.map((m) => ({
      name: m.name,
      description: m.description,
      files: m.filePatterns.length > 0 ? m.filePatterns.join(', ') : '(none)',
      deps: m.dependencies.length > 0 ? m.dependencies.join(', ') : '(none)',
    })));
    f.out(`Run again: zelto design refine ${id} <more feedback>`);
    f.out(`Or confirm: zelto design confirm ${id}`);
    return 0;
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
    f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Add llm.apiKey to .zelto/config.yaml');
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
    modules: result.modules,
    status: 'draft',
    supersedes: null,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };

  const designStore = new DesignStore(ZELTO_DIR);
  await designStore.save(doc);

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
  return 0;
});

// ─── plan ────────────────────────────────────────────────────────────────────

register('plan', async (args) => {
  const subcmd = args[0];
  const f = getDefaultFormatter();

  if (!subcmd) {
    f.error('USAGE', 'Usage: zelto plan <design-id>');
    f.out('       zelto plan list');
    f.out('       zelto plan confirm <id>');
    f.out('       zelto plan add-version <id> <description>');
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

    const specsDir = 'specs/slices';
    if (!existsSync(specsDir)) {
      mkdirSync(specsDir, { recursive: true });
    }

    for (const v of plan.versions) {
      for (const slice of v.slices) {
        const specContent = generateSliceSpecContent(slice.id, slice.title, slice.module, slice.writes, v.version);
        writeFileSync(slice.specPath, specContent, 'utf-8');
        f.out(`  Created ${slice.specPath}`);
      }
    }

    f.success(`Plan "${id}" confirmed.`);
    for (const v of plan.versions) {
      f.out(`   ${v.version}: ${v.slices.length} slices — ${v.description}`);
    }
    f.out('Run "zelto version start <version>" to begin execution.');
    return 0;
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
      f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Add llm.apiKey to .zelto/config.yaml');
      return 1;
    }

    f.out(`Generating new version for plan "${id}"...`);
    const newVersion = await generateVersion(llm, designBody, plan.versions, description);

    if (plan.versions.some((v) => v.version === newVersion.version)) {
      f.error('DUPLICATE', `Version "${newVersion.version}" already exists in plan "${id}".`);
      return 1;
    }

    plan.versions.push(newVersion);
    await versionStore.save(plan);

    f.success(`Version ${newVersion.version} added to plan "${id}":`);
    f.out(`   Description: ${newVersion.description}`);
    f.out(`   Depends on: ${newVersion.dependsOn.join(', ') || '(none)'}`);
    f.out(`   Slices:`);
    f.data(newVersion.slices.map((s) => ({ id: s.id, title: s.title, module: s.module })));
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
    f.error('LLM_NOT_CONFIGURED', 'LLM not configured. Add llm.apiKey to .zelto/config.yaml');
    return 1;
  }

  f.out('Generating version plan...');
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

register('version', async (args) => {
  const subcmd = args[0];
  const f = getDefaultFormatter();

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
        const icon = vIcons[v.status] ?? '⏳';
        const slices = v.slices.map((s) => s.id).join(', ');
        f.out(`  ${icon} ${v.version}: ${v.status} — [${slices}]`);
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

    // ── 第一步：前置条件 —— 切片都已完成，且产物已合入主干 ──────────
    // 「合入主干」由显式的 zelto merge 完成（ADR-018），zelto 不自己合。
    // 这里只检查这件事是否真的发生了——分支没进 HEAD，版本就不可交付。
    f.out(`── 版本级验收：${versionLabel} ──`);

    const sliceStore = new SliceStore(SLICES_DIR);
    const problems: string[] = [];

    for (const s of version.slices) {
      const data = await sliceStore.read(s.id).catch(() => null);
      if (!data) {
        problems.push(`${s.id}：切片不存在`);
        continue;
      }
      if (data.state !== 'completed') {
        problems.push(`${s.id}：状态是 ${data.state}，还没到「已完成」`);
      }
      const branch = `slice/${s.id}`;
      if (branchExists(branch, process.cwd()) && !isMergedIntoHead(branch, process.cwd())) {
        problems.push(`${s.id}：分支 ${branch} 还没合入主干`);
      }
    }

    if (problems.length > 0) {
      f.out('');
      f.out('❌ 验收前置条件不满足：');
      for (const p of problems) f.out(`   - ${p}`);
      f.out('');
      f.out('👉 先签字，再显式合并：zelto sign <slice-id> --approve  然后  zelto merge <slice-id>');
      return 1;
    }

    // ── 第二步：版本级验收 —— 在主仓跑项目自己的门禁命令 ──────────
    // 判据是「合入主干之后的整体能不能过验收」，所以跑在主仓、跑真实代码。
    const cfg = loadConfig();
    const acceptance = await runVersionAcceptance(versionLabel, cfg.gate.commands, cfg.gate.timeoutSec);

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

    await events.append(versionEventKey(versionLabel), 'version.accepted', 'zelto', {
      version: versionLabel,
      commands: acceptance.results.map((r) => ({ name: r.name, passed: r.passed })),
    });

    await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'integrated');
    await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'delivered');
    await events.append(versionEventKey(versionLabel), 'version.delivered', 'zelto', {
      version: versionLabel,
      slices: version.slices.map((s) => s.id),
    });

    f.out('');
    f.out(`🚀 版本 ${versionLabel} 已交付`);
    f.out(`   ${version.description}`);
    f.out(`   切片：${version.slices.map((s) => s.id).join(', ')}`);

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

    await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'in_progress');

    const sliceStore = new SliceStore(SLICES_DIR);

    // ── Phase 1: 准备切片（建切片文件 → 写规格 → 冻结）──────────────
    f.out('\n── Phase 1: Prepare slices ──');
    const prepared: string[] = [];

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
        specContent = generateSliceSpecContent(sliceDef.id, sliceDef.title, sliceDef.module, sliceDef.writes, versionLabel);
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

  f.error('USAGE', 'Usage: zelto version status | zelto version start <ver> [--plan <id>] [--auto] | zelto version deliver <ver> [--plan <id>]');
  return 1;
});
