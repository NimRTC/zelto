import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { register, SLICES_DIR } from './shared.js';
import type { SliceData } from '../../core/slice/store.js';

register('slices', async (args) => {
  const activeOnly = args.includes('--active') || args.includes('-a');
  const jsonOutput = args.includes('--json');
  const doPrune = args.includes('--prune');

  if (doPrune) {
    return await pruneSlices();
  }

  if (!existsSync(SLICES_DIR)) {
    if (jsonOutput) {
      console.log(JSON.stringify({ slices: [] }));
    } else {
      console.log('No slices found.');
    }
    return 0;
  }

  const files = readdirSync(SLICES_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ slices: [] }));
    } else {
      console.log('No slices found.');
    }
    return 0;
  }

  const slices: SliceData[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(SLICES_DIR, file), 'utf-8');
      slices.push(JSON.parse(content) as SliceData);
    } catch {
      // skip corrupted
    }
  }

  // Filter to active states (not completed/abandoned) if --active
  const filtered = activeOnly
    ? slices.filter((s) => s.state !== 'completed' && s.state !== 'abandoned')
    : slices;

  if (jsonOutput) {
    console.log(JSON.stringify({ slices: filtered, total: slices.length, showing: filtered.length }, null, 2));
    return 0;
  }

  // Sort by state priority for display
  const stateOrder: Record<string, number> = {
    running: 0,
    frozen: 1,
    clarifying: 2,
    draft: 3,
    completed: 4,
    abandoned: 5,
  };
  filtered.sort((a, b) => (stateOrder[a.state] ?? 99) - (stateOrder[b.state] ?? 99));

  const now = Date.now();
  const DAY_MS = 86400000;

  if (filtered.length === 0 && activeOnly) {
    console.log('No active slices. Use --active to see active only, or omit to see all.');
    console.log('');
    console.log(`Archived: ${slices.length - filtered.length} completed/abandoned slices (use "zelto slices" to show all).`);
    return 0;
  }

  console.log(`Slices (${filtered.length}/${slices.length}):`);
  console.log('');
  for (const s of filtered) {
    const age = now - new Date(s.updatedAt ?? s.createdAt).getTime();
    const ageStr = age < DAY_MS
      ? `${Math.floor(age / 3600000)}h`
      : `${Math.floor(age / DAY_MS)}d`;

    const icon: Record<string, string> = {
      running: '▶️',
      frozen: '❄️',
      clarifying: '❓',
      draft: '📝',
      completed: '✅',
      abandoned: '🗑️',
    };

    const title = s.title ? ` — ${s.title}` : '';
    console.log(`  ${icon[s.state] ?? '📄'} [${s.id}] ${s.state} (${ageStr})${title}`);
  }
  console.log('');

  if (!activeOnly) {
    const activeCount = slices.filter((s) => s.state !== 'completed' && s.state !== 'abandoned').length;
    const archivedCount = slices.length - activeCount;
    if (archivedCount > 0) {
      console.log(`Tip: Use "zelto slices --active" to show only active (${activeCount} active, ${archivedCount} archived).`);
    }
  }

  return 0;
});

/**
 * Remove abandoned slices and their events from disk.
 */
async function pruneSlices(): Promise<number> {
  const { rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const files = readdirSync(SLICES_DIR).filter((f) => f.endsWith('.json'));
  let removed = 0;

  for (const file of files) {
    try {
      const content = readFileSync(join(SLICES_DIR, file), 'utf-8');
      const slice = JSON.parse(content) as SliceData;
      if (slice.state !== 'abandoned') continue;

      const sliceId = slice.id;
      const slicePath = join(SLICES_DIR, `${sliceId}.json`);
      if (existsSync(slicePath)) {
        rmSync(slicePath, { force: true });
      }

      // Remove events directory
      const eventsDir = join(SLICES_DIR, '..', 'events', sliceId);
      if (existsSync(eventsDir)) {
        rmSync(eventsDir, { recursive: true, force: true });
      }

      // Remove bundle if exists
      const bundlePath = join(SLICES_DIR, '..', `${sliceId}-bundle.json`);
      if (existsSync(bundlePath)) {
        rmSync(bundlePath, { force: true });
      }

      console.log(`  🗑️  Removed abandoned slice: ${sliceId}`);
      removed++;
    } catch {
      // Skip problematic slices
    }
  }

  if (removed === 0) {
    console.log('No abandoned slices to remove.');
  } else {
    console.log(`\n✅ Removed ${removed} abandoned slice(s).`);
  }
  return 0;
}
