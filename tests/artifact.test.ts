import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_MAPPINGS,
  detectArtifactConflicts,
  mapPathToArtifacts,
} from '../src/core/sched/artifact.js';
import type { ArtifactMapping } from '../src/core/sched/artifact.js';

describe('mapPathToArtifacts', () => {
  it('maps types.ts to type-definitions', () => {
    const result = mapPathToArtifacts('src/core/types.ts');
    assert.ok(result.some((m) => m.artifact === 'type-definitions'));
  });

  it('maps .d.ts files to type-definitions', () => {
    const result = mapPathToArtifacts('src/types.d.ts');
    assert.ok(result.some((m) => m.artifact === 'type-definitions'));
  });

  it('maps contracts/schemas/*.json to contract-schemas', () => {
    const result = mapPathToArtifacts('contracts/schemas/policy.json');
    assert.ok(result.some((m) => m.artifact === 'contract-schemas'));
  });

  it('maps policy files to policy artifact', () => {
    const result = mapPathToArtifacts('policy/policy.yaml');
    assert.ok(result.some((m) => m.artifact === 'policy'));
  });

  it('maps docs files to documentation', () => {
    const result = mapPathToArtifacts('docs/zelto-技术架构.md');
    assert.ok(result.some((m) => m.artifact === 'documentation'));
  });

  it('maps test fixtures to test-fixtures', () => {
    const result = mapPathToArtifacts('tests/fixtures/data.json');
    assert.ok(result.some((m) => m.artifact === 'test-fixtures'));
  });

  it('maps root markdown files to root-docs', () => {
    const result = mapPathToArtifacts('README.md');
    assert.ok(result.some((m) => m.artifact === 'root-docs'));
  });

  it('returns empty array for unmapped paths', () => {
    const result = mapPathToArtifacts('src/core/feature.ts');
    assert.equal(result.length, 0);
  });

  it('includes custom mappings', () => {
    const custom: ArtifactMapping[] = [
      { pattern: 'src/features/**', artifact: 'features', category: 'type_definition' },
    ];
    const result = mapPathToArtifacts('src/features/foo.ts', custom);
    assert.ok(result.some((m) => m.artifact === 'features'));
  });
});

describe('detectArtifactConflicts', () => {
  it('detects type definition conflicts', () => {
    const conflicts = detectArtifactConflicts([
      ['slice-a', ['src/core/types.ts']],
      ['slice-b', ['src/other/types.ts']],
    ]);
    assert.ok(conflicts.length > 0);
    const typeConflict = conflicts.find((c) => c.artifact === 'type-definitions');
    assert.ok(typeConflict);
    assert.equal(typeConflict!.severity, 'error');
  });

  it('detects schema conflicts', () => {
    const conflicts = detectArtifactConflicts([
      ['slice-a', ['contracts/schemas/policy.json']],
      ['slice-b', ['contracts/schemas/event-envelope.json']],
    ]);
    assert.ok(conflicts.length > 0);
    const schemaConflict = conflicts.find((c) => c.artifact === 'contract-schemas');
    assert.ok(schemaConflict);
    assert.equal(schemaConflict!.severity, 'warning');
  });

  it('detects documentation conflicts as info', () => {
    const conflicts = detectArtifactConflicts([
      ['slice-a', ['docs/guide.md']],
      ['slice-b', ['docs/api.md']],
    ]);
    assert.ok(conflicts.length > 0);
    const docConflict = conflicts.find((c) => c.artifact === 'documentation');
    assert.ok(docConflict);
    assert.equal(docConflict!.severity, 'info');
  });

  it('returns no conflicts for unrelated write-sets', () => {
    const conflicts = detectArtifactConflicts([
      ['slice-a', ['src/core/feature-a.ts']],
      ['slice-b', ['src/cli/commands.ts']],
    ]);
    assert.equal(conflicts.length, 0);
  });

  it('sorts conflicts by severity (error first)', () => {
    const conflicts = detectArtifactConflicts([
      ['slice-a', ['src/core/types.ts']],
      ['slice-b', ['docs/guide.md']],
      ['slice-c', ['src/types.d.ts', 'docs/api.md']],
    ]);
    // Should have at least 2 conflicts (type-definitions and documentation)
    assert.ok(conflicts.length >= 2);
    // Error severity should come before info
    const severities = conflicts.map((c) => c.severity);
    const firstError = severities.indexOf('error');
    const firstInfo = severities.indexOf('info');
    assert.ok(firstError < firstInfo, 'error should sort before info');
  });

  it('includes custom mappings in conflict detection', () => {
    const custom: ArtifactMapping[] = [
      { pattern: 'src/features/**', artifact: 'features', category: 'api_contract' },
    ];
    const conflicts = detectArtifactConflicts([
      ['slice-a', ['src/features/api.ts']],
      ['slice-b', ['src/features/routes.ts']],
    ], custom);
    assert.ok(conflicts.length > 0);
    const featureConflict = conflicts.find((c) => c.artifact === 'features');
    assert.ok(featureConflict);
    assert.equal(featureConflict!.severity, 'error');
  });

  it('handles single slice (no conflicts)', () => {
    const conflicts = detectArtifactConflicts([
      ['slice-a', ['src/core/types.ts']],
    ]);
    assert.equal(conflicts.length, 0);
  });

  it('handles empty slices', () => {
    const conflicts = detectArtifactConflicts([]);
    assert.equal(conflicts.length, 0);
  });

  it('sets correct slice identifiers on conflicts', () => {
    const conflicts = detectArtifactConflicts([
      ['alpha', ['src/core/types.ts']],
      ['beta', ['src/other/types.ts']],
    ]);
    const typeConflict = conflicts.find((c) => c.artifact === 'type-definitions');
    assert.ok(typeConflict);
    assert.equal(typeConflict!.sliceA, 'alpha');
    assert.equal(typeConflict!.sliceB, 'beta');
  });
});

describe('BUILTIN_MAPPINGS', () => {
  it('has at least 16 built-in mappings', () => {
    assert.ok(BUILTIN_MAPPINGS.length >= 16);
  });

  it('covers all artifact categories', () => {
    const categories = new Set(BUILTIN_MAPPINGS.map((m) => m.category));
    assert.ok(categories.has('type_definition'));
    assert.ok(categories.has('api_contract'));
    assert.ok(categories.has('schema'));
    assert.ok(categories.has('config'));
    assert.ok(categories.has('test_fixture'));
    assert.ok(categories.has('documentation'));
  });

  it('all patterns start with valid characters', () => {
    for (const m of BUILTIN_MAPPINGS) {
      assert.ok(m.pattern.length > 0);
    }
  });
});
