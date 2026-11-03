// zelto artifact check — check artifact-level conflicts between slices
//
// See docs/adr-012-parallel-coordination.md §3.7
// C3: deterministic, no model calls, no network

import { detectArtifactConflicts, BUILTIN_MAPPINGS } from '../../core/sched/artifact.js';
import type { ArtifactMapping } from '../../core/sched/artifact.js';
import { register, store } from './shared.js';

/**
 * zelto artifact check <id1> [id2 ...] [--json] [--custom <path>]
 *
 * Check for artifact-level conflicts between multiple slices.
 * Goes beyond file-path overlap to detect semantic conflicts
 * (e.g., two slices modifying the same type definition file category).
 *
 * Usage:
 *   zelto artifact check slice-a slice-b
 *   zelto artifact check slice-a slice-b slice-c --json
 */
register('artifact', async (args) => {
  // Parse subcommand
  const subCmd = args[0];
  if (subCmd !== 'check') {
    console.error('Usage: zelto artifact check <slice-id-1> [slice-id-2 ...] [--json]');
    console.error('');
    console.error('Subcommands:');
    console.error('  check    Check artifact-level conflicts between slices');
    return 1;
  }

  const ids = args.slice(1).filter((a) => !a.startsWith('--'));
  const asJson = args.includes('--json');

  if (ids.length < 2) {
    console.error('Usage: zelto artifact check <slice-id-1> <slice-id-2> [...slice-id-N] [--json]');
    return 1;
  }

  // Read slice data to get write-sets
  const slices: Array<[string, string[]]> = [];
  const notFound: string[] = [];

  for (const id of ids) {
    try {
      const slice = await store.read(id);
      if (slice.writes.length === 0) {
        console.warn(`  ⚠️  ${id}: write-set is empty — no artifacts to check`);
      }
      slices.push([id, slice.writes]);
    } catch {
      notFound.push(id);
    }
  }

  if (notFound.length > 0) {
    console.error(`Slice(s) not found: ${notFound.join(', ')}`);
    return 1;
  }

  // Check for custom mapping file
  let customMappings: ArtifactMapping[] | undefined;
  const customIdx = args.indexOf('--custom');
  if (customIdx >= 0 && customIdx + 1 < args.length) {
    const customPath = args[customIdx + 1];
    try {
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(customPath, 'utf-8');
      customMappings = JSON.parse(content) as ArtifactMapping[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ Cannot read custom mappings from "${customPath}": ${msg}`);
      return 1;
    }
  }

  // Detect conflicts
  const conflicts = detectArtifactConflicts(slices, customMappings);

  if (asJson) {
    console.log(JSON.stringify({
      checkedSlices: ids,
      totalConflicts: conflicts.length,
      errorCount: conflicts.filter((c) => c.severity === 'error').length,
      warningCount: conflicts.filter((c) => c.severity === 'warning').length,
      infoCount: conflicts.filter((c) => c.severity === 'info').length,
      conflicts,
    }, null, 2));
  } else {
    const errors = conflicts.filter((c) => c.severity === 'error');
    const warnings = conflicts.filter((c) => c.severity === 'warning');
    const infos = conflicts.filter((c) => c.severity === 'info');

    console.log(`Artifact Conflict Check: ${ids.length} slices`);
    console.log(`Built-in mappings: ${BUILTIN_MAPPINGS.length} patterns`);
    console.log('');

    if (conflicts.length === 0) {
      console.log('✅ No artifact-level conflicts detected.');
      return 0;
    }

    if (errors.length > 0) {
      console.log(`❌ Errors (${errors.length}):`);
      for (const c of errors) {
        console.log(`   ${c.description}`);
      }
      console.log('');
    }

    if (warnings.length > 0) {
      console.log(`⚠️  Warnings (${warnings.length}):`);
      for (const c of warnings) {
        console.log(`   ${c.description}`);
      }
      console.log('');
    }

    if (infos.length > 0) {
      console.log(`ℹ️  Info (${infos.length}):`);
      for (const c of infos) {
        console.log(`   ${c.description}`);
      }
      console.log('');
    }

    console.log(`Total: ${conflicts.length} conflict(s) — ${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info(s)`);

    if (errors.length > 0) {
      console.log('');
      console.log(`💡 Tip: Slices with type_definition or api_contract conflicts should`);
      console.log(`   be sequentialized via --depends-on, or one slice should exclude types.`);
      return 1;
    }
  }

  return 0;
});
