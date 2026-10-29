import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-create-spec-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const SPECS_DIR = join(TEST_DIR, 'specs', 'slices');

/**
 * Test spec fixture with ## 范围 and ## 验收标准 sections.
 */
const SAMPLE_SPEC = [
  '# Slice: v1-my-feature',
  '',
  '## 目的',
  'Test feature for --from-spec parsing',
  '',
  '## 范围',
  '- `src/feature-a/**`',
  '- `src/feature-b/**`',
  '',
  '## 验收标准',
  '1. Feature A works correctly',
  '2. Feature B integrates with A',
  '3. All tests pass',
  '',
  '## 风险',
  '- None',
  '',
].join('\n');

/**
 * Spec with no backtick paths (writes should be empty).
 */
const MINIMAL_SPEC = [
  '# Slice: minimal',
  '',
  '## 目的',
  'Minimal spec for testing',
  '',
  '## 范围',
  '- Read the config file',
  '',
  '## 验收标准',
  '1. Everything works',
  '',
].join('\n');

describe('zelto create --from-spec', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(SPECS_DIR, { recursive: true });
    await writeFile(join(SPECS_DIR, 'v1-my-feature.md'), SAMPLE_SPEC, 'utf-8');
    await writeFile(join(SPECS_DIR, 'minimal.md'), MINIMAL_SPEC, 'utf-8');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  function runCreate(...args: string[]): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI_SCRIPT, 'create', ...args], {
        cwd: TEST_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code) => resolve({ stdout: stdout || stderr, code: code ?? 1 }));
      child.on('error', reject);
    });
  }

  it('parses writes from ## 范围 section', async () => {
    const { stdout, code } = await runCreate('v1-my-feature', '--from-spec');

    assert.equal(code, 0);
    assert.ok(stdout.includes('v1-my-feature'));

    const slicePath = join(TEST_DIR, '.zelto', 'slices', 'v1-my-feature.json');
    assert.ok(existsSync(slicePath));

    const content = JSON.parse(await readFile(slicePath, 'utf-8'));
    assert.equal(content.id, 'v1-my-feature');
    assert.ok(content.writes.includes('src/feature-a/**'));
    assert.ok(content.writes.includes('src/feature-b/**'));
    assert.equal(content.writes.length, 2);
  });

  it('parses requirements from ## 验收标准 section', async () => {
    const content = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'slices', 'v1-my-feature.json'), 'utf-8'),
    );
    assert.equal(content.trace.requirements.length, 3);
    assert.ok(content.trace.requirements[0].includes('Feature A works'));
    assert.ok(content.trace.requirements[1].includes('Feature B integrates'));
    assert.ok(content.trace.requirements[2].includes('All tests pass'));
  });

  it('detects v0- prefix as baseline slice', async () => {
    // Write a v0- spec
    const v0Spec = [
      '# Slice: v0-baseline-test',
      '',
      '## 目的',
      'Baseline test',
      '',
      '## 范围',
      '- `src/log/*`',
      '',
      '## 验收标准',
      '1. Existing code unchanged',
      '',
    ].join('\n');
    await writeFile(join(SPECS_DIR, 'v0-baseline-test.md'), v0Spec, 'utf-8');

    const { stdout, code } = await runCreate('v0-baseline-test', '--from-spec');
    assert.equal(code, 0);

    const content = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'slices', 'v0-baseline-test.json'), 'utf-8'),
    );
    assert.equal(content.baseline, true);
    assert.ok(content.traceWaiver);
  });

  it('does not set baseline for v1- prefix', async () => {
    const content = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'slices', 'v1-my-feature.json'), 'utf-8'),
    );
    assert.equal(content.baseline, false);
  });

  it('parses title from # Slice: heading', async () => {
    const content = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'slices', 'v1-my-feature.json'), 'utf-8'),
    );
    assert.equal(content.title, 'v1-my-feature');
  });

  it('reports error when spec file is missing', async () => {
    const { stdout, code } = await runCreate('non-existent-slice', '--from-spec');
    assert.notEqual(code, 0);
    assert.ok(stdout.includes('not found') || stdout.includes('missing'));
  });

  it('respects explicit --writes over spec parsing', async () => {
    // Use a different slice ID to avoid conflict with previous create
    const explicitSpec = [
      '# Slice: v1-explicit-writes',
      '',
      '## 目的',
      'Explicit writes test',
      '',
      '## 范围',
      '- `src/from-spec/**`',
      '',
      '## 验收标准',
      '1. Explicit writes take precedence',
      '',
    ].join('\n');
    await writeFile(join(SPECS_DIR, 'v1-explicit-writes.md'), explicitSpec, 'utf-8');

    const { stdout, code } = await runCreate('v1-explicit-writes', '--from-spec', '--writes', 'custom/**');
    assert.equal(code, 0);

    const content = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'slices', 'v1-explicit-writes.json'), 'utf-8'),
    );
    // With explicit --writes, it should use the CLI value instead of spec
    assert.ok(content.writes.includes('custom/**'));
    assert.equal(content.writes.length, 1);
  });

  it('works with --json output', async () => {
    const { stdout, code } = await runCreate('minimal', '--from-spec', '--json');
    assert.equal(code, 0);

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.id, 'minimal');
    assert.equal(parsed.success, true);
    assert.equal(parsed.baseline, false);
    assert.equal(parsed.requirements, 1);
  });

  it('handles spec with no backtick paths (empty writes)', async () => {
    const content = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'slices', 'minimal.json'), 'utf-8'),
    );
    assert.equal(content.id, 'minimal');
    assert.equal(content.writes.length, 0);
    assert.equal(content.trace.requirements.length, 1);
  });
});
