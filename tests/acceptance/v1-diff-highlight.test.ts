/**
 * Acceptance tests for `zelto diff-highlight` command.
 *
 * Tests pipe a unified diff to stdin and verify ANSI color codes
 * in the output. These tests are frozen with the spec and must
 * not be modified without updating the spec and re-freezing.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `zelto-diff-highlight-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

/**
 * Run a CLI command with stdin input.
 */
function runCliWithStdin(
  ...args: string[]
): (stdin: string) => Promise<{ stdout: string; stderr: string; code: number }> {
  return (stdin: string) =>
    new Promise((resolve, reject) => {
      const child = spawn('node', [CLI_SCRIPT, ...args], {
        cwd: TEST_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
      child.on('error', reject);
      // Write stdin and close it
      child.stdin.write(stdin);
      child.stdin.end();
    });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_DIFF = [
  'diff --git a/src/hello.ts b/src/hello.ts',
  'index abc123..def456 100644',
  '--- a/src/hello.ts',
  '+++ b/src/hello.ts',
  '@@ -1,5 +1,6 @@',
  ' const greeting = "hello";',
  ' ',
  '-console.log(greeting);',
  '+console.log(greeting.toUpperCase());',
  '+console.log("world");',
  '',
].join('\n');

const MULTI_FILE_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'new file mode 100644',
  'index 0000000..abc1234',
  '--- /dev/null',
  '+++ b/src/foo.ts',
  '@@ -0,0 +1,3 @@',
  '+export function foo() {',
  '+  return 42;',
  '+}',
  'diff --git a/src/bar.ts b/src/bar.ts',
  'deleted file mode 100644',
  'index abc1234..0000000',
  '--- a/src/bar.ts',
  '+++ /dev/null',
  '@@ -1,5 +0,0 @@',
  '-export function bar() {',
  '-  return "old";',
  '-}',
].join('\n');

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

before(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  // Initialize zelto project so the CLI has a working directory
  const initChild = spawn('node', [CLI_SCRIPT, 'init'], {
    cwd: TEST_DIR,
    stdio: 'pipe',
  });
  await new Promise<void>((resolve) => {
    initChild.on('close', () => resolve());
  });
});

after(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

void describe('zelto diff-highlight', () => {
  void it('highlights additions with green background', async () => {
    const run = runCliWithStdin('diff-highlight');
    const { stdout, code } = await run(SAMPLE_DIFF);
    assert.equal(code, 0);
    // Green background ANSI code
    assert.ok(stdout.includes('\x1b[42m'), 'output should contain green background ANSI code');
    // The added line should be present
    assert.ok(stdout.includes('+console.log(greeting.toUpperCase())'));
  });

  void it('highlights deletions with red background', async () => {
    const run = runCliWithStdin('diff-highlight');
    const { stdout, code } = await run(SAMPLE_DIFF);
    assert.equal(code, 0);
    // Red background ANSI code
    assert.ok(stdout.includes('\x1b[41m'), 'output should contain red background ANSI code');
    // The removed line should be present
    assert.ok(stdout.includes('-console.log(greeting);'));
  });

  void it('highlights diff header lines in bold yellow', async () => {
    const run = runCliWithStdin('diff-highlight');
    const { stdout, code } = await run(SAMPLE_DIFF);
    assert.equal(code, 0);
    // Bold yellow combined ANSI code (\x1b[1;33m)
    assert.ok(stdout.includes('\x1b[1;33m'),
      'output should contain bold yellow ANSI code for headers');
    assert.ok(stdout.includes('diff --git a/src/hello.ts b/src/hello.ts'));
    assert.ok(stdout.includes('--- a/src/hello.ts'));
    assert.ok(stdout.includes('+++ b/src/hello.ts'));
  });

  void it('highlights multi-file diff correctly', async () => {
    const run = runCliWithStdin('diff-highlight');
    const { stdout, code } = await run(MULTI_FILE_DIFF);
    assert.equal(code, 0);
    // Both diff headers present
    assert.ok(stdout.includes('diff --git a/src/foo.ts b/src/foo.ts'));
    assert.ok(stdout.includes('diff --git a/src/bar.ts b/src/bar.ts'));
    // Green background for additions
    assert.ok(stdout.includes('\x1b[42m'));
    // Red background for deletions
    assert.ok(stdout.includes('\x1b[41m'));
    // new file / deleted file lines
    assert.ok(stdout.includes('new file mode'));
    assert.ok(stdout.includes('deleted file mode'));
  });

  void it('handles empty input with error', async () => {
    const run = runCliWithStdin('diff-highlight');
    const { stderr, code } = await run('');
    assert.equal(code, 1);
    assert.ok(stderr.length > 0);
  });

  void it('handles diff with only context lines', async () => {
    const contextOnly = [
      'diff --git a/test.txt b/test.txt',
      '--- a/test.txt',
      '+++ b/test.txt',
      '@@ -1,3 +1,3 @@',
      ' unchanged line',
      ' still unchanged',
      ' no changes here',
    ].join('\n');
    const run = runCliWithStdin('diff-highlight');
    const { stdout, code } = await run(contextOnly);
    assert.equal(code, 0);
    // Header should still be highlighted
    assert.ok(stdout.includes('diff --git a/test.txt b/test.txt'));
    // Context lines should not have background colors
    assert.ok(stdout.includes(' unchanged line'));
  });
});
