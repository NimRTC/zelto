// Info, help, and utility commands: next, init, summary, events, help, hook, stall, resume

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Scheduler } from '../../core/sched/engine.js';
import { isSliceStalled } from '../../core/stall/index.js';
import { AuditTrail } from '../../core/audit/trail.js';
import { MetricsCollector } from '../../core/metrics/collector.js';
import { register } from './shared.js';
import { store, events, ZELTO_DIR, SLICES_DIR, EVENTS_DIR, loadPolicyConfig, loadConfig } from './shared.js';
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

  // Auto-install git hooks
  try {
    const GIT_HOOKS_DIR = join(process.cwd(), '.git', 'hooks');
    if (existsSync(GIT_HOOKS_DIR)) {
      console.log(`\n  Installing git hooks...`);
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

  // Support: zelto help <cmd> — show command-specific help
  if (specificCmd && !specificCmd.startsWith('--')) {
    const { commands } = await import('./shared.js');
    const handler = commands[specificCmd];
    if (handler) {
      return handler(['--help']);
    }
    console.error(`Unknown command: ${specificCmd}`);
    console.error('Run "zelto help" for usage.');
    return 1;
  }

  console.log(`
${colors.bold('zelto — AI Programming Cockpit')}

${colors.cyan('Usage:')}
  zelto <command> [options]

${colors.bold('Core slice commands:')}
  create <id>            Create a new slice (interactive if no args) [--json]
  slices                 List all slices [--active] [--json]
  slice <id>             Show slice details [--json]
  check <id>             Gate① — pre-freeze checks [--json]
  clarify <id>           Clarify slice spec (interactive, --auto, --dry-run)
  freeze <id>            Freeze slice baseline [--json]
  run <id>               Execute slice (--dry-run, --agent <name>, --adapter <type>) [--json]
  start <id>             One-command: create → check → freeze → run [--yes] [--adapter <type>]
  admit <id>             Check admission (--json)
  diff <id>              Show changes made by a slice (--stat, --json)
  diff-highlight         Read unified diff from stdin, output ANSI-highlighted version
  gate <id>              Gate② — run acceptance tests [--dry-run] [--json]
  inbox                  View pending sign requests
  sign <id> --approve    Approve completed slice [--json]
  sign <id> --reject     Reject completed slice [--json]
  abandon <id>           Abandon a slice
  next                   Suggest next action on a slice
  suggest                Full project overview and suggested actions
  stall [id]             List stalled slices or inspect one (--auto-resolved)
  resume <id>            Resume stalled slice (--skip, --abandon)
  ask                    List pending agent questions (--slice <id>, --json)
  answer <qid> "<text>"  Answer an agent question and resume the slice (--list to just list)
  status [--watch]       Show active agent sessions (--json)
  events <id>            View slice event stream [--json]

${colors.bold('Project management:')}
  init                   Initialize .zelto/ directory [--with-examples]
  summary                Project overview
  report [--format]      Generate status report (markdown|json)
  config                 View or modify configuration (get/set)

${colors.bold('Governance:')}
  policy list            List policy rules [--json]
  policy show <id>       Show a single policy rule [--json]
  policy check <path>    Check path against policy [--json]
  policy validate        Validate policy configuration [--json]
  policy add <id>        Add a policy rule
  policy remove <id>     Remove a policy rule [--json]
  policy edit <id>       Edit a policy rule

${colors.bold('AI Pipeline:')}
  require <text>         Create requirement document
  require list           List requirements
  require confirm <id>   Confirm a requirement
  require refine <id>    Iteratively refine requirement
  design <req-id>        Generate design from requirement
  design list            List designs
  design confirm <id>    Confirm a design
  design refine <id>     Iteratively refine design
  plan <design-id>       Generate version plan from design
  plan confirm <id>      Confirm plan and create slice specs
  plan add-version <id>  Append a new version to plan
  version status         Show version plan status
  version start <ver>    Execute all slices in a version (--auto for full auto-pilot)
  version deliver <ver>  Mark version as delivered
  pipeline status        Full chain overview

${colors.bold('Project takeover:')}
  project scan           Scan existing project structure
  project init           Initialize zelto governance
  project design         Generate design docs (requires LLM)
  project slice          Create v0 baseline slices
  project status         View governance status

${colors.bold('Panoramic:')}
  trace <req-id>         Trace requirement → design → plan → slices
  impact <req-id>        Change impact analysis
  audit <slice-id>       Show audit trail for a slice
  snapshot [cmd]         Capture/list/show project state snapshots

${colors.bold('Other:')}
  hook --install         Install git hooks
  hook --uninstall       Uninstall git hooks
  patch-content          Interactive per-slice patch splitter
  help                   Show this help
  completion [shell]     Generate shell completion script (bash|zsh|fish)

${colors.dim('Configuration: .zelto/config.yaml')}
${colors.dim('Policy:        policy/policy.yaml')}
  `);
  return 0;
});
// ─── completion ──────────────────────────────────────────────────────────────

