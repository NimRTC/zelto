// Panoramic and project takeover commands: pipeline, trace, impact, report, project

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequirementStore } from '../../core/requirements/store.js';
import { DesignStore } from '../../core/design/store.js';
import type { DesignDoc } from '../../core/design/types.js';
import { VersionStore } from '../../core/version/store.js';
import type { VersionPlan } from '../../core/version/types.js';
import { SliceStore } from '../../core/slice/store.js';
import type { SliceData } from '../../core/slice/store.js';
import { EventStream } from '../../core/events/stream.js';
import type { EventEnvelope } from '../../core/events/stream.js';
import { register } from './shared.js';
import { ZELTO_DIR, SLICES_DIR, EVENTS_DIR, createLlmFromConfig } from './shared.js';

// ─── pipeline ────────────────────────────────────────────────────────────────

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
            console.log(`           │   └── ${s.id}  (${sliceState})  ${s.title}`);
          }
        }
      }
    }
  }

  return 0;
});

// ─── trace — delegated to src/cli/commands/trace/trace.ts ────────────────────
// The trace command is now implemented in the modular trace/ directory.
// Registration happens in trace/trace.ts via register('trace', ...).

// ─── impact ──────────────────────────────────────────────────────────────────

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
            sliceState === 'draft' ? 'not yet started — safe to adjust' : '';

          console.log(`         ${sliceImpact} ${s.id}  (${sliceState})  ${s.title}`);
          if (impactNote) console.log(`            ${impactNote}`);
        }
      }
    }
  }

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

// ─── report ──────────────────────────────────────────────────────────────────

register('report', async (args) => {
  const formatIdx = args.indexOf('--format') !== -1 ? args.indexOf('--format') : args.indexOf('-f');
  const formatRaw = formatIdx >= 0 ? args[formatIdx + 1] : 'markdown';
  const format = formatRaw === 'json' ? 'json' : 'markdown';

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: zelto report [--format markdown|json]');
    console.log('');
    console.log('Generate a complete project status report.');
    console.log('');
    console.log('Options:');
    console.log('  -f, --format <format>  Output format: markdown (default) or json');
    console.log('  -h, --help             Show this help message');
    return 0;
  }

  if (!existsSync(ZELTO_DIR)) {
    console.error(`Error: "${ZELTO_DIR}" directory not found.`);
    console.error('Are you in a zelto project root? Run "zelto init" to set one up.');
    return 1;
  }

  const reqStore = new RequirementStore(ZELTO_DIR);
  const designStore = new DesignStore(ZELTO_DIR);
  const versionStore = new VersionStore(ZELTO_DIR);
  const sliceStore = new SliceStore(SLICES_DIR);
  const events = new EventStream(EVENTS_DIR);

  const reqSummaries = await reqStore.list();
  const designSummaries = await designStore.list();
  const plans: VersionPlan[] = (await Promise.all(
    (await versionStore.list()).map((p) => versionStore.read(p.id)),
  ));
  const sliceIds = await sliceStore.list();
  const slices = await Promise.all(
    sliceIds.map((id) => sliceStore.read(id).catch(() => null)),
  ).then((r) => r.filter((s): s is SliceData => s !== null));

  const allEvents = new Map<string, EventEnvelope[]>();
  for (const s of slices) {
    const evts = await events.read(s.id);
    allEvents.set(s.id, evts);
  }

  const { analyzeReport } = await import('../../core/report/report-analyzer.js');
  const { generateReport } = await import('../../core/report/report-generator.js');

  const data = await analyzeReport(slices, plans, reqSummaries, designSummaries, allEvents);
  const output = generateReport(data, format);

  console.log(output);
  return 0;
});

// ─── project ─────────────────────────────────────────────────────────────────

