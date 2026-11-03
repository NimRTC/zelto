// Tests for write-set path matching — the single implementation used by
// admission, merge conflict detection and runtime enforcement.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  pathInWriteSet,
  pathMatches,
  pathsOverlap,
  writeSetsOverlap,
} from '../../../src/core/sched/paths.js';

describe('pathMatches', () => {
  it('matches a single-level glob', () => {
    assert.equal(pathMatches('docs/a.md', 'docs/*.md'), true);
    assert.equal(pathMatches('docs/sub/a.md', 'docs/*.md'), false);
  });

  it('matches a multi-level glob', () => {
    assert.equal(pathMatches('src/core/a.ts', 'src/**'), true);
    assert.equal(pathMatches('src/a.ts', 'src/**'), true);
    assert.equal(pathMatches('lib/a.ts', 'src/**'), false);
  });
});

describe('pathInWriteSet', () => {
  it('accepts an exact path', () => {
    assert.equal(pathInWriteSet('src/core/a.ts', ['src/core/a.ts']), true);
    assert.equal(pathInWriteSet('src/core/b.ts', ['src/core/a.ts']), false);
  });

  it('accepts anything under a directory prefix', () => {
    assert.equal(pathInWriteSet('src/core/deep/a.ts', ['src/core/']), true);
    assert.equal(pathInWriteSet('src/core/deep/a.ts', ['src/core']), true);
    assert.equal(pathInWriteSet('src/other/a.ts', ['src/core']), false);
  });

  it('does not let a prefix swallow a sibling with a shared name', () => {
    assert.equal(pathInWriteSet('src/core-extra/a.ts', ['src/core']), false);
  });

  it('accepts a glob match', () => {
    assert.equal(pathInWriteSet('src/core/a.ts', ['src/**']), true);
    assert.equal(pathInWriteSet('src/core/a.ts', ['**/a.ts']), true);
    assert.equal(pathInWriteSet('docs/a.md', ['src/**']), false);
  });

  it('normalises Windows separators', () => {
    assert.equal(pathInWriteSet('src\\core\\a.ts', ['src/core/**']), true);
  });

  it('rejects everything when the write-set is empty', () => {
    assert.equal(pathInWriteSet('src/core/a.ts', []), false);
  });
});

describe('pathsOverlap', () => {
  it('detects identical paths', () => {
    assert.equal(pathsOverlap('src/a.ts', 'src/a.ts'), true);
  });

  it('detects directory containment', () => {
    assert.equal(pathsOverlap('src/', 'src/a.ts'), true);
    assert.equal(pathsOverlap('src/a.ts', 'src/'), true);
  });

  it('detects glob against a concrete path', () => {
    assert.equal(pathsOverlap('src/**', 'src/a.ts'), true);
    assert.equal(pathsOverlap('src/a.ts', 'src/**'), true);
    assert.equal(pathsOverlap('src/**', 'lib/a.ts'), false);
  });

  it('detects glob against glob by directory prefix', () => {
    assert.equal(pathsOverlap('src/core/**', 'src/core/x/**'), true);
    assert.equal(pathsOverlap('src/core/**', 'src/other/**'), false);
  });
});

describe('writeSetsOverlap', () => {
  it('finds the overlapping pair', () => {
    assert.equal(writeSetsOverlap(['src/**'], ['src/core/**']), true);
    assert.equal(writeSetsOverlap(['src/**'], ['docs/**']), false);
  });
});
