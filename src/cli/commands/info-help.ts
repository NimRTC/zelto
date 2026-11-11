// Info, help, and utility commands: next, init, summary, events, help, hook, stall, resume

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Scheduler } from '../../core/sched/engine.js';
import { isSliceStalled, findDeadSlices, reapDeadSlices } from '../../core/stall/index.js';
import type { SliceData } from '../../core/slice/store.js';
import { AuditTrail } from '../../core/audit/trail.js';
import { MetricsCollector } from '../../core/metrics/collector.js';
import { register } from './shared.js';
import { store, events, ZELTO_DIR, SLICES_DIR, EVENTS_DIR, loadPolicyConfig, loadConfig } from './shared.js';
import { collectPlanningDrafts, draftConfirmCommand, draftShowCommand } from './planning-drafts.js';
import { collectPendingActions, type PendingAction } from './pending-actions.js';
import {
  collectCompletedSummary,
  deliveryLabel,
  deliverySummaryLine,
  DELIVERY_ORDER,
} from './completed-slices.js';
import { commandsByGroup, findCommand, usageOf } from './catalog.js';
import { colors, formatSection, formatKeyValue, formatWarning } from '../color.js';
import { getDefaultFormatter } from '../output-formatter.js';
import { writeOutput } from '../output.js';

// ─── next ────────────────────────────────────────────────────────────────────

