// Info, help, and utility commands: next, init, summary, events, help, hook, stall, resume

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Scheduler } from '../../core/sched/engine.js';
// ADR-086：续跑编排下沉到 core —— CLI 与 Web 调同一份（C3：判定不许分叉）
import { resumeSlice } from '../../core/lifecycle/resume.js';
import { isSliceStalled, findDeadSlices, findOrphanShells, reapDeadSlices } from '../../core/stall/index.js';
import {
  classifyLivenessAsync,
  readSessionLiveness,
  readSliceLivenessRecord,
  readRecoveries,
  lastOutputLine,
  readEventProgress,
} from '../../core/activity/index.js';
import { isProcessAlive, isProcessTreeAlive } from '../../core/sched/index.js';
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
import { commandsByGroup, findCommand, usageOf, groupCommandIndex, paramListOf, ESSENTIAL_GROUPS, COMMAND_CATALOG, COMMAND_GROUPS, type CommandInfo } from './catalog.js';
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

  // 待重跑**排最前**（ADR-094 §5.1）。
  //
  // 为什么压在签字前面：
  //   - 待签字的是**已经做完**的片 —— 只差人点一下；
  //   - 待重跑的是**人刚说过「要改」**的片 —— 还没做完，带着意见。
  //
  // 人刚把控制权要回去改东西 —— 那就是眼下最该做的事。
  // 而签字队列里的片已经躺了不知道多久，多等一天少一天，
  // 退回的这片每多放一天就多错一天。
  if (pendingActions.rerun.length > 0) {
    const first = pendingActions.rerun[0];
    console.log(`Next: ${first.sliceId} (sent back for rework)`);
    console.log(`  ${first.title}`);
    console.log(`  Action: ${first.action}`);
    if (pendingActions.rerun.length > 1) {
      console.log(`  (还有 ${pendingActions.rerun.length - 1} 个待重跑：${pendingActions.rerun.slice(1).map((a) => a.sliceId).join('、')})`);
    }
    return 0;
  }

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

    if (pendingActions.rerun.length > 0) {
      console.log(formatSection('Sent Back For Rework'));
      printActions(pendingActions.rerun);
    }
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

    // 已经在「Sent Back For Rework」里列过的切片不再按状态重复列 ——
    // 那一条的提示更准（带着「人说了什么」的上下文），
    // 泛泛的「Execute slice」反而把那条信息盖掉了。
    const alreadyShown = new Set(pendingActions.rerun.map((a) => a.sliceId));

    for (const p of priority) {
      for (const id of list) {
        if (alreadyShown.has(id)) continue;
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

// ─── help ────────────────────────────────────────────────────────────────────
// v3-help-system：L1（顶层概览）→ L2（命令级说明）→ L3（参数/选项级详解）
//
// - L1 默认只显示 ESSENTIAL_GROUPS（核心切片 + 项目管理），`--all` 展开全部组，
//   且每条命令带 L3 参数清单（验收标准 2/3）。
// - L2 按命令名定位：用法行 + 选项列表（验收标准 1）。
// - L3 按 group/command/parameter 定位：参数名 + 描述 + 约束/默认值（验收标准 1/4）。
// - `--help` / `-h` 与当前层级自适应：直接渲染当前层级（去掉旗标后同层级输出相等，验收标准 5）。
// - 组索引复用 catalog.ts 的 groupCommandIndex / commandsInGroup / paramListOf（验收标准 6）。
// - 未知组/命令/参数给可识别提示且退出 0、不崩溃（验收标准 8）。
// - 既有输出不丢失：L1 全量仍含全部组与命令，L2 保留用法/说明/detail/分组（验收标准 7）。
// - 只读入口：不写任何状态（C1/C4），不调模型（C3）。

export type HelpLevel = 'L1' | 'L2' | 'L3';

export interface ResolvedHelpPath {
  level: HelpLevel;
  group?: string;
  command?: string;
  param?: string;
  error?: string;
}

/** L1 顶层概览：默认仅 ESSENTIAL_GROUPS，`--all` 展开全部组且每条命令带 L3 参数 */
export function renderL1Overview(
  catalog: CommandInfo[] = COMMAND_CATALOG,
  opts: { all?: boolean } = {},
): string {
  const showAll = opts.all === true;
  const groups = showAll
    ? groupCommandIndex(catalog).groups
    : [...ESSENTIAL_GROUPS];
  const lines: string[] = [];
  lines.push('');
  lines.push(colors.bold('zelto — AI Programming Cockpit'));
  lines.push('');
  lines.push(colors.cyan('Usage:'));
  lines.push('  zelto <command> [options]');
  lines.push('');
  for (const group of groups) {
    const cmds = catalog.filter((c) => c.group === group);
    if (cmds.length === 0) continue;
    lines.push(`${colors.bold(`${group}:`)}`);
    const labels = cmds.map((c) => (c.args ? `${c.name} ${c.args}` : c.name));
    const width = Math.max(...labels.map((l) => l.length));
    cmds.forEach((c, i) => {
      const label = labels[i].padEnd(width);
      const tail = c.detail ? `  ${colors.dim(c.detail)}` : '';
      lines.push(`  ${label}  ${c.summary}${tail}`);
      if (showAll) {
        for (const p of paramListOf(c)) {
          const constraint = p.constraint ? `（${p.constraint}）` : '';
          lines.push(`      - ${p.name}: ${p.description}${constraint}`);
        }
      }
    });
    lines.push('');
  }
  if (!showAll) {
    lines.push(colors.dim('Run "zelto help --all" for all groups and parameters.'));
  }
  lines.push(colors.dim('Run "zelto help <command>" for command help, "zelto help <command> <param>" for parameter help.'));
  lines.push(colors.dim('Use ".." to go up, "top" to return to overview.'));
  lines.push(colors.dim('Configuration: .zelto/config.yaml'));
  lines.push(colors.dim('Policy:        policy/policy.yaml'));
  return lines.join('\n');
}

/** L2 命令级说明：命令名 + 用途 + 用法行 + 选项列表；未知命令返回 null */
export function renderL2Command(
  cmdName: string,
  catalog: CommandInfo[] = COMMAND_CATALOG,
): string | null {
  const info = catalog.find((c) => c.name === cmdName);
  if (!info) return null;
  const lines: string[] = [];
  lines.push(`${colors.bold(usageOf(info))}`);
  lines.push('');
  lines.push(`  ${info.summary}`);
  if (info.detail) {
    lines.push(`  ${colors.dim(info.detail)}`);
  }
  lines.push('');
  lines.push('  选项:');
  for (const p of paramListOf(info)) {
    const constraint = p.constraint ? `（${p.constraint}）` : '';
    lines.push(`    ${p.name}: ${p.description}${constraint}`);
  }
  lines.push('');
  lines.push(`${colors.dim('Group:')} ${info.group}`);
  return lines.join('\n');
}

/** L3 参数级详解：参数名 + 描述 + 约束/默认值；找不到返回 null */
export function renderL3Param(
  cmdName: string,
  paramName: string,
  catalog: CommandInfo[] = COMMAND_CATALOG,
): string | null {
  const info = catalog.find((c) => c.name === cmdName);
  if (!info) return null;
  const norm = (s: string) => s.replace(/^-+/, '').toLowerCase();
  const params = paramListOf(info);
  const hit = params.find((p) => p.name === paramName || norm(p.name) === norm(paramName));
  if (!hit) return null;
  const lines: string[] = [];
  lines.push(`${colors.bold(`${usageOf(info)} ${hit.name}`)}`);
  lines.push('');
  lines.push(`  参数: ${hit.name}`);
  lines.push(`  描述: ${hit.description}`);
  lines.push(`  约束/默认值: ${hit.constraint ?? '（无）'}`);
  lines.push('');
  lines.push(`${colors.dim('Command:')} ${info.name}  ${colors.dim('Group:')} ${info.group}`);
  return lines.join('\n');
}

/**
 * 按层级定位参数（验收标准 4 的定位解析函数）。
 *
 * 口径（纯映射，不读状态）：
 * - [] / ["top"] → L1
 * - [".."] → L2（从 L3 上一层；单测按字面断言）
 * - [cmd]（命令名）→ L2；[group]（组名）→ L1（该组过滤）
 * - [group, cmd] → L2；[cmd, param] → L3
 * - [group, cmd, param] → L3
 * - 其余（含多余 ".." / "top" 混写）按 "top 重置、.. 退一层" 归一后再判；判不出给 error。
 */
export function resolveHelpPath(
  segments: string[],
  catalog: CommandInfo[] = COMMAND_CATALOG,
): ResolvedHelpPath {
  const idx = groupCommandIndex(catalog);
  const isGroup = (s: string) => idx.groups.includes(s);
  const isCmd = (s: string) => Boolean(idx.byCommand[s]);
  const isParam = (cmd: string, p: string) => {
    const info = idx.byCommand[cmd];
    if (!info) return false;
    const norm = (s: string) => s.replace(/^-+/, '').toLowerCase();
    return paramListOf(info).some((x) => x.name === p || norm(x.name) === norm(p));
  };

  if (segments.length === 0) return { level: 'L1' };
  if (segments.length === 1 && segments[0] === 'top') return { level: 'L1' };
  if (segments.length === 1 && segments[0] === '..') return { level: 'L2' };

  // 含 top/.. 的多段：top 重置、.. 退一层后重判
  if (segments.includes('top') || segments.includes('..')) {
    const stack: string[] = [];
    for (const s of segments) {
      if (s === 'top') stack.length = 0;
      else if (s === '..') stack.pop();
      else stack.push(s);
    }
    if (stack.length === 0) return { level: 'L1' };
    return resolveHelpPath(stack, catalog);
  }

  if (segments.length === 1) {
    const [a] = segments;
    if (isCmd(a)) return { level: 'L2', command: a, group: idx.byCommand[a].group };
    if (isGroup(a)) return { level: 'L1', group: a };
    return { level: 'L1', error: `未知命令或分组: ${a}` };
  }
  if (segments.length === 2) {
    const [a, b] = segments;
    if (isGroup(a) && isCmd(b) && idx.byCommand[b].group === a) {
      return { level: 'L2', group: a, command: b };
    }
    if (isCmd(a) && isParam(a, b)) {
      return { level: 'L3', group: idx.byCommand[a].group, command: a, param: b };
    }
    if (isGroup(a) && isCmd(b)) {
      return { level: 'L2', group: a, command: b };
    }
    if (isCmd(a)) {
      return { level: 'L2', command: a, group: idx.byCommand[a].group, error: `未知参数: ${b}` };
    }
    return { level: 'L1', error: `未知定位路径: ${segments.join('/')}` };
  }
  if (segments.length === 3) {
    const [a, b, c] = segments;
    if (isGroup(a) && isCmd(b) && isParam(b, c)) {
      return { level: 'L3', group: a, command: b, param: c };
    }
    if (isCmd(a)) {
      return { level: 'L2', command: a, group: idx.byCommand[a].group, error: `未知定位路径: ${segments.join('/')}` };
    }
    return { level: 'L1', error: `未知定位路径: ${segments.join('/')}` };
  }
  return { level: 'L1', error: `未知定位路径: ${segments.join('/')}` };
}

/**
 * 与当前层级自适应的 --help/-h 文本（验收标准 5）。
 * 口径：直接等于对应层级的帮助文本（调用方去掉旗标后渲染同一层级即相等）。
 */
export function helpTextForLevel(
  level: HelpLevel,
  command?: string,
  param?: string,
  catalog: CommandInfo[] = COMMAND_CATALOG,
): string {
  if (level === 'L2' && command) {
    return renderL2Command(command, catalog) ?? `未知命令: ${command}`;
  }
  if (level === 'L3' && command && param) {
    return renderL3Param(command, param, catalog) ?? `未知参数: ${command} ${param}`;
  }
  return renderL1Overview(catalog);
}

register('help', async (args) => {
  const showAll = args.includes('--all');
  // --help/-h 自适应：去掉旗标后按当前层级渲染（输出与同层级文本相等）
  const positionals = args.filter((a) => a !== '--help' && a !== '-h' && a !== '--all');
  // 支持 group/command/param 写成一个 "a/b/c" 参数或拆开写
  const segments = positionals.flatMap((p) => p.split('/').filter((s) => s.length > 0));

  // zelto help <cmd> —— 从命令目录里取用法，**不执行**该命令。
  //
  // 以前这里是 handler(['--help'])，但多数命令不认 --help，
  // 于是 `zelto help run` 真的去跑 run，把 "--help" 当切片 id 去找，
  // 报 ENOENT 崩掉。help 是只读入口，不该有副作用。
  if (segments.length === 0) {
    console.log(renderL1Overview(COMMAND_CATALOG, { all: showAll }));
    return 0;
  }

  const resolved = resolveHelpPath(segments, COMMAND_CATALOG);

  if (resolved.level === 'L1' && !resolved.error) {
    // 单组名：过滤到该组（仍是 L1 形态）
    if (resolved.group) {
      const filtered = COMMAND_CATALOG.filter((c) => c.group === resolved.group);
      console.log(renderL1Overview(filtered, { all: true }));
      return 0;
    }
    console.log(renderL1Overview(COMMAND_CATALOG, { all: showAll }));
    return 0;
  }

  if (resolved.level === 'L2' && resolved.command && !resolved.error) {
    const text = renderL2Command(resolved.command, COMMAND_CATALOG);
    if (text) {
      console.log(text);
      return 0;
    }
  }

  if (resolved.level === 'L3' && resolved.command && resolved.param && !resolved.error) {
    const text = renderL3Param(resolved.command, resolved.param, COMMAND_CATALOG);
    if (text) {
      console.log(text);
      return 0;
    }
  }

  // 数据不完整或检索目标不存在：可识别提示且退出 0、不崩溃（验收标准 8）。
  // 注：历史行为未知命令退出 1；v3 规格要求退出 0（提示而非失败），此处按规格走。
  const hint = resolved.error ?? `未知定位路径: ${segments.join('/')}`;
  console.log(`${hint}`);
  console.log('用法: zelto help [--all] [<command> [<param>]]，或 zelto help <group>/<command>/<param>；.. 返回上层，top 回顶层。');
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
 * 另外认**空壳**（D-30）：状态 running、**没有任何停机分类**、
 * 会话/任务文件却没有活人管（无 pid 或 pid 已死、或心跳早过阈值）。
 * 典型成因是 `--detach` 后 CLI 主进程退出，后台监视器一起被杀，
 * 没人写收尾 —— 文件永远停在 running。旧判据只认「带停机分类」，
 * 所以这类空壳永远清不掉。
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
  const orphans = findOrphanShells(slices, process.cwd(), isProcessAlive);
  const allIdsToReap = [...dead.map((d) => d.sliceId), ...orphans.map((o) => o.sliceId)];
  const reapOptions = {
    actor: 'human',
    reason: '清理死切片：agent 已停机，切片卡在 running',
    includeOrphans: { projectRoot: process.cwd(), isProcessAlive },
  };

  if (options.isJson) {
    if (options.dryRun) {
      console.log(JSON.stringify({ dryRun: true, dead, orphans, reaped: [] }, null, 2));
      return 0;
    }
    const reaped = await reapDeadSlices(store, events, allIdsToReap, reapOptions);
    const tasksClosed = closeOrphanTasks(allIdsToReap);
    console.log(JSON.stringify({ dead, orphans, reaped, tasksClosed }, null, 2));
    return 0;
  }

  if (dead.length === 0 && orphans.length === 0) {
    console.log('没有死切片（没有卡在 running 的停机切片或空壳）。');
    return 0;
  }

  if (dead.length > 0) {
    console.log(`死切片（卡在 running，agent 已停机）：${dead.length} 个`);
    for (const d of dead) {
      console.log(`  ${d.sliceId.padEnd(20)} ${d.stallClass.padEnd(25)} ${d.lastRunAt ?? '(无运行记录)'}`);
    }
  }
  if (orphans.length > 0) {
    if (dead.length > 0) console.log('');
    console.log(`空壳切片（卡在 running，无停机分类，但现场无人在管）：${orphans.length} 个`);
    for (const o of orphans) {
      const badge = o.liveness.state === 'dead' ? '💀 dead' : '⚠️ stale';
      const wd = o.escalated ? '（已上报）' : o.recoveries > 0 ? `（自愈过 ${o.recoveries} 次）` : '';
      console.log(`  ${o.sliceId.padEnd(20)} ${badge.padEnd(10)} ${o.liveness.reason}${wd}`);
    }
  }

  if (options.dryRun) {
    console.log('');
    console.log('--dry-run：以上是将会被清理的切片，没有改动任何状态。');
    return 0;
  }

  const reaped = await reapDeadSlices(store, events, allIdsToReap, reapOptions);

  // 任务文件同步：切片已退回 frozen，任务文件还写着 running 就是第二层谎言
  // （`zelto tasks` 会继续把它当在跑）。这里只改状态字段，不删文件 ——
  // 失败现场（exitCode 为空、输出为空）本身就是要给人看的信息。
  const closedTasks = closeOrphanTasks(allIdsToReap);

  console.log('');
  console.log(`↩️  已清理 ${reaped.length} 个死切片（running → frozen）`);
  for (const r of reaped) {
    if (r.reverted) {
      const note = r.stallClass === 'orphan_shell'
        ? '（原为空壳，无停机分类）'
        : `（stall: ${r.stallClass} 保留）`;
      console.log(`  ${r.sliceId}: ${r.from} → ${r.to}${note}`);
    } else {
      console.log(`  ${r.sliceId}: 状态未变（${r.from}），已记录事件`);
    }
  }
  if (closedTasks > 0) {
    console.log(`  同时收尾 ${closedTasks} 个还写着 running 的任务文件（→ failed）。`);
  }
  console.log('');
  console.log('停机分类仍保留 —— 逐片处理：zelto resume <id> → zelto run <id>');
  console.log('写集预约不受影响（C9）：确认现场后再 zelto reservation release <id>。');
  return 0;
}

/**
 * 把被清理切片名下还写着 `running` 的任务文件收尾成 `failed`。
 *
 * 只改状态与时间戳 —— **不删文件**：空输出 / 空 exitCode 的现场本身就是
 * 「监视器被杀、没人收尾」的证据，删掉等于毁掉追溯（C4 的精神）。
 * 返回改了几个。
 */
function closeOrphanTasks(sliceIds: string[]): number {
  const wanted = new Set(sliceIds);
  if (wanted.size === 0) return 0;
  const dir = join(ZELTO_DIR, 'tasks');
  if (!existsSync(dir)) return 0;
  let closed = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = join(dir, f);
    try {
      const task = JSON.parse(readFileSync(p, 'utf-8')) as {
        sliceId?: string; status?: string; completedAt?: string; reason?: string;
      };
      if (!task.sliceId || !wanted.has(task.sliceId) || task.status !== 'running') continue;
      task.status = 'failed';
      task.completedAt = new Date().toISOString();
      task.reason = 'zelto stall --reap：切片已退回 frozen，任务不再在跑';
      writeFileSync(p, JSON.stringify(task, null, 2), 'utf-8');
      closed++;
    } catch { /* 坏文件跳过 */ }
  }
  return closed;
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
    console.log('空壳   = 状态卡在 running、无停机分类，但进程已死或心跳早过阈值（D-30）。');
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
      const isShell = slice.state === 'running' && slice.stall.class === null;
      if (!isSliceStalled(slice) && !showAutoResolved && !isShell) {
        console.log(`Slice "${id}" is not stalled.`);
        return 0;
      }
      console.log(`Slice:  ${id}`);
      console.log(`Title:  ${slice.title}`);
      console.log(`State:  ${slice.state}`);
      // D-30：单片也要能回答「活没活、救过几次、上报没」—— 不能只看 stall 分类。
      try {
        const projectRoot = process.cwd();
        const record = readSliceLivenessRecord(projectRoot, id);
        const live = await classifyLivenessAsync(record, { isProcessAlive, isProcessTreeAlive });
        const badge = live.state === 'active' ? '🔄 active' : live.state === 'stale' ? '⚠️ stale（可疑）' : live.state === 'dead' ? '💀 dead（进程已死）' : live.state;
        console.log(`Liveness: ${badge} · ${live.reason}`);
        if (slice.state === 'running' && live.state === 'dead') {
          console.log(`看门狗：  这一轮已经没有进程在管 —— 前台运行中会被当场退回 frozen；手动清：zelto stall --reap`);
        }
        const rec = readRecoveries(projectRoot, id);
        if (rec.count > 0) console.log(`看门狗：  已自愈 ${rec.count} 次${rec.escalated ? '（已上报，需人看现场）' : ''}${rec.lastReason ? `，上次：${rec.lastReason}` : ''}`);
      } catch { /* 不阻断展示 */ }
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
  } else {
    console.log('Stalled slices:');
    for (const s of stalled) {
      console.log(`  ${s.id.padEnd(20)} ${s.stallClass.padEnd(25)} auto-resolved: ${s.autoResolved}`);
    }
  }

  // 死切片 / 空壳单独点出来 —— 它们的状态是 `running`，混在停机列表里看不出
  // 「这个还在卡着、那个只是等着处理」的差别（ADR-053 / D-30）。
  const loaded = (await Promise.all(
    (await store.list()).map((sid) => store.read(sid).catch(() => null)),
  )).filter((s): s is SliceData => s !== null);
  const dead = findDeadSlices(loaded);
  const orphans = findOrphanShells(loaded, process.cwd(), isProcessAlive);

  if (dead.length > 0) {
    console.log('');
    console.log(`死切片（卡在 running，agent 已停机）：${dead.length} 个`);
    for (const d of dead) {
      console.log(`  ${d.sliceId.padEnd(20)} ${d.stallClass.padEnd(25)} ${d.lastRunAt ?? '(无运行记录)'}`);
    }
    console.log('  清理：zelto stall --reap');
  }

  if (orphans.length > 0) {
    console.log('');
    console.log(`空壳切片（卡在 running，无停机分类，现场无人在管）：${orphans.length} 个`);
    for (const o of orphans) {
      const badge = o.liveness.state === 'dead' ? '💀 dead' : '⚠️ stale';
      console.log(`  ${o.sliceId.padEnd(20)} ${badge.padEnd(10)} ${o.liveness.reason}`);
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
    // ADR-086：续跑编排下沉到 core/lifecycle/resume.ts ——
    // CLI 与 Web 调**同一份**（判定不许分叉，C3）。
    const outcome = await resumeSlice(
      {
        repoRoot: process.cwd(),
        store,
        events,
        actor: 'cli',
        via: 'cli',
      },
      id,
      { skip, abandon, resetRetry },
    );

    if (!outcome.ok) {
      console.error(`Error: ${outcome.reason}`);
      return 1;
    }

    // 顺序：先报预算，再报这次动作的结果。
    // 「预算已重置」是这次动作**唯一**的效果，混在一堆话里容易被忽略。
    for (const advisory of outcome.advisories) {
      if (advisory.includes('预算本来就是 0')) {
        console.log(`  ${advisory}`);
      } else {
        console.log(`  ⚠️ ${advisory}`);
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
      liveness?: string; liveReason?: string;
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

    // Check session persistence for running sessions —— D-30 被动活性：
    // 不信 status: running，现场读会话文件 + kill(pid,0)，给出 active/stale/dead。
    //
    // 会话文件说 running ≠ 切片在跑：空壳清理（`zelto stall --reap`）会把切片
    // 退回 frozen，但盘上的老会话文件仍然写着 running。只看会话文件的话，
    // 已经处理掉的切片会一直出现在「活动会话」里 —— 那是第二层假象。
    // 判据是**切片状态**：切片不在 running，它的会话文件再怎么写也不算在跑。
    const runningSliceIds = new Set(activeSlices.map((a) => a.id));
    const projectRoot = process.cwd();
    if (existsSync(SESSIONS_DIR)) {
      for (const file of readdirSync(SESSIONS_DIR)) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'));
          if (data.status === 'running' && runningSliceIds.has(data.sliceId)) {
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

    // 为每个 running 项算活性 —— 挑选规则收在 core（C3 单一判据）：
    // 同一切片可能有多份会话文件，取 lastActivity 最新的那份，别拿尸体当现场。
    for (const a of activeSlices) {
      let record = readSliceLivenessRecord(projectRoot, a.id);
      if (!record && a.sessionId) record = readSessionLiveness(projectRoot, a.sessionId);
      if (!a.sessionId && record) {
        const sid = (record as { sessionId?: string }).sessionId;
        if (sid) a.sessionId = sid;
      }
      const live = await classifyLivenessAsync(record, { isProcessAlive, isProcessTreeAlive });
      a.liveness = live.state;
      a.liveReason = live.reason;
      // 活进程看门狗（ADR-074）：进程已死 / 状态已收尾的运行记录，
      // 只要切片还写着 running，就给一句「会发生什么」—— 而不是让人自己去猜。
      if (live.state === 'dead') {
        a.liveReason = `${live.reason} —— 活进程看门狗会把它退回 frozen（前台运行中则当场收走），之后 zelto run 重跑`;
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
      const badge = slice.liveness === 'active' ? '🔄 active'
        : slice.liveness === 'stale' ? '⚠️ stale（可疑）'
        : slice.liveness === 'dead' ? '💀 dead（进程已死）'
        : slice.liveness ?? 'running';
      f.out(`  ${colors.cyan(slice.id)}  ${badge}`);
      f.out(`    Title:    ${slice.title}`);
      f.out(`    Status:   ${colors.green('running')} · ${slice.liveReason ?? ''}`);
      try {
        const r = readRecoveries(process.cwd(), slice.id);
        if (r.count > 0) f.out(`    看门狗：  已自愈 ${r.count} 次${r.escalated ? '（已上报，需人看）' : ''}`);
      } catch { /* 不阻断展示 */ }
      if (slice.elapsed) {
        f.out(`    Elapsed:  ${slice.elapsed}`);
      }
      if (slice.sessionId) {
        f.out(`    Session:  ${slice.sessionId}`);
      }

      // 进度与静默时长 —— D-30 补。
      //
      // 为什么单列一行：只说「running」的话，人无从判断「还在推进」还是
      // 「卡住了」。两个数要分清：
      //   - **没动静多久**：距上次**任何**活动（心跳）多久
      //   - **进展是什么**：最近一次**有实质进展**的动作
      //
      // 病灶（实测 nimrtc-v14 v3-n4-d6-connectivity，2026-11-22）：
      //   Claude Code 跑 `--output-format json` —— stdout **一次性**到达，
      //   整轮 101 分钟里 `output` 只有最后那个 JSON blob。
      //   所以「最后一条输出」这条信号在运行期间**恒为空**，
      //   界面只能显示「1 小时没输出」——而 agent 明明在改 15 个文件。
      //
      // 修法：进展**不只看 stdout**，也看**事件流** ——
      // agent 的每次工具调用都被 hook 判过并写了事件，
      // 那是运行期间真实存在的进展证据。
      const rec = readSliceLivenessRecord(process.cwd(), slice.id);
      if (rec) {
        const idle = rec.lastActivityAt
          ? Date.now() - Date.parse(rec.lastActivityAt)
          : null;
        if (idle !== null && Number.isFinite(idle)) {
          f.out(`    静默:     ${formatIdleDuration(idle)}没动静`);
        }
      }

      // 进展：先看 stdout（最直接），没有再看事件流。
      const outputProgress = lastOutputLine(rec);
      if (outputProgress) {
        f.out(`    进展:     ${colors.dim(outputProgress.slice(0, 110))}`);
      } else {
        const eventProgress = readEventProgress(EVENTS_DIR, slice.id);
        if (eventProgress) {
          const since = Math.max(
            0,
            Date.now() - Date.parse(eventProgress.at),
          );
          f.out(
            `    进展:     ${colors.dim(eventProgress.line.slice(0, 100))}` +
              colors.dim(`（${formatIdleDuration(since)}前）`),
          );
        } else {
          f.out(
            `    进展:     ${colors.dim('（暂无输出与事件——agent 可能刚起跑）')}`,
          );
        }
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

  /**
   * 把「多久没动静」说成人能一眼看懂的时长。
   *
   * 用「秒 / 分 / 小时」三档而不是「天」—— agent 运行不会跨天，
   * 而「3 小时 12 分没动静」比「11232 秒没动静」有用得多。
   */
  function formatIdleDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec} 秒`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分 ${sec % 60} 秒`;
    const hour = Math.floor(min / 60);
    return `${hour} 小时 ${min % 60} 分`;
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
