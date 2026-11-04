// Info, help, and utility commands: next, init, summary, events, help, hook, stall, resume

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Scheduler } from '../../core/sched/engine.js';
import { isSliceStalled } from '../../core/stall/index.js';
import { AuditTrail } from '../../core/audit/trail.js';
import { MetricsCollector } from '../../core/metrics/collector.js';
import { register } from './shared.js';
import { store, events, ZELTO_DIR, SLICES_DIR, EVENTS_DIR, loadPolicyConfig, loadConfig } from './shared.js';
import { commandsByGroup, findCommand, usageOf } from './catalog.js';
import { colors, formatSection, formatKeyValue, formatWarning } from '../color.js';
import { getDefaultFormatter } from '../output-formatter.js';
import { writeOutput } from '../output.js';

// ─── next ────────────────────────────────────────────────────────────────────

register('next', async () => {
  const list = await store.list();
  if (list.length === 0) {
    console.log('No slices found. Create one to get started.');
    return 0;
  }

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

  const priority: Array<string> = ['draft', 'clarifying', 'frozen', 'running', 'completed', 'abandoned'];
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
            completed: 'zelto sign <id> --approve',
            abandoned: 'Restart or archive',
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

  if (list.length === 0) {
    console.log(formatSection('Welcome to zelto!'));
    console.log(`  ${colors.cyan('zelto init')}     Initialize a project`);
    console.log(`  ${colors.cyan('zelto help')}     Show all commands`);
    console.log(`  ${colors.cyan('zelto create')}   Create your first slice`);
    console.log(`\n  ${colors.dim('Or try the AI pipeline:')}`);
    console.log(`  ${colors.cyan('zelto require')}   Create a requirement document`);
    return 0;
  }

  // Check overall project state
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

  // Check each slice and suggest next action
  console.log(formatSection('Suggested Actions'));
  const priority: Array<{ state: string; action: string; prepare: string }> = [
    { state: 'draft', action: 'zelto check <id> && zelto freeze <id>', prepare: 'Check and freeze spec' },
    { state: 'clarifying', action: 'zelto clarify <id>', prepare: 'Answer clarification questions' },
    { state: 'frozen', action: 'zelto run <id> [--dry-run]', prepare: 'Execute slice' },
    { state: 'running', action: 'zelto events <id>', prepare: 'Monitor execution' },
    { state: 'completed', action: 'zelto sign <id> --approve', prepare: 'Review and sign off' },
  ];

  let suggested = false;
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
  const result = initializeProject(projectMap, { autoDetect: true, policyTemplate: 'default' });
  created += result.created.length;

  if (created === 0) {
    console.log(`zelto init — ✅ Already initialized.`);
  } else {
    console.log(`zelto init — ✅ Project "${projectMap.projectName}" initialized.`);
    for (const item of result.created) {
      console.log(`  ✅ ${item}`);
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

register('stall', async (args) => {
  const [id] = args;
  const showAutoResolved = args.includes('--auto-resolved');

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
  return 0;
});

// ─── resume ──────────────────────────────────────────────────────────────────

register('resume', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto resume <slice-id> [--skip] [--abandon]');
    return 1;
  }

  const skip = args.includes('--skip');
  const abandon = args.includes('--abandon');

  try {
    await store.read(id);
  } catch {
    console.error(`Slice "${id}" not found.`);
    return 1;
  }

  const scheduler = new Scheduler(store, events, loadPolicyConfig());

  try {
    await scheduler.resume(id, { skip, abandon });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }

  if (abandon) {
    console.log(`zelto resume ${id} --abandon -- Slice abandoned`);
  } else if (skip) {
    console.log(`zelto resume ${id} --skip -- Stall resolved, slice not re-executed`);
  } else {
    console.log(`zelto resume ${id} -- Slice resumed for re-execution`);
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
            runningSince: s.runs.length > 0 ? s.runs[s.runs.length - 1] : undefined,
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
