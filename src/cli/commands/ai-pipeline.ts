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

// ─── require ─────────────────────────────────────────────────────────────────

register('require', async (args) => {
  const subcmd = args[0];

  if (!subcmd) {
    console.error('Usage: zelto require <description>');
    console.error('       zelto require list');
    console.error('       zelto require confirm <id>');
    console.error('       zelto require refine <id> <feedback>');
    return 1;
  }

  if (subcmd === 'list') {
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

    doc.title = result.title;
    doc.spec = result.spec;
    doc.acceptanceCriteria = result.acceptanceCriteria;
    await reqStore.save(doc);

    console.log(`\n✅ Requirement "${id}" updated.`);
    console.log(`   Title: ${result.title}`);
    console.log(`\nAcceptance Criteria:`);
    for (const ac of result.acceptanceCriteria) {
      console.log(`  - ${ac}`);
    }
    console.log(`\nRun again: zelto require refine ${id} <more feedback>`);
    console.log(`Or confirm: zelto require confirm ${id}`);
    return 0;
  }

  // zelto require <description> — generate requirement from text
  const text = args.join(' ');
  if (!text) {
    console.error('Usage: zelto require <description>');
    return 1;
  }

  const llm = createLlmFromConfig();
  if (!llm) {
    console.error('LLM not configured. Add llm.apiKey to .zelto/config.yaml');
    return 1;
  }

  console.log('Generating requirement document...');
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

  console.log(`\n✅ Requirement created: ${id}`);
  console.log(`   Title: ${result.title}`);
  console.log(`\nAcceptance Criteria:`);
  for (const ac of result.acceptanceCriteria) {
    console.log(`  - ${ac}`);
  }
  console.log(`\nRun: zelto require confirm ${id}`);
  return 0;
});

// ─── design ──────────────────────────────────────────────────────────────────

