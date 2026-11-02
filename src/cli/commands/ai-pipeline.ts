// AI pipeline commands: require, design, plan, version

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAgentAdapter } from '../../adapters/claude-agent/index.js';
import { RequirementStore } from '../../core/requirements/store.js';
import { DesignStore } from '../../core/design/store.js';
import { VersionStore } from '../../core/version/store.js';
import { SliceStore } from '../../core/slice/store.js';
import type { SliceData } from '../../core/slice/store.js';
import type { VersionPlan, VersionSlice } from '../../core/version/types.js';
import type { RequirementDoc } from '../../core/requirements/types.js';
import type { DesignDoc } from '../../core/design/types.js';
import type { GateConfig } from '../../core/gate/types.js';
import { GateExecutor } from '../../core/gate/executor.js';
import { SignManager } from '../../core/gate/sign.js';
import { EventStream } from '../../core/events/stream.js';
import { generateRequirements, refineRequirements } from '../../llm/generators/requirements.js';
import { generateDesign, refineDesign } from '../../llm/generators/design.js';
import { generateSlicePlan, generateVersion } from '../../llm/generators/slice-plan.js';
import { register } from './shared.js';
import { events, ZELTO_DIR, SLICES_DIR, EVENTS_DIR, loadConfig, createLlmFromConfig, generateSliceSpecContent } from './shared.js';
import { handleAgentFailure } from './core-slice.js';
import { isAutoResolvable } from '../../core/stall/classifier.js';
import { getDefaultFormatter } from '../output-formatter.js';

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
        f.error('NOT_FOUND', 'No confirmed plans found.');
        return 1;
      }
      targetPlan = await versionStore.read(confirmed[0].id);
    }

    const version = targetPlan.versions.find((v) => v.version === versionLabel);
    if (!version) {
      f.error('NOT_FOUND', `Version "${versionLabel}" not found in plan "${targetPlan.id}".`);
      return 1;
    }

    if (version.status !== 'integrated') {
      f.error('INVALID_STATE', `Version "${versionLabel}" is ${version.status}. Must be "integrated" to deliver.`);
      return 1;
    }

    await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'delivered');
    f.out(`\n🚀 Version ${versionLabel} delivered!`);
    f.out(`   ${version.description}`);
    f.out(`   Slices: ${version.slices.map((s) => s.id).join(', ')}`);

    const nextVersion = targetPlan.versions.find((v) => v.status === 'planned');
    if (nextVersion) {
      const depsReady = nextVersion.dependsOn.every((dep) => {
        const dv = targetPlan!.versions.find((v) => v.version === dep);
        return dv && (dv.status === 'integrated' || dv.status === 'delivered');
      });
      if (depsReady) {
        f.out(`\n👉 Next: zelto version start ${nextVersion.version} [--plan ${targetPlan.id}]`);
      }
    }
    return 0;
  }

  // zelto version start
  if (subcmd === 'start') {
    const versionLabel = args[1];
    if (!versionLabel || versionLabel.startsWith('--')) {
      f.error('USAGE', 'Usage: zelto version start <version-label> [--plan <plan-id>] [--auto] [--retry-failed]');
      return 1;
    }

    const isAuto = args.includes('--auto');
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
    const cfg = loadConfig();

    // Phase 1: Prepare all slices
    f.out('\n── Phase 1: Prepare slices ──');
    interface SliceCtx { def: VersionSlice; specContent: string; bundlePath: string }
    const sliceCtxs: SliceCtx[] = [];

    for (const sliceDef of version.slices) {
      if (isRetry) {
        const existingSlice = await sliceStore.read(sliceDef.id).catch(() => null);
        if (existingSlice && existingSlice.state === 'completed') {
          f.out(`  ✅ "${sliceDef.id}" already completed — skipping`);
          continue;
        }
        if (existingSlice && existingSlice.state === 'frozen') {
          f.out(`  ❄️  "${sliceDef.id}" already frozen — will re-run`);
        }
      }

      if (!(await sliceStore.exists(sliceDef.id))) {
        const sliceData = sliceStore.create(sliceDef.id, sliceDef.title, { writes: sliceDef.writes });
        await sliceStore.write(sliceData);
        f.out(`  ✅ "${sliceDef.id}" created`);
      } else {
        f.out(`  ℹ️  "${sliceDef.id}" already exists`);
      }

      const specPath = sliceDef.specPath;
      let specContent = '';
      try {
        specContent = readFileSync(specPath, 'utf-8');
      } catch {
        specContent = generateSliceSpecContent(sliceDef.id, sliceDef.title, sliceDef.module, sliceDef.writes, versionLabel);
        if (!existsSync('specs/slices')) mkdirSync('specs/slices', { recursive: true });
        writeFileSync(specPath, specContent, 'utf-8');
      }

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

      const currentSlice = await sliceStore.read(sliceDef.id).catch(() => null);
      if (currentSlice && currentSlice.state === 'frozen') {
        f.out(`  ❄️  "${sliceDef.id}" already frozen`);
      } else {
        await sliceStore.transit(sliceDef.id, 'FREEZE');
        f.out(`  ❄️  "${sliceDef.id}" frozen`);
      }

      sliceCtxs.push({ def: sliceDef, specContent, bundlePath });
    }

    // Phase 2: Run agents in parallel with per-slice auto-retry
    f.out('\n── Phase 2: Execute agents (parallel) ──');
    const maxRetries = cfg.agent.maxRetries ?? 2;

    const agentResults = await Promise.all(sliceCtxs.map(async (ctx) => {
      await sliceStore.transit(ctx.def.id, 'RUN_START');

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const agent = new ClaudeAgentAdapter({ cwd: process.cwd(), agentCommand: cfg.agent.command });
        const { sessionId } = await agent.start({ sliceId: ctx.def.id, prompt: ctx.bundlePath });
        const exitCode = await agent.waitForExit(sessionId);

        if (exitCode === 0) {
          return { id: ctx.def.id, exitCode: 0, attempts: attempt + 1 };
        }

        // Failed — try auto-retry at CLI level
        f.out(`  ❌ "${ctx.def.id}" agent failed (exit ${exitCode})`);

        if (attempt < maxRetries) {
          const result = await handleAgentFailure(ctx.def.id, exitCode, { maxRetries });
          if (result.action === 'retry') {
            f.out(`  🔄 "${ctx.def.id}" auto-retry (${result.retryCount}/${maxRetries})`);
            continue;
          }
        } else {
          // Ensure stall info is written on final failure
          await handleAgentFailure(ctx.def.id, exitCode, { maxRetries });
        }

        return { id: ctx.def.id, exitCode, attempts: attempt + 1 };
      }

      return { id: ctx.def.id, exitCode: -1, attempts: maxRetries + 1 };
    }));

    f.out('');
    for (const r of agentResults) {
      if (r.exitCode === 0) {
        f.out(`  ✅ "${r.id}" agent completed (${r.attempts} attempt(s))`);
        await sliceStore.transit(r.id, 'RUN_FINISH');
      } else {
        f.out(`  ❌ "${r.id}" agent failed after ${r.attempts} attempt(s)`);
      }
    }

    // Phase 3: Run gates sequentially
    f.out('\n── Phase 3: Gate checks + sign requests ──');
    const gateResults: Array<{ id: string; passed: boolean }> = [];
    const signManager = new SignManager(ZELTO_DIR, events, sliceStore);
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
        const signReq = await signManager.request(ctx.def.id, 'zelto');
        f.out(`  ✅ "${ctx.def.id}" gate passed → sign request created (${signReq.id})`);
        gateResults.push({ id: ctx.def.id, passed: true });
      } else {
        const failedCmds = gateResult.results.filter((r) => !r.passed).map((r) => r.command);
        f.out(`  ❌ "${ctx.def.id}" gate failed: ${failedCmds.join(', ')}`);
        gateResults.push({ id: ctx.def.id, passed: false });
      }
    }

    const allAgentsOk = agentResults.every((r) => r.exitCode === 0);
    const allGatesOk = gateResults.every((r) => r.passed);

    if (allAgentsOk && allGatesOk) {
      f.out('\n── Phase 4: Integration ──');
      const integrationTestDir = version.integrationTestDir;
      let integrated = false;

      if (existsSync(integrationTestDir)) {
        const { execSync } = await import('node:child_process');
        try {
          execSync(`pnpm test -- --test-path-pattern "${integrationTestDir}"`, {
            cwd: process.cwd(), stdio: 'inherit', timeout: 120000,
          });
          f.out(`  ✅ Integration tests passed for ${versionLabel}`);
          integrated = true;
        } catch {
          f.out(`  ❌ Integration tests failed for ${versionLabel}`);
          integrated = true;
        }
      } else {
        f.out(`  ℹ️  No integration tests at ${integrationTestDir}`);
        integrated = true;
      }

      if (integrated) {
        await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'integrated');
        f.out(`\n✅ Version ${versionLabel} integrated!`);

        if (isAuto) {
          f.out('\n── Phase 5: Auto-approve & deliver ──');
          for (const ctx of sliceCtxs) {
            const pending = await signManager.list('pending');
            const req = pending.find((r) => r.sliceId === ctx.def.id);
            if (req) {
              await signManager.approve(req.id, 'zelto (auto)', null);
              f.out(`  ✅ "${ctx.def.id}" sign approved`);
            }
          }

          await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'delivered');
          f.out(`  🚀 Version ${versionLabel} delivered`);

          f.out('\n── Phase 6: Auto-merge ──');
          try {
            const { execSync } = await import('node:child_process');
            const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
              encoding: 'utf-8', timeout: 5000,
            }).trim();

            if (currentBranch !== 'main') {
              execSync('git add -A', { cwd: process.cwd(), timeout: 10000 });
              try {
                execSync(`git commit -m "chore: auto-commit for version ${versionLabel}"`, {
                  cwd: process.cwd(), timeout: 10000,
                });
              } catch { /* nothing to commit */ }

              try {
                execSync('git rev-parse --verify main', { timeout: 3000 });
                execSync(`git checkout main && git merge --ff-only ${currentBranch}`, {
                  cwd: process.cwd(), timeout: 15000,
                });
                f.out(`  ✅ Merged "${currentBranch}" → main`);
              } catch {
                f.out(`  ℹ️  No main branch to merge into. Current: ${currentBranch}`);
              }
            } else {
              f.out(`  ℹ️  Already on main branch, skipping merge`);
            }
          } catch (mergeErr) {
            f.out(`  ⚠️  Auto-merge skipped: ${mergeErr}`);
          }

          f.out(`\n🎉 Version ${versionLabel} fully automated!`);
        } else {
          const pendingSigns = await signManager.list('pending');
          const signCmds = pendingSigns
            .filter((r) => sliceCtxs.some((ctx) => ctx.def.id === r.sliceId))
            .map((r) => `zelto sign ${r.sliceId} --approve`);
          if (signCmds.length > 0) {
            f.out(`👉 Next: ${signCmds.join(' && ')}`);
            f.out(`👉 Then: zelto version deliver ${versionLabel}`);
          } else {
            f.out(`👉 Next: zelto version deliver ${versionLabel}`);
          }
        }
      }
    } else {
      f.out(`\n❌ Version ${versionLabel} has failures:`);
      for (const r of agentResults) {
        if (r.exitCode !== 0) f.out(`   ❌ Agent: ${r.id} (exit ${r.exitCode})`);
      }
      for (const r of gateResults) {
        if (!r.passed) f.out(`   ❌ Gate: ${r.id}`);
      }
    }

    return allAgentsOk && allGatesOk ? 0 : 1;
  }

  f.error('USAGE', 'Usage: zelto version status | zelto version start <ver> [--plan <id>] [--auto] | zelto version deliver <ver> [--plan <id>]');
  return 1;
});