register('project', async (args) => {
  const subcmd = args[0];
  const subArgs = args.slice(1);

  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    console.log('Usage: zelto project <subcommand> [options]');
    console.log('');
    console.log('Manage an existing project under zelto governance.');
    console.log('');
    console.log('Subcommands:');
    console.log('  scan              Scan codebase and generate project map');
    console.log('  init              Initialize .zelto/, policy, and config');
    console.log('  design [--llm]    Generate design docs from project map (uses LLM)');
    console.log('  slice             Create v0 baseline slices from design');
    console.log('  status            Show project adoption status');
    return 0;
  }

  // ── project scan ──
  if (subcmd === 'scan') {
    console.log('🔍 Scanning project structure...');
    const { scanProject } = await import('../../core/project/scanner.js');
    const projectMap = scanProject(process.cwd());

    if (!existsSync(ZELTO_DIR)) mkdirSync(ZELTO_DIR, { recursive: true });
    writeFileSync(join(ZELTO_DIR, 'project-map.json'), JSON.stringify(projectMap, null, 2), 'utf-8');

    console.log(`\n✅ Project scanned: "${projectMap.projectName}"`);
    console.log(`   Type: ${projectMap.projectType}`);
    console.log(`   Modules: ${projectMap.modules.length}`);
    console.log(`   Config files: ${projectMap.configFiles.length}`);
    console.log(`   Test command: ${projectMap.testCommand ?? 'not detected'}`);
    console.log(`   Lint command: ${projectMap.lintCommand ?? 'not detected'}`);
    console.log(`\n   Project map saved to: ${ZELTO_DIR}/project-map.json`);
    console.log(`\n👉 Next: zelto project init`);
    return 0;
  }

  // ── project init ──
  if (subcmd === 'init') {
    let projectMap = null;
    const mapPath = join(ZELTO_DIR, 'project-map.json');
    if (existsSync(mapPath)) {
      projectMap = JSON.parse(readFileSync(mapPath, 'utf-8'));
      console.log('📋 Using existing project map.');
    } else {
      console.log('🔍 No project map found. Scanning first...');
      const { scanProject } = await import('../../core/project/scanner.js');
      projectMap = scanProject(process.cwd());
    }

    console.log('🏗️  Initializing zelto governance...');
    const { initializeProject } = await import('../../core/project/initializer.js');
    const result = initializeProject(projectMap, { autoDetect: true, policyTemplate: 'default' });

    if (result.created.length === 0) {
      console.log('   ✅ Already initialized.');
    } else {
      console.log('   Created:');
      for (const item of result.created) {
        console.log(`     ✅ ${item}`);
      }
    }

    console.log(`\n✅ Project "${projectMap.projectName}" is now under zelto governance.`);
    console.log(`\n👉 Next: zelto project design`);
    return 0;
  }

  // ── project design ──
  if (subcmd === 'design') {
    const mapPath = join(ZELTO_DIR, 'project-map.json');
    if (!existsSync(mapPath)) {
      console.error('No project map found. Run "zelto project scan" first.');
      return 1;
    }
    const projectMap = JSON.parse(readFileSync(mapPath, 'utf-8'));

    const llm = createLlmFromConfig();
    if (!llm) {
      console.error('LLM not configured. Set up llm section in .zelto/config.yaml first.');
      console.error('Or run "zelto project init" to generate default config.');
      return 1;
    }

    console.log('🤖 Generating design document from project structure...');
    const { generateProjectDesign } = await import('../../llm/generators/project-design.js');

    const existingId = `prj-${Date.now()}`;
    const design = await generateProjectDesign(llm, projectMap, existingId);

    const designStore = new DesignStore(ZELTO_DIR);
    const doc: DesignDoc = {
      id: existingId,
      requirementId: '(project-takeover)',
      title: design.title,
      body: design.body,
      modules: design.modules,
      status: 'confirmed',
      supersedes: null,
      createdAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
    };
    await designStore.save(doc);

    console.log(`\n✅ Design document created: ${existingId}`);
    console.log(`   Title: ${design.title}`);
    console.log(`   Modules: ${design.modules.length}`);
    for (const m of design.modules) {
      console.log(`     - ${m.name}: ${m.description.slice(0, 60)}`);
    }
    console.log(`\n👉 Next: zelto project slice`);
    return 0;
  }

  // ── project slice ──
  if (subcmd === 'slice') {
    const designStore = new DesignStore(ZELTO_DIR);
    const allDesigns = await designStore.list();
    const confirmedDesigns = allDesigns.filter((d) => d.status === 'confirmed');
    if (confirmedDesigns.length === 0) {
      console.error('No confirmed designs found. Run "zelto project design" first.');
      return 1;
    }
    const design = await designStore.read(confirmedDesigns[0].id);
    console.log(`📋 Using design: ${design.id} (${design.modules.length} modules)`);

    const sliceStore = new SliceStore(SLICES_DIR);
    const slicesDir = 'specs/slices';
    if (!existsSync(slicesDir)) mkdirSync(slicesDir, { recursive: true });

    let created = 0;
    for (const mod of design.modules) {
      const sliceId = `v0-${mod.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
      if (await sliceStore.exists(sliceId)) {
        console.log(`  ℹ️  "${sliceId}" already exists, skipping`);
        continue;
      }

      const slice = sliceStore.create(sliceId, `v0 baseline: ${mod.name}`, {
        writes: mod.filePatterns.length > 0 ? mod.filePatterns : ['src/**/*.ts'],
      });
      slice.state = 'completed';
      slice.trace.requirements = ['(v0 baseline)'];
      slice.spec.frozenHash = 'sha256:v0-baseline';
      slice.spec.frozenAt = new Date().toISOString();
      await sliceStore.write(slice);

      const specPath = `specs/slices/${sliceId}.md`;
      const specContent = `# Slice: ${sliceId}\n\n## 目的\nv0 基线 — ${mod.name}\n\n## 范围\n${mod.filePatterns.map((p: string) => `- \`${p}\``).join('\n')}\n\n## 验收标准\n1. 现有代码不变\n\n## 风险\n- 无\n`;
      writeFileSync(specPath, specContent, 'utf-8');

      created++;
      console.log(`  ✅ "${sliceId}" — ${mod.name}`);
    }

    console.log(`\n✅ Created ${created} baseline slices.`);
    console.log(`👉 You can now create new requirements with "zelto require ..."`);
    return 0;
  }

  // ── project status ──
  if (subcmd === 'status') {
    const hasZeltoDir = existsSync(ZELTO_DIR);
    const hasPolicy = existsSync('policy/policy.yaml');
    const hasSlices = existsSync(SLICES_DIR);
    const hasProjectMap = existsSync(join(ZELTO_DIR, 'project-map.json'));
    const hasDesigns = (await new DesignStore(ZELTO_DIR).list()).length > 0;

    if (!hasZeltoDir) {
      console.log('📋 Project governance: Not started');
      console.log('\n👉 Run: zelto project scan');
      return 0;
    }

    const stages: Array<{ label: string; done: boolean }> = [
      { label: 'Project scan', done: hasProjectMap },
      { label: 'Governance init', done: hasPolicy && hasZeltoDir },
      { label: 'Design docs', done: hasDesigns },
      { label: 'Baseline slices', done: hasSlices && (await new SliceStore(SLICES_DIR).list()).length > 0 },
    ];

    console.log('📋 Project Governance Status');
    console.log('');
    let allDone = true;
    for (const s of stages) {
      console.log(`  ${s.done ? '✅' : '⬜'} ${s.label}`);
      if (!s.done) allDone = false;
    }

    if (allDone) {
      console.log('\n✅ Full governance established!');
      console.log('👉 Next: Create new requirements with "zelto require ..."');
    } else {
      const next = stages.find((s) => !s.done);
      console.log(`\n👉 Next: zelto project ${next?.label.toLowerCase().replace(' ', '-')}`);
    }
    return 0;
  }

  console.error(`Unknown project subcommand: "${subcmd}"`);
  console.error('Usage: zelto project <scan|init|design|slice|status>');
  return 1;
});
