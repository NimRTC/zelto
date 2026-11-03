// Tests for the post-run write-set audit (ADR-014 §5)

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditWorktreeWrites,
  parsePorcelainStatus,
  hashFile,
} from '../../../src/core/sched/audit.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-audit-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  mkdirSync(join(dir, 'src', 'core'), { recursive: true });
  writeFileSync(join(dir, 'src', 'core', 'seed.ts'), 'export const seed = 0;\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('parsePorcelainStatus', () => {
  it('extracts the path from each status line', () => {
    const output = [
      ' M src/core/a.ts',
      '?? src/core/b.ts',
      'A  src/core/c.ts',
      'R  old.ts -> new.ts',
      '!! ignored.ts',
    ].join('\n');

    const paths = parsePorcelainStatus(output);
    assert.ok(paths.includes('src/core/a.ts'));
    assert.ok(paths.includes('src/core/b.ts'));
    assert.ok(paths.includes('src/core/c.ts'));
    // Renames report the destination.
    assert.ok(paths.includes('new.ts'));
    assert.ok(!paths.includes('ignored.ts'));
  });

  it('unquotes paths with special characters', () => {
    const paths = parsePorcelainStatus('?? "src/a b\\u00e9.ts"');
    assert.deepEqual(paths, ['src/a bé.ts']);
  });

  it('returns nothing for empty output', () => {
    assert.deepEqual(parsePorcelainStatus(''), []);
  });
});

describe('hashFile', () => {
  it('hashes a file and returns null for a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zelto-hash-'));
    try {
      const file = join(dir, 'a.txt');
      writeFileSync(file, 'hello', 'utf-8');
      const hash = hashFile(file);
      assert.ok(hash);
      assert.match(hash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(hashFile(join(dir, 'missing.txt')), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('auditWorktreeWrites', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports no violations when everything is inside the write-set', () => {
    writeFileSync(join(repo, 'src', 'core', 'a.ts'), 'export const a = 1;\n', 'utf-8');

    const result = auditWorktreeWrites(repo, ['src/core/**']);
    assert.equal(result.error, null);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.tampered, []);
    assert.ok(result.changed.includes('src/core/a.ts'));
  });

  it('reports a write outside the write-set as a violation', () => {
    writeFileSync(join(repo, 'src', 'core', 'a.ts'), 'export const a = 1;\n', 'utf-8');
    mkdirSync(join(repo, 'src', 'policy'), { recursive: true });
    writeFileSync(join(repo, 'src', 'policy', 'b.ts'), 'export const b = 2;\n', 'utf-8');

    const result = auditWorktreeWrites(repo, ['src/core/**']);
    assert.deepEqual(result.violations, ['src/policy/b.ts']);
  });

  it('counts untracked files too', () => {
    writeFileSync(join(repo, 'src', 'core', 'new.ts'), 'export const n = 1;\n', 'utf-8');
    writeFileSync(join(repo, 'stray.ts'), 'export const s = 1;\n', 'utf-8');

    const result = auditWorktreeWrites(repo, ['src/core/**']);
    assert.deepEqual(result.violations, ['stray.ts']);
  });

  it('ignores zelto-managed paths but flags them when their content changes', () => {
    const managedPath = '.claude/settings.local.json';
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, managedPath), '{"hooks":{}}\n', 'utf-8');

    const hash = hashFile(join(repo, managedPath));
    assert.ok(hash);

    const clean = auditWorktreeWrites(repo, ['src/core/**'], {
      managed: [{ path: managedPath, hash }],
    });
    assert.deepEqual(clean.violations, []);
    assert.deepEqual(clean.tampered, []);

    // The agent rewrote the hook settings — the gate could have been turned off.
    writeFileSync(join(repo, managedPath), '{"hooks":{"PreToolUse":[]}}\n', 'utf-8');
    const tampered = auditWorktreeWrites(repo, ['src/core/**'], {
      managed: [{ path: managedPath, hash }],
    });
    assert.deepEqual(tampered.violations, []);
    assert.deepEqual(tampered.tampered, [managedPath]);
  });

  it('reports an error instead of throwing when git is unavailable', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'zelto-notrepo-'));
    try {
      const result = auditWorktreeWrites(notARepo, ['src/**']);
      assert.ok(result.error);
      assert.match(result.error, /git status 失败/);
      assert.deepEqual(result.violations, []);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
