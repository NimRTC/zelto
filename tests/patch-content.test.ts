/**
 * Tests for patch-content command — helper functions and non-interactive mode.
 *
 * C4: every action writes append-only events
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// ─── Test subject imports ───────────────────────────────────────────────────

import {
  getSliceIds,
  getMostRecentSliceId,
  writePatchFiles,
  runPatchContent,
  type DiffLine,
  type PatchResult,
} from '../src/cli/commands/patch-content.js';

// ─── Test setup ──────────────────────────────────────────────────────────────

const TEST_DIR = join('.zelto', 'patches');
const TEST_SLICES_DIR = join('.zelto', 'slices');
const TEST_PATCH_FILE = 'src/temp-patch-test-file.txt';
const ORIGINAL_PATCH_CONTENT = 'original content\n';

/**
 * The non-interactive mode reads `git diff` of the current working directory,
 * so it needs a repository whose state the test fully controls — otherwise
 * the result depends on whatever the developer happens to have modified.
 */
const GIT_REPO_DIR = join(
  tmpdir(),
  `zelto-patch-content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);

function git(args: string): void {
  execSync(`git ${args}`, {
    cwd: GIT_REPO_DIR,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

before(() => {
  // Ensure .zelto/slices exists for getSliceIds()
  if (!existsSync(TEST_SLICES_DIR)) {
    mkdirSync(TEST_SLICES_DIR, { recursive: true });
  }

  // Create a test slice for getSliceIds() to find
  const testSlicePath = join(TEST_SLICES_DIR, 'test-slice.json');
  if (!existsSync(testSlicePath)) {
    writeFileSync(testSlicePath, JSON.stringify({
      id: 'test-slice',
      title: 'Test Slice',
      state: 'draft',
      spec: { path: 'specs/slices/test-slice.md', frozenHash: null, frozenAt: null },
      acceptance: { dir: 'tests/acceptance/test-slice/', frozenHash: null, oracleSrc: null },
      baseCommit: null,
      drift: { detected: false, reason: null, at: null },
      trace: { requirements: [], contracts: [], tests: [] },
      traceWaiver: null,
      writes: [],
      runs: [],
      stall: { class: null, autoResolved: 0, gateRetries: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }), 'utf-8');
  }

  // ── Isolated git repository for the non-interactive mode ──────────────
  mkdirSync(join(GIT_REPO_DIR, 'src'), { recursive: true });
  git('init');
  git('config user.email "zelto@example.com"');
  git('config user.name "Zelto Test"');
  git('config core.autocrlf false');
  writeFileSync(join(GIT_REPO_DIR, TEST_PATCH_FILE), ORIGINAL_PATCH_CONTENT, 'utf-8');
  git('add -A');
  git('commit -m "init"');
});

after(() => {
  // Clean up test artifacts
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
  try {
    const testSlicePath = join(TEST_SLICES_DIR, 'test-slice.json');
    if (existsSync(testSlicePath)) rmSync(testSlicePath, { force: true });
  } catch { /* ok */ }
  try { rmSync(GIT_REPO_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('patch-content — getSliceIds()', () => {
  it('should return slice IDs from .zelto/slices/', () => {
    const ids = getSliceIds();
    assert.ok(Array.isArray(ids), 'should return an array');
    assert.ok(ids.length > 0, 'should find at least one slice');
    assert.ok(ids.includes('test-slice'), 'should find the test slice');
  });
});

describe('patch-content — writePatchFiles()', () => {
  it('should write .patch files for assigned lines', async () => {
    const diffLines: DiffLine[] = [
      { index: 1, content: 'diff --git a/file.ts b/file.ts', sliceId: 'test-slice' },
      { index: 2, content: 'index abc..def 100644', sliceId: 'test-slice' },
      { index: 3, content: '--- a/file.ts', sliceId: 'test-slice' },
      { index: 4, content: '+++ b/file.ts', sliceId: 'test-slice' },
      { index: 5, content: '@@ -1,3 +1,4 @@', sliceId: 'test-slice' },
      { index: 6, content: ' unchanged line', sliceId: 'test-slice' },
      { index: 7, content: '+added line', sliceId: 'test-slice' },
      { index: 8, content: '-removed line', sliceId: null }, // skipped
    ];

    const result = await writePatchFiles(diffLines, 'unstaged');

    assert.ok(result !== null, 'should return a result');
    assert.equal(result.writtenFiles.length, 1, 'should write 1 patch file');
    assert.equal(result.writtenFiles[0], 'test-slice-001.patch');
    assert.equal(result.totalLines, 8);
    assert.equal(result.assignedLines, 7);
    assert.equal(result.skippedLines, 1);
    assert.equal(result.sliceCount, 1);

    // Verify file content
    const patchPath = join(TEST_DIR, 'test-slice-001.patch');
    assert.ok(existsSync(patchPath), 'patch file should exist');
    const content = readFileSync(patchPath, 'utf-8');
    assert.ok(content.includes('diff --git a/file.ts b/file.ts'), 'should contain diff header');
    assert.ok(content.includes('+added line'), 'should contain added line');
    assert.ok(!content.includes('-removed line'), 'should NOT contain skipped line');
  });

  it('should return null when no lines are assigned', async () => {
    const diffLines: DiffLine[] = [
      { index: 1, content: 'diff --git a/file.ts b/file.ts', sliceId: null },
      { index: 2, content: '+some change', sliceId: null },
    ];

    const result = await writePatchFiles(diffLines, 'unstaged');
    assert.equal(result, null, 'should return null for empty assignment');
  });

  it('should order patches by first occurrence of slice IDs', async () => {
    const diffLines: DiffLine[] = [
      { index: 1, content: 'line1', sliceId: 'slice-a' },
      { index: 2, content: 'line2', sliceId: 'slice-b' },
      { index: 3, content: 'line3', sliceId: 'slice-a' },
    ];

    const result = await writePatchFiles(diffLines, 'unstaged');

    assert.ok(result !== null);
    assert.equal(result.writtenFiles.length, 2);
    assert.equal(result.writtenFiles[0], 'slice-a-001.patch');
    assert.equal(result.writtenFiles[1], 'slice-b-002.patch');
  });
});

describe('patch-content — non-interactive mode', () => {
  const originalCwd = process.cwd();

  before(() => {
    // runPatchContent() runs `git diff` in the current working directory.
    process.chdir(GIT_REPO_DIR);
  });

  after(() => {
    process.chdir(originalCwd);
  });

  it('should handle non-empty diff and produce patch files', async () => {
    // Modify the committed file so git detects a change
    writeFileSync(join(GIT_REPO_DIR, TEST_PATCH_FILE), 'test content for patch\n', 'utf-8');

    const result = await runPatchContent('unstaged', 'test-slice');
    assert.ok(result !== null, 'should produce a result');
    assert.ok(result.writtenFiles.length > 0, 'should write at least one patch file');
    assert.equal(result.source, 'unstaged');
    assert.equal(result.sliceCount, 1);

    // Verify file has content
    const patchContent = readFileSync(join(GIT_REPO_DIR, TEST_DIR, result.writtenFiles[0]), 'utf-8');
    assert.ok(patchContent.includes(TEST_PATCH_FILE), 'patch should reference the test file');
  });

  it('should handle empty diff gracefully', async () => {
    // Restore the committed content so the working tree is clean again
    writeFileSync(join(GIT_REPO_DIR, TEST_PATCH_FILE), ORIGINAL_PATCH_CONTENT, 'utf-8');

    const result = await runPatchContent('unstaged', 'test-slice');
    // If no diff, result is null
    assert.ok(result === null, 'should return null for empty diff');
  });
});