register('next', async () => {
  const list = await store.list();

  // 规划草稿只读收集：上游没确认，下游跑了也白跑，所以排在切片状态之前。
  // 停机仍最高——那是执行中被交回控制权，眼下唯一该做的事。
  const drafts = await collectPlanningDrafts(ZELTO_DIR);

  // 停机切片优先：人被交还控制权的那一刻，最该看见的就是「哪些切片等着他处理」。
  // 停机切片的状态通常还是 frozen（回退后的状态），按状态优先级排会被
  // draft/clarifying 挤到后面去 —— 而它们才是眼下唯一该做的事。
  const stalled: Array<{ id: string; title: string; class: string }> = [];
  for (const id of list) {
    try {
      const s = await store.read(id);
      if (s.stall.class !== null) {
        stalled.push({ id, title: s.title, class: s.stall.class });
      }
    } catch {
      // Skip unreadable slices
    }
  }

  if (stalled.length > 0) {
    const first = stalled[0];
    console.log(`Next: ${first.id} (stalled: ${first.class})`);
    console.log(`  ${first.title}`);
    console.log(`  Action: zelto stall ${first.id}`);
    console.log(`  Then:  zelto resume ${first.id} && zelto run ${first.id}`);
    if (stalled.length > 1) {
      console.log(`  (还有 ${stalled.length - 1} 个停机切片：${stalled.slice(1).map((s) => s.id).join('、')})`);
    }
    return 0;
  }

  if (drafts.length > 0) {
    const first = drafts[0];
    console.log(`Next: ${first.kind} ${first.id} (draft)`);
    console.log(`  ${first.title}`);
    console.log(`  Action: ${draftShowCommand(first)}`);
    console.log(`  Then:  ${draftConfirmCommand(first)}`);
    if (drafts.length > 1) {
      console.log(`  (还有 ${drafts.length - 1} 个待确认草稿：${drafts.slice(1).map((d) => `${d.kind} ${d.id}`).join('、')})`);
    }
    return 0;
  }

  // 待签字 / 待合并排在状态排序之前。
  // 判据用签字请求的状态而不是切片状态 —— `completed` 同时表示「门禁过了」
  // 与「已签字」（ADR-018），只看状态会把早已签过的切片也报成待签字。
  const pendingActions = await collectPendingActions();

  if (pendingActions.sign.length > 0) {
    const first = pendingActions.sign[0];
    console.log(`Next: ${first.sliceId} (awaiting signature)`);
    console.log(`  ${first.title}`);
    console.log(`  Action: ${first.action}`);
    if (pendingActions.sign.length > 1) {
      console.log(`  (还有 ${pendingActions.sign.length - 1} 个待签字：${pendingActions.sign.slice(1).map((a) => a.sliceId).join('、')})`);
    }
    return 0;
  }

  if (pendingActions.merge.length > 0) {
    const first = pendingActions.merge[0];
    console.log(`Next: ${first.sliceId} (signed, awaiting merge)`);
    console.log(`  ${first.title}`);
    console.log(`  Action: ${first.action}`);
    if (pendingActions.merge.length > 1) {
      console.log(`  (还有 ${pendingActions.merge.length - 1} 个待合并：${pendingActions.merge.slice(1).map((a) => a.sliceId).join('、')})`);
    }
    return 0;
  }

  if (pendingActions.requestSign.length > 0) {
    const first = pendingActions.requestSign[0];
    console.log(`Next: ${first.sliceId} (gate passed, needs signature request)`);
    console.log(`  ${first.title}`);
    console.log(`  Action: ${first.action}`);
    if (pendingActions.requestSign.length > 1) {
      console.log(`  (还有 ${pendingActions.requestSign.length - 1} 个待发起签字：${pendingActions.requestSign.slice(1).map((a) => a.sliceId).join('、')})`);
    }
    return 0;
  }

  if (list.length === 0) {
    console.log('No slices found. Create one to get started.');
    return 0;
  }

  const priority: Array<string> = ['draft', 'clarifying', 'frozen', 'running'];
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

// ─── suggest ──────────────────────────────────────────────────────────────────

register('suggest', async () => {
  const list = await store.list();
  const drafts = await collectPlanningDrafts(ZELTO_DIR);

  if (list.length === 0 && drafts.length === 0) {
    console.log(formatSection('Welcome to zelto!'));
    console.log(`  ${colors.cyan('zelto init')}     Initialize a project`);
    console.log(`  ${colors.cyan('zelto help')}     Show all commands`);
    console.log(`  ${colors.cyan('zelto create')}   Create your first slice`);
    console.log(`\n  ${colors.dim('Or try the AI pipeline:')}`);
    console.log(`  ${colors.cyan('zelto require')}   Create a requirement document`);
    return 0;
  }

  // 规划草稿先行：上游没确认，下游切片跑了也白跑。
  // 只读展示，不改状态，确认入口是 show → confirm（G-5 同一入口）。
  if (drafts.length > 0) {
    console.log(formatSection('Planning Drafts'));
    for (const d of drafts) {
      console.log(`  ${colors.bold(`${d.kind} ${d.id}`)}`);
      console.log(`    ${colors.dim(d.title)}`);
      console.log(`    ${colors.cyan(draftShowCommand(d))}   → 看完再 ${colors.cyan(draftConfirmCommand(d))}`);
    }
  }

  // Check overall project state
  let suggested = drafts.length > 0;
  if (list.length > 0) {
    const stateCounts: Record<string, number> = {};
    for (const id of list) {
      try {
        const s = await store.read(id);
        stateCounts[s.state] = (stateCounts[s.state] ?? 0) + 1;
      } catch { /* skip */ }
    }

    console.log(formatSection('Project Overview'));
    console.log(`  ${colors.dim('Slices:')} ${list.length}`);
    for (const [state, count] of Object.entries(stateCounts)) {
      const colorFn: Record<string, (s: string) => string> = {
        draft: colors.yellow,
        clarifying: colors.blue,
        frozen: colors.magenta,
        running: colors.cyan,
        completed: colors.green,
        abandoned: colors.gray,
      };
      const fn = colorFn[state] ?? colors.dim;
      console.log(`    ${fn(`${state}: ${count}`)}`);
    }

    // 交付状态 —— `completed: 12` 说不清这 12 个里有多少真的进了主干。
    // 这里只给计数；具体是哪些切片、该敲哪条命令，归下面的待办段。
    const delivery = await collectCompletedSummary();
    if (delivery.total > 0) {
      console.log(formatSection('Delivery Status'));
      for (const status of DELIVERY_ORDER) {
        const count = delivery.counts[status];
        if (count === 0) continue;
        console.log(`    ${colors.dim(deliveryLabel(status))}  ${colors.bold(String(count))}`);
      }
    }

    // Check each slice and suggest next action
    console.log(formatSection('Suggested Actions'));

    // 待签字 / 待合并 / 待发起签字 —— 判据取自签字请求的状态，与 inbox、merge 同源。
    // 切片状态 `completed` 同时表示「门禁过了」与「已签字」（ADR-018），
    // 只按状态列会把早已签过的切片也报成待签字，所以 completed 不进状态分组。
    const pendingActions = await collectPendingActions();
    const printActions = (items: PendingAction[]) => {
      for (const a of items) {
        console.log(`  ${colors.bold(a.sliceId)}`);
        console.log(`    ${colors.dim(a.title)}`);
        console.log(`    ${colors.cyan(a.prepare)}`);
        console.log(`    ${colors.gray(a.action)}`);
        suggested = true;
      }
    };

    if (pendingActions.sign.length > 0) {
      console.log(formatSection('Awaiting Signature'));
      printActions(pendingActions.sign);
    }
    if (pendingActions.merge.length > 0) {
      console.log(formatSection('Awaiting Merge'));
      printActions(pendingActions.merge);
    }
    if (pendingActions.requestSign.length > 0) {
      console.log(formatSection('Needs Signature Request'));
      printActions(pendingActions.requestSign);
    }

    const priority: Array<{ state: string; action: string; prepare: string }> = [
      { state: 'draft', action: 'zelto check <id> && zelto freeze <id>', prepare: 'Check and freeze spec' },
      { state: 'clarifying', action: 'zelto clarify <id>', prepare: 'Answer clarification questions' },
      { state: 'frozen', action: 'zelto run <id> [--dry-run]', prepare: 'Execute slice' },
      { state: 'running', action: 'zelto events <id>', prepare: 'Monitor execution' },
    ];

    for (const p of priority) {
      for (const id of list) {
        try {
          const s = await store.read(id);
          if (s.state === p.state) {
            console.log(`  ${colors.bold(id)}`);
            console.log(`    ${colors.dim(s.title)}`);
            console.log(`    ${colors.cyan(p.prepare)}`);
            console.log(`    ${colors.gray(p.action.replaceAll('<id>', id))}`);
            suggested = true;
          }
        } catch { /* skip */ }
      }
    }

    if (!suggested) {
      // Check stalled slices
      const stalled: string[] = [];
      for (const id of list) {
        try {
          const s = await store.read(id);
          if (isSliceStalled(s)) stalled.push(id);
        } catch { /* skip */ }
      }
      if (stalled.length > 0) {
        console.log(`  ${colors.yellow(`${stalled.length} stalled slice(s):`)}`);
        for (const id of stalled) {
          console.log(`    ${colors.cyan(`zelto stall ${id}`)} — inspect and resolve`);
          console.log(`    ${colors.cyan(`zelto resume ${id}`)} — resume after resolution`);
        }
        suggested = true;
      }
    }
  }

  if (!suggested) {
    console.log(`  ${colors.green('All slices are up to date!')}`);
    console.log(`  ${colors.dim('Next: run')} ${colors.cyan('zelto next')} ${colors.dim('or check pipeline status:')} ${colors.cyan('zelto pipeline status')}`);
  }

  // Check for project-level items
  const hasInit = existsSync(ZELTO_DIR);
  if (!hasInit) {
    console.log(formatSection('Project Setup'));
    console.log(`  ${formatWarning('.zelto/ not initialized')}`);
    console.log(`  ${colors.cyan('zelto init')}`);
  }

  return 0;
});

// ─── init ────────────────────────────────────────────────────────────────────

register('init', async (args) => {
  const doForce = args.includes('--force');
  const withExamples = args.includes('--with-examples');

  if (existsSync(ZELTO_DIR) && !doForce) {
    console.log(`zelto init — ⚠️  .zelto/ already exists.`);
    console.log(`  Use --force to reinitialize (will re-scan project and regenerate config/policy).`);
    return 0;
  }

  // Full project initialization: scan + create .zelto/ + policy
  const { scanProject } = await import('../../core/project/scanner.js');
  const { initializeProject } = await import('../../core/project/initializer.js');

  const projectMap = scanProject(process.cwd());

  // Create .zelto/ directories
  const dirs = [join(ZELTO_DIR, 'slices'), join(ZELTO_DIR, 'events'), join(ZELTO_DIR, 'locks')];
  let created = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created++;
    }
  }

  // Initialize governance (config.yaml + policy.yaml)
  const result = await initializeProject(projectMap, { autoDetect: true, policyTemplate: 'default' }, { events });
  created += result.created.length;

  if (created === 0) {
    console.log(`zelto init — ✅ Already initialized.`);
  } else {
    console.log(`zelto init — ✅ Project "${projectMap.projectName}" initialized.`);
    for (const item of result.created) {
      console.log(`  ✅ ${item}`);
    }
  }

  // 老版本生成物被迁移了 —— 说清楚迁了什么（ADR-040）
  for (const item of result.migrated) {
    console.log(`  🔄 ${item.file}：${item.detail}`);
  }

  // 人手写的文件没动 —— 说清楚，否则人以为接管成了，其实门禁命令
  // 还是他自己写的那套（或 zelto 最初写的通用那套）。
  for (const item of result.skipped) {
    console.log(`  ⚠️  ${item}`);
  }

  // ── 基线切片 ──
  //
  // `zelto init` 与 `zelto project init` 必须走**同一条**登记路径
  // （ADR-039 §3）：接管既有项目时，现状要在第一条命令之后就被登记进追溯链，
  // 否则人先跑 init 再跑 project init，会看到两次不同的登记记录
  // （切片 id 相同、内容不同），追溯链就说不清了。
  const { registerBaselineSlices } = await import('../../core/project/baseline.js');
  const { created: createdBaselines } = await registerBaselineSlices(projectMap, {
    store,
    events,
    specsDir: 'specs/slices',
  });
  if (createdBaselines.length > 0) {
    console.log(`  ✅ 基线切片 ${createdBaselines.length} 片 —— 现有代码已登记为追溯链的起点`);
    for (const plan of createdBaselines) {
      console.log(`     · ${plan.id} — ${plan.moduleName === '.' ? '项目根目录' : plan.moduleName}`);
    }
  }

  // Create example slice if --with-examples
  if (withExamples) {
    const exampleId = 'example-hello-world';
    if (!(await store.exists(exampleId))) {
      const slice = store.create(exampleId, 'Example: Hello World', {
        writes: ['src/**/*.ts'],
        trace: { requirements: ['example-req'], contracts: [], tests: [] },
      });
      await store.write(slice);
      console.log(`  ✅ Example slice created: ${exampleId}`);

      // Write example spec
      const specPath = slice.spec.path;
      const specDir = specPath.substring(0, specPath.lastIndexOf('/'));
      if (!existsSync(specDir)) mkdirSync(specDir, { recursive: true });
      writeFileSync(specPath, `# Example: Hello World

## Purpose
An example slice to demonstrate zelto's workflow.

## Scope
- \`src/**/*.ts\`

## Acceptance Criteria
1. Create a simple hello-world module
2. Write a basic test
3. All tests pass

## Notes
This is an example. Replace with your actual slice.
`, 'utf-8');
      console.log(`  ✅ Example spec written: ${specPath}`);
    } else {
      console.log(`  ℹ️  Example slice already exists`);
    }
  }

  // Auto-install git hooks —— 只装进「被管理的项目」（见 hook-install.ts 的作用域规则）
  try {
    const { resolveHookInstallRoot } = await import('./hook-install.js');
    const scope = resolveHookInstallRoot(process.cwd());
    if (scope.root) {
      console.log(`\n  Installing git hooks (${scope.reason})...`);
      const { execSync } = await import('node:child_process');
      try {
        execSync(
          `node "${join(process.cwd(), 'dist', 'cli', 'index.js')}" hook --install`,
          { cwd: process.cwd(), timeout: 15000, stdio: 'pipe' },
        );
      } catch {
        // Hook install may fail if dist/ not built yet — non-fatal
        console.log(`  ℹ️  Auto-install hooks skipped. Run "zelto hook --install" manually.`);
      }
    } else {
      console.log(`\n  ℹ️  ${scope.reason}`);
    }
  } catch {
    // Non-fatal
  }

  console.log(`\n👉 Next: zelto project design`);
  return 0;
});