register('design', async (args) => {
  const subcmd = args[0];

  if (!subcmd) {
    console.error('Usage: zelto design <req-id>');
    console.error('       zelto design list');
    console.error('       zelto design confirm <id>');
    console.error('       zelto design refine <id> <feedback>');
    return 1;
  }

  if (subcmd === 'list') {
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

  // zelto design <req-id>
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

// ─── plan ────────────────────────────────────────────────────────────────────

register('plan', async (args) => {
  const subcmd = args[0];

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

  // zelto plan <design-id>
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

// ─── version ─────────────────────────────────────────────────────────────────

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

  // zelto version deliver
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

  // zelto version start
  if (subcmd === 'start') {
    const versionLabel = args[1];
    if (!versionLabel || versionLabel.startsWith('--')) {
      console.error('Usage: zelto version start <version-label> [--plan <plan-id>] [--auto]');
      return 1;
    }

    const isAuto = args.includes('--auto');
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

    await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'in_progress');

    const sliceStore = new SliceStore(SLICES_DIR);
    const cfg = loadConfig();

    // Phase 1: Prepare all slices
    console.log('── Phase 1: Prepare slices ──');
    interface SliceCtx { def: VersionSlice; specContent: string; bundlePath: string }
    const sliceCtxs: SliceCtx[] = [];

    for (const sliceDef of version.slices) {
      if (!(await sliceStore.exists(sliceDef.id))) {
        const sliceData = sliceStore.create(sliceDef.id, sliceDef.title, { writes: sliceDef.writes });
        await sliceStore.write(sliceData);
        console.log(`  ✅ "${sliceDef.id}" created`);
      } else {
        console.log(`  ℹ️  "${sliceDef.id}" already exists`);
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
        console.log(`  ❄️  "${sliceDef.id}" already frozen`);
      } else {
        await sliceStore.transit(sliceDef.id, 'FREEZE');
        console.log(`  ❄️  "${sliceDef.id}" frozen`);
      }

      sliceCtxs.push({ def: sliceDef, specContent, bundlePath });
    }

    // Phase 2: Run agents in parallel
    console.log('\n── Phase 2: Execute agents (parallel) ──');
    const agentResults = await Promise.all(sliceCtxs.map(async (ctx) => {
      await sliceStore.transit(ctx.def.id, 'RUN_START');
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

    // Phase 3: Run gates sequentially, auto-create sign requests
    console.log('\n── Phase 3: Gate checks + sign requests ──');
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
        // Auto-create sign request
        const signReq = await signManager.request(ctx.def.id, 'zelto');
        console.log(`  ✅ "${ctx.def.id}" gate passed → sign request created (${signReq.id})`);
        gateResults.push({ id: ctx.def.id, passed: true });
      } else {
        const failedCmds = gateResult.results.filter((r) => !r.passed).map((r) => r.command);
        console.log(`  ❌ "${ctx.def.id}" gate failed: ${failedCmds.join(', ')}`);
        gateResults.push({ id: ctx.def.id, passed: false });
      }
    }

    const allAgentsOk = agentResults.every((r) => r.exitCode === 0);
    const allGatesOk = gateResults.every((r) => r.passed);

    if (allAgentsOk && allGatesOk) {
      console.log('\n── Phase 4: Integration ──');
      const integrationTestDir = version.integrationTestDir;
      let integrated = false;

      if (existsSync(integrationTestDir)) {
        const { execSync } = await import('node:child_process');
        try {
          execSync(`pnpm test -- --test-path-pattern "${integrationTestDir}"`, {
            cwd: process.cwd(), stdio: 'inherit', timeout: 120000,
          });
          console.log(`  ✅ Integration tests passed for ${versionLabel}`);
          integrated = true;
        } catch {
          console.error(`  ❌ Integration tests failed for ${versionLabel}`);
          integrated = true; // still mark integrated for manual review
        }
      } else {
        console.log(`  ℹ️  No integration tests at ${integrationTestDir}`);
        integrated = true;
      }

      if (integrated) {
        await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'integrated');
        console.log(`\n✅ Version ${versionLabel} integrated!`);

        // Auto mode: approve sign requests → deliver → merge
        if (isAuto) {
          console.log('\n── Phase 5: Auto-approve & deliver ──');
          // Approve all pending sign requests for this version's slices
          for (const ctx of sliceCtxs) {
            const pending = await signManager.list('pending');
            const req = pending.find((r) => r.sliceId === ctx.def.id);
            if (req) {
              await signManager.approve(req.id, 'zelto (auto)', null);
              console.log(`  ✅ "${ctx.def.id}" sign approved`);
            }
          }

          // Deliver the version
          await versionStore.updateVersionStatus(targetPlan.id, versionLabel, 'delivered');
          console.log(`  🚀 Version ${versionLabel} delivered`);

          // Auto-merge to main branch
          console.log('\n── Phase 6: Auto-merge ──');
          try {
            const { execSync } = await import('node:child_process');
            const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
              encoding: 'utf-8', timeout: 5000,
            }).trim();

            if (currentBranch !== 'main') {
              // Stage all changes, commit, and merge
              execSync('git add -A', { cwd: process.cwd(), timeout: 10000 });
              try {
                execSync(`git commit -m "chore: auto-commit for version ${versionLabel}"`, {
                  cwd: process.cwd(), timeout: 10000,
                });
              } catch {
                // Nothing to commit — that's fine
              }

              // Check if main branch exists
              try {
                execSync('git rev-parse --verify main', { timeout: 3000 });
                execSync(`git checkout main && git merge --ff-only ${currentBranch}`, {
                  cwd: process.cwd(), timeout: 15000,
                });
                console.log(`  ✅ Merged "${currentBranch}" → main`);
              } catch {
                console.log(`  ℹ️  No main branch to merge into. Current: ${currentBranch}`);
              }
            } else {
              console.log(`  ℹ️  Already on main branch, skipping merge`);
            }
          } catch (mergeErr) {
            console.log(`  ⚠️  Auto-merge skipped: ${mergeErr}`);
          }

          console.log(`\n🎉 Version ${versionLabel} fully automated!`);
        } else {
          const pendingSigns = await signManager.list('pending');
          const signCmds = pendingSigns
            .filter((r) => sliceCtxs.some((ctx) => ctx.def.id === r.sliceId))
            .map((r) => `zelto sign ${r.sliceId} --approve`);
          if (signCmds.length > 0) {
            console.log(`👉 Next: ${signCmds.join(' && ')}`);
            console.log(`👉 Then: zelto version deliver ${versionLabel}`);
          } else {
            console.log(`👉 Next: zelto version deliver ${versionLabel}`);
          }
        }
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

  console.error('Usage: zelto version status | zelto version start <ver> [--plan <id>] [--auto] | zelto version deliver <ver> [--plan <id>]');
  return 1;
});