register('completion', async (args) => {
  const shell = args[0] || 'bash';
  const commands = [
    'create', 'slices', 'check', 'clarify', 'freeze', 'run', 'start',
    'admit', 'gate', 'inbox', 'sign', 'abandon', 'next', 'suggest',
    'stall', 'resume', 'status', 'events', 'init', 'summary', 'report',
    'require', 'design', 'plan', 'version', 'pipeline',
    'ask', 'answer',
    'project', 'trace', 'impact', 'audit', 'snapshot', 'hook', 'patch-content', 'diff-highlight', 'help', 'completion',
  ];
  const subcommands = {
    require: ['list', 'confirm', 'refine'],
    design: ['list', 'confirm', 'refine'],
    plan: ['list', 'confirm', 'add-version'],
    version: ['status', 'start', 'deliver'],
    project: ['scan', 'init', 'design', 'slice', 'status'],
    sign: ['--approve', '--reject'],
    hook: ['--install', '--uninstall'],
    stall: ['--auto-resolved'],
    status: ['--watch', '--json'],
    run: ['--dry-run', '--agent', '--adapter'],
    start: ['--title', '--writes', '--agent', '--yes', '--adapter'],
    create: ['--title', '--writes'],
    clarify: ['--auto', '--dry-run'],
    report: ['--format'],
    completion: ['bash', 'zsh', 'fish'],
  };

  if (shell === 'bash') {
    const cmdList = commands.join(' ');
    console.log();
  } else if (shell === 'zsh') {
    console.log(':see zelto help');
  } else if (shell === 'fish') {
    console.log();
  } else {
    console.error();
    return 1;
  }
  return 0;
});

// ─── hook ────────────────────────────────────────────────────────────────────

