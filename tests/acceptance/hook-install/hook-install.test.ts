// Acceptance test: hook-install
// Verifies that zelto hook --install/--uninstall/--status work correctly
// Tests run in an isolated temp git repo to avoid affecting project hooks

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const BASE_DIR = join(tmpdir(), `zelto-acceptance-hook-install-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const GIT_HOOKS_DIR = join(BASE_DIR, '.git', 'hooks');
const HOOK_MARKER = '# zelto-hook — DO NOT EDIT';

function zelto(...args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync('node', [CLI_SCRIPT, ...args], {
    cwd: BASE_DIR,
    encoding: 'utf-8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? 1,
  };
}

describe('acceptance: hook-install', { concurrency: false }, () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(BASE_DIR, { recursive: true });

    // Initialize a git repo for testing hooks
    const initResult = spawnSync('git', ['init'], { cwd: BASE_DIR, encoding: 'utf-8' });
    if (initResult.status !== 0) {
      throw new Error(`git init failed: ${initResult.stderr}`);
    }

    // Create minimal .zelto/ so commands work
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('zelto hook --install creates pre-commit and pre-push scripts', () => {
    const result = zelto('hook', '--install');
    assert.equal(result.code, 0, `hook --install should exit 0: ${result.stderr}`);

    // Check pre-commit exists
    assert.ok(existsSync(join(GIT_HOOKS_DIR, 'pre-commit')), 'pre-commit should exist');
    assert.ok(existsSync(join(GIT_HOOKS_DIR, 'pre-push')), 'pre-push should exist');
  });

  it('installed hook scripts contain zelto marker', async () => {
    const preCommit = await readFile(join(GIT_HOOKS_DIR, 'pre-commit'), 'utf-8');
    assert.ok(preCommit.includes(HOOK_MARKER), 'pre-commit should contain zelto marker');

    const prePush = await readFile(join(GIT_HOOKS_DIR, 'pre-push'), 'utf-8');
    assert.ok(prePush.includes(HOOK_MARKER), 'pre-push should contain zelto marker');
  });

  it('zelto hook --status reports installed', () => {
    const result = zelto('hook', '--status');
    assert.equal(result.code, 0, `hook --status should exit 0: ${result.stderr}`);
    assert.ok(result.stdout.includes('installed'), 'status should mention installed');
  });

  it('zelto hook --uninstall removes hook scripts', () => {
    const result = zelto('hook', '--uninstall');
    assert.equal(result.code, 0, `hook --uninstall should exit 0: ${result.stderr}`);

    // Hook files should be removed
    assert.ok(!existsSync(join(GIT_HOOKS_DIR, 'pre-commit')), 'pre-commit should be removed');
    assert.ok(!existsSync(join(GIT_HOOKS_DIR, 'pre-push')), 'pre-push should be removed');
  });

  it('zelto hook --status reports not installed after uninstall', () => {
    const result = zelto('hook', '--status');
    assert.equal(result.code, 0, `hook --status should exit 0: ${result.stderr}`);
    // Should show "not installed" for removed hooks
    assert.ok(result.stdout.includes('not installed'), 'status should show not installed');
  });

  it('does not overwrite non-zelto hooks', async () => {
    // Re-install hooks first to set up baseline
    zelto('hook', '--install');

    // Create a non-zelto hook by modifying pre-commit
    const customHook = '#!/bin/sh\necho "custom hook"';
    await writeFile(join(GIT_HOOKS_DIR, 'pre-commit'), customHook, 'utf-8');

    // Run --install again — should warn about existing non-zelto hook
    const result = zelto('hook', '--install');
    assert.equal(result.code, 0, `hook --install should exit 0: ${result.stderr}`);
    // The existing non-zelto hook should NOT be overwritten
    const content = await readFile(join(GIT_HOOKS_DIR, 'pre-commit'), 'utf-8');
    assert.equal(content, customHook, 'non-zelto hook should not be overwritten');
    // But pre-push (which was zelto) may have been reinstalled
  });
});