// ─── summary ─────────────────────────────────────────────────────────────────

register('summary', async () => {
  const f = getDefaultFormatter();
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
  } catch { /* ignore */ }

  const name = (pkg.name as string) ?? 'zelto';
  const version = (pkg.version as string) ?? '?';

  const distOk = existsSync('dist/cli/index.js');
  const distTestOk = existsSync('dist-test/tests');

  let gitBranch = '?';
  let gitCommit = '?';
  let gitDirty = false;
  try {
    gitBranch = readFileSync('.git/HEAD', 'utf-8').trim().replace('ref: refs/heads/', '');
    gitCommit = readFileSync(`.git/refs/heads/${gitBranch}`, 'utf-8').trim().slice(0, 7);
    const { execSync } = await import('node:child_process');
    const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 3000 });
    gitDirty = status.trim().length > 0;
  } catch { /* ignore */ }

  const coreModules: string[] = [];
  if (existsSync('src/core')) {
    for (const entry of readdirSync('src/core', { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(`src/core/${entry.name}/index.ts`)) {
        coreModules.push(entry.name);
      }
    }
  }

  const placeholderDirs: string[] = [];
  if (existsSync('src/core')) {
    for (const entry of readdirSync('src/core', { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const files = readdirSync(`src/core/${entry.name}`);
        if (files.length === 0 || files.every((f) => f === '.gitkeep')) {
          placeholderDirs.push(entry.name);
        }
      }
    }
  }

  f.out(`\n  ╭──────────────────────────────────────╮`);
  f.out(`  │  zelto project summary              │`);
  f.out(`  ╰──────────────────────────────────────╯`);
  f.out(``);
  f.out(`  Project:    ${name} v${version}`);
  f.out(`  Git:        ${gitBranch} @ ${gitCommit}${gitDirty ? ' (dirty)' : ''}`);
  f.out(`  Dist:       ${distOk ? '✅ compiled' : '❌ not compiled'}`);
  f.out(`  Test dist:  ${distTestOk ? '✅ compiled' : '❌ not compiled'}`);
  f.out(``);
  f.out(`  Core modules:`);
  if (coreModules.length > 0) {
    for (const m of coreModules) {
      f.out(`    - ${m}`);
    }
  }
  if (placeholderDirs.length > 0) {
    f.out(`  ⚠️  Placeholder dirs (empty):`);
    for (const d of placeholderDirs) {
      f.out(`    - ${d}`);
    }
  }

  f.out(``);
  const sliceList = await store.list();
  const sliceStates: Record<string, number> = {};
  for (const id of sliceList) {
    try {
      const s = await store.read(id);
      sliceStates[s.state] = (sliceStates[s.state] ?? 0) + 1;
    } catch { /* skip */ }
  }

  f.out(`  Slices:     ${sliceList.length}`);
  for (const [state, count] of Object.entries(sliceStates)) {
    f.out(`    ${state}: ${count}`);
  }

  // 交付状态 —— 状态计数说不清「有多少真的进了主干」，这里补一行人话汇总。
  const delivery = await collectCompletedSummary();
  if (delivery.total > 0) {
    f.out(`  Delivery:   ${deliverySummaryLine(delivery)}`);
  }

  let reworkLine = '';
  let cycleLine = '';
  let stallLine = '';
  if (sliceList.length > 0) {
    try {
      const metrics = new MetricsCollector(events);
      const report = await metrics.generateReport(sliceList);
      let totalRework = 0;
      let reworkCount = 0;
      let totalCycle = 0;
      let cycleCount = 0;
      let totalStalls = 0;
      for (const m of report.metrics) {
        if (m.name === 'rework_rate') { totalRework += m.value; reworkCount++; }
        else if (m.name === 'cycle_time') { totalCycle += m.value; cycleCount++; }
        else if (m.name === 'stall_counts') { totalStalls += m.value; }
      }
      reworkLine = reworkCount > 0 ? `    Rework rate:  ${(totalRework / reworkCount).toFixed(2)} avg` : '    Rework rate:  (no data)';
      cycleLine = cycleCount > 0 ? `    Avg cycle:    ${(totalCycle / cycleCount).toFixed(0)}s` : '    Avg cycle:    (no data)';
      stallLine = `    Total stalls: ${totalStalls}`;

      const audit = new AuditTrail(events);
      const sliceSummaries: string[] = [];
      for (const id of sliceList.slice(0, 10)) {
        try {
          const auditReport = await audit.forSlice(id);
          if (auditReport.totalEvents > 0) {
            const last = auditReport.entries[auditReport.entries.length - 1];
            sliceSummaries.push(`${id}: ${last.eventType}`);
          }
        } catch { /* skip */ }
      }
      f.out(``);
      f.out(`  Audit & Metrics:`);
      f.out(reworkLine);
      f.out(cycleLine);
      f.out(stallLine);
      f.out(``);
      f.out(`  Latest events:`);
      for (const s of sliceSummaries) {
        f.out(`    ${s}`);
      }
      if (sliceList.length > 10) {
        f.out(`    ... and ${sliceList.length - 10} more slices`);
      }
    } catch {
      f.out(`  (error reading metrics)`);
    }
  }
  return 0;
});