register('hook', async (args) => {
  const action = args[0];
  const GIT_HOOKS_DIR = join(process.cwd(), '.git', 'hooks');
  const HOOK_MARKER = '# zelto-hook — DO NOT EDIT';

  function hookScript(name: string, condition: string): string {
    return `#!/bin/sh
${HOOK_MARKER}
# Auto-installed by \`zelto hook --install\`
# Runs zelto-hook policy check on ${name}

# Validate zelto-hook binary exists
ZELTO_HOOK="$(git rev-parse --show-toplevel 2>/dev/null)/dist/hook/index.js"
if [ ! -f "$ZELTO_HOOK" ]; then
  echo "⚠️  zelto-hook: Binary not found at \$ZELTO_HOOK"
  echo "   Run 'pnpm build' or 'npx tsc -p tsconfig.json' first."
  echo "   To skip zelto check: git commit --no-verify"
  exit 0
fi

${condition}
if [ \$? -ne 0 ]; then
  FILES="${name === 'pre-commit' ? '$(git diff --cached --name-only --diff-filter=ACMR)' : '$(git diff --name-only @{push}.. 2>/dev/null || git diff --name-only HEAD~1..)'}"
  if [ -z "$FILES" ]; then
    exit 0
  fi

  HAS_DENY=0
  echo "$FILES" | while IFS= read -r file; do
    if [ -n "$file" ]; then
      RESULT=$(echo "{\\"path\\":\\"$file\\",\\"operation\\":\\"write\\",\\"harness\\":\\"git\\"}" | node "$ZELTO_HOOK" 2>/dev/null)
      DECISION=$(echo "$RESULT" | grep -o '"decision":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [ "$DECISION" = "deny" ]; then
        echo "❌ zelto-hook: DENIED write to $file"
        BASIS=$(echo "$RESULT" | grep -o '"basis":"[^"]*"' | head -1 | cut -d'"' -f4)
        echo "   Basis: $BASIS"
        HAS_DENY=1
      fi
    fi
  done

  if [ "$HAS_DENY" = "1" ]; then
    echo ""
    echo "zelto-hook: Policy check failed. Commit blocked."
    exit 1
  fi
fi
`;
  }

  async function installHook(name: string, condition: string): Promise<boolean> {
    // Check if zelto-hook binary exists (warn if not, but don't block install)
    // The hook script itself validates binary existence at runtime
    const hookBinary = join(process.cwd(), 'dist', 'hook', 'index.js');
    if (!existsSync(hookBinary)) {
      console.warn(`  ⚠️  zelto-hook binary not found at dist/hook/index.js`);
      console.warn(`     Hooks will be installed but will skip checks until "pnpm build" is run.`);
    }

    const hookPath = join(GIT_HOOKS_DIR, name);
    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, 'utf-8');
      if (!existing.includes(HOOK_MARKER) && !existing.includes('# zelto-hook')) {
        console.error(`  ⚠️  ${name} already exists (not a zelto hook). Skipping.`);
        console.error(`     Merge manually: ${hookPath}`);
        return false;
      }
    }
    writeFileSync(hookPath, hookScript(name, condition), 'utf-8');
    try {
      const { chmodSync } = await import('node:fs');
      chmodSync(hookPath, 0o755);
    } catch {
      // Windows: chmod may fail
    }
    console.log(`  ✅ ${name} installed`);
    return true;
  }

  async function uninstallHook(name: string): Promise<boolean> {
    const hookPath = join(GIT_HOOKS_DIR, name);
    if (!existsSync(hookPath)) return false;
    const existing = readFileSync(hookPath, 'utf-8');
    if (!existing.includes(HOOK_MARKER)) {
      console.error(`  ⚠️  ${name} is not a zelto hook. Skipping.`);
      return false;
    }
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(hookPath);
    } catch {
      writeFileSync(hookPath, '', 'utf-8');
    }
    console.log(`  ✅ ${name} uninstalled`);
    return true;
  }

  if (action === '--install') {
    const hookType = args[1] || 'all';
    console.log('Installing zelto git hooks...');
    let count = 0;
    if (hookType === 'pre-commit' || hookType === 'all') {
      if (await installHook('pre-commit', 'git diff --cached --quiet --exit-code')) count++;
    }
    if (hookType === 'pre-push' || hookType === 'all') {
      if (await installHook('pre-push', 'git diff --quiet @{push}.. 2>/dev/null || git diff --quiet HEAD~1..')) count++;
    }
    console.log(`\n✅ ${count} hook(s) installed.`);
    return 0;
  }

  if (action === '--uninstall') {
    const hookType = args[1] || 'all';
    console.log('Uninstalling zelto git hooks...');
    let count = 0;
    if (hookType === 'pre-commit' || hookType === 'all') {
      if (await uninstallHook('pre-commit')) count++;
    }
    if (hookType === 'pre-push' || hookType === 'all') {
      if (await uninstallHook('pre-push')) count++;
    }
    console.log(`\n✅ ${count} hook(s) uninstalled.`);
    return 0;
  }

  if (action === '--check' || action === '--status') {
    const checkType = args[1] || 'all';
    let allPassed = true;
    for (const name of checkType === 'all' ? ['pre-commit', 'pre-push'] : [checkType]) {
      const hookPath = join(GIT_HOOKS_DIR, name);
      if (existsSync(hookPath)) {
        const content = readFileSync(hookPath, 'utf-8');
        if (content.includes(HOOK_MARKER)) {
          console.log(`  ✅ ${name} — zelto hook installed`);
        } else {
          console.log(`  ⚠️  ${name} — exists but not a zelto hook`);
          allPassed = false;
        }
      } else {
        console.log(`  ⬜ ${name} — not installed`);
        allPassed = false;
      }
    }
    return allPassed ? 0 : 0; // Always exit 0 for status check; user reads output
  }

  // Test a single file
  const testPath = args.find((a) => !a.startsWith('--'));
  if (testPath) {
    const { evaluatePolicy, isProtectedPath, hashPolicy } = await import('../../core/policy/engine.js');
    const config = loadPolicyConfig();
    const policyVersion = hashPolicy(JSON.stringify(config));
    const decision = evaluatePolicy(config, testPath, 'write', policyVersion);
    console.log(JSON.stringify(decision, null, 2));
    return 0;
  }

  console.error('Usage: zelto hook --install [pre-commit|pre-push|all]');
  console.error('       zelto hook --uninstall [pre-commit|pre-push|all]');
  console.error('       zelto hook --check [pre-commit|pre-push|all]');
  console.error('       zelto hook <file-path>');
  return 1;
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
