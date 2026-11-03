// Artifact conflict detection — semantic conflict detection beyond file path overlap
//
// C3: deterministic, no model calls, no network
// C6: core/ only — no adapters/ imports
//
// See docs/adr-012-parallel-coordination.md §3.3

import { pathMatches } from './paths.js';

/**
 * Categories of artifacts.
 */
export type ArtifactCategory =
  | 'type_definition'  // .d.ts, interfaces, types.ts
  | 'api_contract'     // API routes, handler signatures
  | 'schema'           // JSON Schema, data contracts
  | 'config'           // configuration files
  | 'test_fixture'     // test fixtures, mocks
  | 'documentation';   // documentation files

/**
 * Mapping from file pattern to logical artifact.
 */
export interface ArtifactMapping {
  pattern: string;
  artifact: string;
  category: ArtifactCategory;
}

/**
 * Severity of an artifact conflict.
 */
export type ConflictSeverity = 'info' | 'warning' | 'error';

/**
 * A detected artifact-level conflict between two slices.
 */
export interface ArtifactConflict {
  sliceA: string;
  sliceB: string;
  artifact: string;
  category: ArtifactCategory;
  severity: ConflictSeverity;
  description: string;
}

/**
 * Built-in artifact mappings.
 * Hardcoded for determinism (C3) and protected from policy override (C5/C8).
 */
export const BUILTIN_MAPPINGS: ArtifactMapping[] = [
  // Type definitions
  { pattern: '**/types.ts', artifact: 'type-definitions', category: 'type_definition' },
  { pattern: '**/*.d.ts', artifact: 'type-definitions', category: 'type_definition' },
  { pattern: '**/interfaces/**', artifact: 'interfaces', category: 'type_definition' },
  { pattern: '**/types/**', artifact: 'type-definitions', category: 'type_definition' },

  // API contracts
  { pattern: '**/routes/**', artifact: 'api-routes', category: 'api_contract' },
  { pattern: '**/api/**', artifact: 'api-contracts', category: 'api_contract' },
  { pattern: '**/handlers/**', artifact: 'api-handlers', category: 'api_contract' },

  // Schemas
  { pattern: 'contracts/schemas/*.json', artifact: 'contract-schemas', category: 'schema' },
  { pattern: '**/*.schema.ts', artifact: 'runtime-schemas', category: 'schema' },
  { pattern: '**/*.schema.json', artifact: 'json-schemas', category: 'schema' },

  // Config
  { pattern: 'policy/**', artifact: 'policy', category: 'config' },
  { pattern: '.zelto/**', artifact: 'zelto-state', category: 'config' },
  { pattern: '**/config/**', artifact: 'config-files', category: 'config' },

  // Test fixtures
  { pattern: '**/fixtures/**', artifact: 'test-fixtures', category: 'test_fixture' },
  { pattern: '**/__mocks__/**', artifact: 'test-mocks', category: 'test_fixture' },
  { pattern: 'tests/acceptance/**', artifact: 'acceptance-tests', category: 'test_fixture' },

  // Documentation
  { pattern: 'docs/**', artifact: 'documentation', category: 'documentation' },
  { pattern: '*.md', artifact: 'root-docs', category: 'documentation' },
];

/**
 * Map a file path to the artifacts it belongs to.
 */
export function mapPathToArtifacts(
  filePath: string,
  customMappings?: ArtifactMapping[],
): ArtifactMapping[] {
  const mappings = [...BUILTIN_MAPPINGS, ...(customMappings ?? [])];
  return mappings.filter((m) => pathMatches(filePath, m.pattern));
}

/**
 * Detect artifact-level conflicts between multiple slices.
 *
 * Algorithm:
 * 1. Map each slice's write-set to artifacts
 * 2. Find slices that share the same artifact
 * 3. Assign severity based on artifact category
 * 4. Return all conflicts sorted by severity (most severe first)
 *
 * @param slices - Array of [sliceId, writes[]] tuples
 * @param customMappings - Optional custom artifact mappings
 * @returns Array of artifact conflicts
 */
export function detectArtifactConflicts(
  slices: Array<[string, string[]]>,
  customMappings?: ArtifactMapping[],
): ArtifactConflict[] {
  const sliceArtifacts = new Map<string, Map<string, ArtifactMapping>>();

  // Build artifact map per slice
  for (const [sliceId, writes] of slices) {
    const artifactMap = new Map<string, ArtifactMapping>();
    for (const writePath of writes) {
      const mappings = mapPathToArtifacts(writePath, customMappings);
      for (const m of mappings) {
        if (!artifactMap.has(m.artifact)) {
          artifactMap.set(m.artifact, m);
        }
      }
    }
    sliceArtifacts.set(sliceId, artifactMap);
  }

  // Detect conflicts
  const conflicts: ArtifactConflict[] = [];
  const sliceIds = Array.from(sliceArtifacts.keys());

  for (let i = 0; i < sliceIds.length; i++) {
    for (let j = i + 1; j < sliceIds.length; j++) {
      const a = sliceIds[i];
      const b = sliceIds[j];
      const artifactsA = sliceArtifacts.get(a)!;
      const artifactsB = sliceArtifacts.get(b)!;

      for (const [artifactName, mappingA] of artifactsA) {
        const mappingB = artifactsB.get(artifactName);
        if (!mappingB) continue;

        const severity = severityForCategory(mappingA.category);
        conflicts.push({
          sliceA: a,
          sliceB: b,
          artifact: artifactName,
          category: mappingA.category,
          severity,
          description: `Both "${a}" and "${b}" touch "${artifactName}" (${mappingA.category})`,
        });
      }
    }
  }

  // Sort: error first, then warning, then info; within same severity alphabetically
  const severityRank: Record<ConflictSeverity, number> = {
    error: 0,
    warning: 1,
    info: 2,
  };

  conflicts.sort((a, b) => {
    const rankDiff = severityRank[a.severity] - severityRank[b.severity];
    if (rankDiff !== 0) return rankDiff;
    return a.description.localeCompare(b.description);
  });

  return conflicts;
}

/**
 * Determine the severity of a conflict based on artifact category.
 */
function severityForCategory(category: ArtifactCategory): ConflictSeverity {
  switch (category) {
    case 'type_definition':
    case 'api_contract':
      return 'error';
    case 'schema':
    case 'config':
      return 'warning';
    case 'test_fixture':
    case 'documentation':
      return 'info';
  }
}