// ─── events ──────────────────────────────────────────────────────────────────

register('events', async (args) => {
  const [id] = args;
  const f = getDefaultFormatter();

  if (!id || id.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto events <slice-id> [--json] [--tail <N>]');
    return 1;
  }

  const isJson = args.includes('--json');
  const tailIdx = args.indexOf('--tail');
  const tailCount = tailIdx >= 0 ? parseInt(args[tailIdx + 1], 10) : 0;

  try {
    // Check if slice exists — EventStream.read() returns [] on ENOENT
    const sliceExists = await store.exists(id);
    if (!sliceExists) {
      if (isJson) {
        writeOutput({ sliceId: id, error: `Slice "${id}" not found`, events: [] }, undefined, { json: true });
      } else {
        f.out(`Slice "${id}" not found.`);
      }
      return 1;
    }

    const evts = await events.read(id);

    if (isJson) {
      const displayed = tailCount > 0 ? evts.slice(-tailCount) : evts;
      writeOutput(
        {
          sliceId: id,
          total: evts.length,
          displayed: tailCount > 0 ? Math.min(tailCount, evts.length) : evts.length,
          events: displayed,
        },
        undefined,
        { json: true },
      );
      return 0;
    }

    if (evts.length === 0) {
      f.out(`No events for slice "${id}".`);
      return 0;
    }

    const displayEvents = tailCount > 0 ? evts.slice(-tailCount) : evts;
    if (tailCount > 0) {
      f.out(`Events for "${id}" (showing last ${displayEvents.length} of ${evts.length}):`);
    } else {
      f.out(`Events for "${id}":`);
    }

    for (const e of displayEvents) {
      const ts = e.ts ? e.ts.slice(0, 19) : '?';
      f.out(`  [${ts}] ${e.type} (${e.actor})`);
      if (e.payload && Object.keys(e.payload).length > 0) {
        const payloadStr = JSON.stringify(e.payload, null, 4)
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')
          .trim();
        f.out(`    ${payloadStr}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      writeOutput({ sliceId: id, error: String(err), events: [] }, undefined, { json: true });
    } else {
      const msg = String(err);
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        f.out(`No events for slice "${id}".`);
        return 1;
      }
      f.error('READ_ERROR', `Error reading events for slice "${id}": ${msg}`);
    }
    return 1;
  }
  return 0;
});

// ─── help ────────────────────────────────────────────────────────────────────

register('help', async (args) => {
  const [specificCmd] = args;

  // zelto help <cmd> —— 从命令目录里取用法，**不执行**该命令。
  //
  // 以前这里是 handler(['--help'])，但多数命令不认 --help，
  // 于是 `zelto help run` 真的去跑 run，把 "--help" 当切片 id 去找，
  // 报 ENOENT 崩掉。help 是只读入口，不该有副作用。
  if (specificCmd && !specificCmd.startsWith('--')) {
    const info = findCommand(specificCmd);
    if (!info) {
      console.error(`Unknown command: ${specificCmd}`);
      console.error('Run "zelto help" for usage.');
      return 1;
    }
    console.log(`${colors.bold(usageOf(info))}`);
    console.log('');
    console.log(`  ${info.summary}`);
    if (info.detail) {
      console.log(`  ${colors.dim(info.detail)}`);
    }
    console.log('');
    console.log(`${colors.dim('Group:')} ${info.group}`);
    return 0;
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.bold('zelto — AI Programming Cockpit'));
  lines.push('');
  lines.push(colors.cyan('Usage:'));
  lines.push('  zelto <command> [options]');
  lines.push('');

  for (const { group, commands } of commandsByGroup()) {
    lines.push(`${colors.bold(`${group}:`)}`);
    const labels = commands.map((c) => (c.args ? `${c.name} ${c.args}` : c.name));
    const width = Math.max(...labels.map((l) => l.length));
    commands.forEach((c, i) => {
      const label = labels[i].padEnd(width);
      const tail = c.detail ? `  ${colors.dim(c.detail)}` : '';
      lines.push(`  ${label}  ${c.summary}${tail}`);
    });
    lines.push('');
  }

  lines.push(colors.dim('Configuration: .zelto/config.yaml'));
  lines.push(colors.dim('Policy:        policy/policy.yaml'));
  console.log(lines.join('\n'));
  return 0;
});
// ─── completion ──────────────────────────────────────────────────────────────

// `completion` 的实现在 completion.ts —— 那份才是真正生成补全脚本的。
// （这里曾经还注册过一份，是被 completion.ts 覆盖掉的死代码。）

// ─── hook ────────────────────────────────────────────────────────────────
//
// 实现搬到 hook-install.ts：git hooks + Claude Code PreToolUse 钩子（ADR-014）。

register('hook', async (args) => {
  const { hookCommand } = await import('./hook-install.js');
  return hookCommand(args);
});

// ─── reservation ────────────────────────────────────────────────────────────
//
// 写集预约的查看与释放（C9）。

register('reservation', async (args) => {
  const { reservationCommand } = await import('./reservation.js');
  return reservationCommand(args);
});

// ─── stall ───────────────────────────────────────────────────────────────────

/**
 * `zelto stall --reap`：批量把死切片退回 `frozen`（ADR-053）。
 *
 * 「死切片」= 状态还停在 `running`，但 agent 早就挂了 —— 它带停机分类，
 * 且不是提问回路（`agent_question` 的 agent 还活着，只是等人数码）。
 *
 * **为什么是显式的批量命令**：批量改状态的动作必须显式（ADR-047 §6）。
 * 这条命令只把状态掰回「可跑」，不动停机分类，也不碰预约 ——
 * 停机这件事本身仍然成立，人还是得逐片 `zelto resume` 走正式流程。
 */
async function reapDeadSlicesCommand(options: { isJson: boolean; dryRun: boolean }): Promise<number> {
  const allIds = await store.list();
  const slices: SliceData[] = [];
  for (const sid of allIds) {
    const s = await store.read(sid).catch(() => null);
    if (s) slices.push(s);
  }

  const dead = findDeadSlices(slices);

  if (options.isJson) {
    if (options.dryRun) {
      console.log(JSON.stringify({ dryRun: true, dead, reaped: [] }, null, 2));
      return 0;
    }
    const reaped = await reapDeadSlices(store, events, dead.map((d) => d.sliceId), {
      actor: 'human',
      reason: '清理死切片：agent 已停机，切片卡在 running',
    });
    console.log(JSON.stringify({ dead, reaped }, null, 2));
    return 0;
  }

  if (dead.length === 0) {
    console.log('没有死切片（没有卡在 running 的停机切片）。');
    return 0;
  }

  console.log(`死切片（卡在 running，agent 已停机）：${dead.length} 个`);
  for (const d of dead) {
    console.log(`  ${d.sliceId.padEnd(20)} ${d.stallClass.padEnd(25)} ${d.lastRunAt ?? '(无运行记录)'}`);
  }

  if (options.dryRun) {
    console.log('');
    console.log('--dry-run：以上是将会被清理的切片，没有改动任何状态。');
    return 0;
  }

  const reaped = await reapDeadSlices(store, events, dead.map((d) => d.sliceId), {
    actor: 'human',
    reason: '清理死切片：agent 已停机，切片卡在 running',
  });

  console.log('');
  console.log(`↩️  已清理 ${reaped.length} 个死切片（running → frozen）`);
  for (const r of reaped) {
    if (r.reverted) {
      console.log(`  ${r.sliceId}: ${r.from} → ${r.to}（stall: ${r.stallClass} 保留）`);
    } else {
      console.log(`  ${r.sliceId}: 状态未变（${r.from}），已记录事件`);
    }
  }
  console.log('');
  console.log('停机分类仍保留 —— 逐片处理：zelto resume <id> → zelto run <id>');
  console.log('写集预约不受影响（C9）：确认现场后再 zelto reservation release <id>。');
  return 0;
}

register('stall', async (args) => {
  const [id] = args;
  const showAutoResolved = args.includes('--auto-resolved');
  const doReap = args.includes('--reap');
  const isJson = args.includes('--json');
  const dryRun = args.includes('--dry-run');

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: zelto stall [id] [--auto-resolved] [--json]');
    console.log('       zelto stall --reap [--dry-run] [--json]   批量清理死切片（ADR-053）');
    console.log('');
    console.log('死切片 = 状态卡在 running 且带停机分类（提问回路 agent_question 除外）。');
    console.log('--reap 把它们退回 frozen；停机分类保留，人仍需逐片 zelto resume。');
    return 0;
  }

  // ── zelto stall --reap：批量清理死切片（ADR-053）────────────────────
  //
  // 「死切片」= 状态还停在 `running`，但 agent 早就挂了。
  //
  // 为什么要有这条命令：ADR-047 让死切片不再阻塞别人，但它们仍然占着
  // `zelto status` 的「running」计数，人得逐片 `zelto resume` 才能清掉。
  //
  // 为什么不能塞进 `zelto halt --rollback`：那扫的是「持有预约的进程已死」
  // （批次崩了）。死切片**没有预约** —— agent 挂了，预约已释放。
  // 两个不同的问题，不该混在一条命令里。
  if (doReap) {
    return reapDeadSlicesCommand({ isJson, dryRun });
  }

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
        // 预算耗尽要在这里就说清 —— 否则人 resume 完才发现「第一次失败就停机」
        // （ADR-052）
        const maxRetries = loadConfig().agent.maxRetries ?? 2;
        if (slice.stall.autoResolved >= maxRetries) {
          console.log(
            `Retry budget:   EXHAUSTED (${slice.stall.autoResolved}/${maxRetries}) —— 重跑后第一次失败就会停机`,
          );
          console.log(`  恢复自动重试：zelto resume ${id} --reset-retry`);
        }
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
    } catch { /* skip */ }
  }

  if (stalled.length === 0) {
    console.log('No stalled slices found.');
    return 0;
  }

  console.log('Stalled slices:');
  for (const s of stalled) {
    console.log(`  ${s.id.padEnd(20)} ${s.stallClass.padEnd(25)} auto-resolved: ${s.autoResolved}`);
  }

  // 死切片单独点出来 —— 它们的状态是 `running`，混在停机列表里看不出
  // 「这个还在卡着、那个只是等着处理」的差别（ADR-053）。
  const dead = findDeadSlices(await Promise.all(
    (await store.list()).map((sid) => store.read(sid).catch(() => null)),
  ).then((list) => list.filter((s): s is SliceData => s !== null)));

  if (dead.length > 0) {
    console.log('');
    console.log(`死切片（卡在 running，agent 已停机）：${dead.length} 个`);
    for (const d of dead) {
      console.log(`  ${d.sliceId.padEnd(20)} ${d.stallClass.padEnd(25)} ${d.lastRunAt ?? '(无运行记录)'}`);
    }
    console.log('  清理：zelto stall --reap');
  }

  return 0;
});

// ─── resume ──────────────────────────────────────────────────────────────────

register('resume', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto resume <slice-id> [--skip] [--abandon] [--reset-retry]');
    return 1;
  }

  const skip = args.includes('--skip');
  const abandon = args.includes('--abandon');
  const resetRetry = args.includes('--reset-retry');

  try {
    await store.read(id);
  } catch {
    console.error(`Slice "${id}" not found.`);
    return 1;
  }

  const scheduler = new Scheduler(store, events, loadPolicyConfig());

  // 重置自动重试预算前，先把当前用量说清楚 —— 人得知道自己在重置什么。
  const before = await store.read(id);
  const autoResolvedBefore = before.stall.autoResolved;

  try {
    const result = await scheduler.resume(id, { skip, abandon, resetRetry });

    // 顺序：先报预算，再报这次动作的结果。
    // 「预算已重置」是这次动作**唯一**的效果，混在一堆话里容易被忽略。
    if (resetRetry) {
      if (result.retryBudgetReset) {
        console.log(
          `  自动重试预算已重置（${autoResolvedBefore} → 0）—— 本次重跑会重新获得自动重试`,
        );
      } else {
        console.log('  自动重试预算本来就是 0，无需重置');
      }
    } else if (autoResolvedBefore > 0) {
      // 预算已用尽却不重置 —— 人重跑后会发现「第一次失败就停机」，
      // 而原因在这里。不说，等于让下一个 agent 轮次白跑。
      const maxRetries = loadConfig().agent.maxRetries ?? 2;
      if (autoResolvedBefore >= maxRetries) {
        console.log(
          `  ⚠️ 自动重试预算已用尽（${autoResolvedBefore}/${maxRetries}）—— 重跑后第一次失败就会停机`,
        );
        console.log(
          `     修好问题后若要恢复自动重试：zelto resume ${id} --reset-retry`,
        );
      }
    }

    if (abandon) {
      console.log(`zelto resume ${id} --abandon -- Slice abandoned`);
    } else if (skip) {
      console.log(`zelto resume ${id} --skip -- Stall resolved, slice not re-executed`);
    } else if (before.stall.class !== null) {
      console.log(`zelto resume ${id} -- Slice resumed for re-execution`);
    }
    // 没有停机可恢复、也没别的动作时，只报预算那一句就够了 ——
    // 说「已恢复以便重跑」是假话（它本来就没停机）。
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    return 1;
  }

  return 0;
});

// ─── status ──────────────────────────────────────────────────────────────────

register('status', async (args) => {
  const isJson = args.includes('--json');
  const watchMode = args.includes('--watch');

  const SESSIONS_DIR = join(ZELTO_DIR, 'sessions');
  const f = getDefaultFormatter();

  async function showStatus(): Promise<number> {
    const allIds = await store.list();
    const activeSlices: Array<{
      id: string; title: string; state: string; runningSince?: string;
      elapsed?: string; sessionId?: string; exitCode?: number | null;
    }> = [];

    for (const id of allIds) {
      try {
        const s = await store.read(id);
        if (s.state === 'running') {
          activeSlices.push({
            id, title: s.title, state: s.state,
            runningSince: s.runs.length > 0 ? s.runs[s.runs.length - 1].at : undefined,
          });
        }
      } catch { /* skip */ }
    }

    // Check session persistence for running sessions
    if (existsSync(SESSIONS_DIR)) {
      for (const file of readdirSync(SESSIONS_DIR)) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'));
          if (data.status === 'running') {
            const existing = activeSlices.find((a) => a.id === data.sliceId);
            const elapsed = data.startedAt
              ? formatElapsed(new Date(data.startedAt).getTime())
              : '?';
            if (existing) {
              existing.sessionId = data.sessionId;
              existing.elapsed = elapsed;
              existing.runningSince = data.startedAt;
            } else {
              activeSlices.push({
                id: data.sliceId,
                title: data.sliceId,
                state: 'running',
                sessionId: data.sessionId,
                elapsed,
                runningSince: data.startedAt,
              });
            }
          }
        } catch { /* skip unreadable */ }
      }
    }

    if (isJson) {
      f.data({
        timestamp: new Date().toISOString(),
        activeCount: activeSlices.length,
        sessions: activeSlices,
      });
      return 0;
    }

    if (activeSlices.length === 0) {
      f.out(`  ${colors.green('✓ No active agent sessions')}`);
      return 0;
    }

    f.out(`  ${colors.bold(`Active agent sessions (${activeSlices.length}):`)}`);
    f.out('');
    for (const slice of activeSlices) {
      f.out(`  ${colors.cyan(slice.id)}`);
      f.out(`    Title:    ${slice.title}`);
      f.out(`    Status:   ${colors.green('running')}`);
      if (slice.elapsed) {
        f.out(`    Elapsed:  ${slice.elapsed}`);
      }
      if (slice.sessionId) {
        f.out(`    Session:  ${slice.sessionId}`);
      }

      // Show recent output from session file
      if (slice.sessionId) {
        const sessionPath = join(SESSIONS_DIR, `${slice.sessionId}.json`);
        if (existsSync(sessionPath)) {
          try {
            const data = JSON.parse(readFileSync(sessionPath, 'utf-8'));
            const recentLines = data.output?.slice(-5) ?? [];
            if (recentLines.length > 0) {
              f.out(`    Recent output:`);
              for (const line of recentLines) {
                const trimmed = line.trim().slice(0, 120);
                if (trimmed) {
                  f.out(`      ${colors.dim(trimmed)}`);
                }
              }
            }
          } catch { /* skip */ }
        }
      }
      f.out('');
    }

    if (watchMode) {
      f.out(`  ${colors.dim('(--watch mode: refresh every 5s. Ctrl+C to stop)')}`);
    }
    return 0;
  }

  function formatElapsed(startMs: number): string {
    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  if (watchMode) {
    const initial = await showStatus();
    if (initial !== 0) return initial;

    return new Promise<number>(() => {
      const interval = setInterval(async () => {
        process.stdout.write('\x1b[2J\x1b[0f');
        await showStatus();
      }, 5000);

      process.on('SIGINT', () => {
        clearInterval(interval);
        process.exit(0);
      });
    });
  }

  return showStatus();
});
