/**
 * snapshot.ts — `zelto snapshot` command
 *
 * Captures a point-in-time snapshot of the project state:
 * - All slice states
 * - Version plan status
 * - Event counts per slice
 * - Policy file hash
 * - Git commit hash
 *
 * Snapshots are saved to .zelto/events/snapshots/ for historical tracking.
 *
 * C4: every action writes append-only events
 * C2: core/ does not depend on any SDK
 */

import { register, store, events } from './shared.js';
import { ZELTO_DIR, SLICES_DIR } from './shared.js';
import { AuditTrail } from '../../core/audit/trail.js';
import { colors } from '../color.js';
import { writeOutput } from '../output.js';
import { mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const SNAPSHOTS_DIR = join(ZELTO_DIR, 'events', 'snapshots');

export interface SnapshotData {
  id: string;
  capturedAt: string;
  projectVersion: string;
  git: {
    commit: string;
    branch: string;
    dirty: boolean;
  };
  slices: Array<{
    id: string;
    state: string;
    eventCount: number;
  }>;
  plans: Array<{
    id: string;
    status: string;
    versions: Array<{ version: string; status: string }>;
  }>;
  policyHash: string | null;
}

register('snapshot', async (args) => {
  const subcmd = args[0];

  // ─── help ──────────────────────────────────────────────────────────────
  if (subcmd === '--help' || subcmd === '-h') {
    console.log(`
${'Usage:'}
  zelto snapshot               Capture a new project snapshot
  zelto snapshot list [--json] List saved snapshots
  zelto snapshot show <id>     Show a specific snapshot

${'Description:'}
  Capture point-in-time snapshots of project state for tracking evolution.

${'Options:'}
  --json  Output in JSON format
    `);
    return 0;
  }

  // ─── list ──────────────────────────────────────────────────────────────
  if (subcmd === 'list') {
    const isJson = args.includes('--json');
    if (!existsSync(SNAPSHOTS_DIR)) {
      if (isJson) {
        writeOutput([], undefined, { json: true });
      } else {
        console.log(`${colors.yellow('No snapshots found.')}`);
        console.log('  Create one with: zelto snapshot');
      }
      return 0;
    }

    const files = readdirSync(SNAPSHOTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();

    const snapshots = files.map((f) => {
      const data = JSON.parse(readFileSync(join(SNAPSHOTS_DIR, f), 'utf-8')) as SnapshotData;
      return {
        id: data.id,
        capturedAt: data.capturedAt,
        commit: data.git.commit.substring(0, 8),
        branch: data.git.branch,
        sliceCount: data.slices.length,
      };
    });

    if (isJson) {
      writeOutput(snapshots, undefined, { json: true });
    } else {
      console.log(`${colors.bold('Snapshots:')}`);
      for (const s of snapshots) {
        console.log(`  ${colors.cyan(s.id)}  ${s.capturedAt.slice(0, 19)}  ${colors.dim(s.branch)}@${colors.dim(s.commit)}  (${s.sliceCount} slices)`);
      }
    }
    return 0;
  }

  // ─── show ──────────────────────────────────────────────────────────────
  if (subcmd === 'show') {
    const id = args[1];
    if (!id) {
      console.error('Usage: zelto snapshot show <id>');
      return 1;
    }
    const isJson = args.includes('--json');
    const filePath = join(SNAPSHOTS_DIR, `${id}.json`);
    if (!existsSync(filePath)) {
      console.error(`Snapshot "${id}" not found.`);
      console.error('Run "zelto snapshot list" to see available snapshots.');
      return 1;
    }

    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as SnapshotData;

    if (isJson) {
      writeOutput(data, undefined, { json: true });
    } else {
      console.log(`${colors.bold('Snapshot:')} ${colors.cyan(data.id)}`);
      console.log(`  ${colors.dim('Captured:')} ${data.capturedAt.slice(0, 19)}`);
      console.log(`  ${colors.dim('Git:')} ${data.git.branch}@${data.git.commit.substring(0, 12)}${data.git.dirty ? ' (dirty)' : ''}`);
      console.log(`  ${colors.dim('Slices:')} ${data.slices.length}`);
      console.log(`  ${colors.dim('Policy:')} ${data.policyHash ?? 'N/A'}`);
      console.log('');
      console.log(`  ${colors.bold('Slices:')}`);
      for (const s of data.slices) {
        const stateIcon = s.state === 'completed' ? colors.green('✓') : s.state === 'frozen' ? colors.cyan('❄') : s.state === 'running' ? colors.yellow('▶') : colors.dim('○');
        console.log(`    ${stateIcon} ${colors.cyan(s.id)} ${colors.dim(s.state)} (${s.eventCount} events)`);
      }
      if (data.plans.length > 0) {
        console.log('');
        console.log(`  ${colors.bold('Plans:')}`);
        for (const p of data.plans) {
          console.log(`    ${colors.cyan(p.id)} ${colors.dim(p.status)}`);
          for (const v of p.versions) {
            const vIcon = v.status === 'delivered' ? '🚀' : v.status === 'integrated' ? '✅' : v.status === 'in_progress' ? '🔄' : '⏳';
            console.log(`      ${vIcon} ${v.version}: ${v.status}`);
          }
        }
      }
    }
    return 0;
  }

  // ─── capture (default) ─────────────────────────────────────────────────
  const isJson = args.includes('--json');

  const data = await captureSnapshot();

  if (isJson) {
    writeOutput(data, undefined, { json: true });
  } else {
    console.log(`${colors.green('✓')} ${colors.bold('Snapshot captured:')} ${colors.cyan(data.id)}`);
    console.log(`  ${colors.dim('Slices:')} ${data.slices.length}`);
    console.log(`  ${colors.dim('Git:')} ${data.git.branch}@${data.git.commit.substring(0, 8)}`);
    console.log(`  ${colors.dim('Saved to:')} .zelto/events/snapshots/${data.id}.json`);
  }

  return 0;
});

/**
 * 捕获一份项目状态快照并落盘。
 *
 * 抽成函数是因为「拉闸」也要留现场（ADR-020）：人喊停的那一刻，
 * 现场必须能被事后回看 —— 只有 stdout 上的几行字是不够的。
 *
 * C1: 快照落在 `.zelto/events/snapshots/<id>.json`
 */
export async function captureSnapshot(): Promise<SnapshotData> {
  // Gather git info
  let gitCommit = 'unknown';
  let gitBranch = 'unknown';
  let gitDirty = false;
  try {
    gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    gitDirty = execSync('git status --porcelain', { encoding: 'utf-8' }).trim().length > 0;
  } catch {
    // Not a git repo or git not available
  }

  // Gather slice states
  const sliceIds = await store.list();
  const slices: SnapshotData['slices'] = [];
  for (const id of sliceIds) {
    try {
      const slice = await store.read(id);
      const evts = await events.read(id);
      slices.push({
        id,
        state: slice.state,
        eventCount: evts.length,
      });
    } catch {
      // Skip unreadable slices
    }
  }

  // Gather plan info
  const { VersionStore } = await import('../../core/version/store.js');
  const versionStore = new VersionStore(ZELTO_DIR);
  const plans: SnapshotData['plans'] = [];
  try {
    const planSummaries = await versionStore.list();
    for (const p of planSummaries) {
      const plan = await versionStore.read(p.id);
      plans.push({
        id: plan.id,
        status: plan.status,
        versions: plan.versions.map((v: { version: string; status: string }) => ({
          version: v.version,
          status: v.status,
        })),
      });
    }
  } catch {
    // No plans
  }

  // Policy hash
  let policyHash: string | null = null;
  try {
    const policyPath = resolve('policy', 'policy.yaml');
    if (existsSync(policyPath)) {
      const content = readFileSync(policyPath, 'utf-8');
      const { createHash } = await import('node:crypto');
      policyHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    }
  } catch {
    // No policy file
  }

  const id = `snap-${Date.now()}`;
  const data: SnapshotData = {
    id,
    capturedAt: new Date().toISOString(),
    projectVersion: '0.1.0',
    git: { commit: gitCommit, branch: gitBranch, dirty: gitDirty },
    slices,
    plans,
    policyHash,
  };

  // Save snapshot
  if (!existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
  writeFileSync(join(SNAPSHOTS_DIR, `${id}.json`), JSON.stringify(data, null, 2), 'utf-8');

  return data;
}
