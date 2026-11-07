import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-clarify-test');
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function zelto(...args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: BASE_DIR,
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

describe('acceptance: zelto clarify', () => {
  before(async () => {
    await mkdir(BASE_DIR, { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
    await writeFile(join(BASE_DIR, '.zelto', 'config.yaml'), [
      'gate:',
      '  commands:',
      '    - { name: test, run: "echo ok" }',
      '    - { name: lint, run: "echo ok" }',
      '  timeoutSec: 30',
      '  retry:',
      '    max: 1',
      'agent:',
      '  command: "echo"',
      '',
    ].join('\n'), 'utf-8');
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('auto-answers questions and freezes slice', async () => {
    await zelto('create', 'auto-slice', '--title', 'Auto Slice');

    const { stdout, code } = await zelto('clarify', 'auto-slice', '--auto');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);

    // Should list questions
    assert.ok(stdout.includes('Questions:'), 'should show question count');
    assert.ok(stdout.includes('Questions: 5'), 'should have 5 questions for empty slice');
    assert.ok(stdout.includes('auto-answered'), 'should auto-answer');
    assert.ok(stdout.includes('frozen'), 'should freeze after clarification');

    // Verify state is frozen
    const sliceFile = await readFile(join(BASE_DIR, '.zelto', 'slices', 'auto-slice.json'), 'utf-8');
    const slice = JSON.parse(sliceFile);
    assert.equal(slice.state, 'frozen', 'slice should be frozen after --auto');
  });

  it('dry-run lists questions without changing state', async () => {
    await zelto('create', 'dry-slice', '--title', 'Dry Run Slice');

    const { stdout, code } = await zelto('clarify', 'dry-slice', '--dry-run');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);

    // Should list questions
    assert.ok(stdout.includes('Questions:'), 'should show question count');
    assert.ok(stdout.includes('without --dry-run'), 'should mention --dry-run hint');

    // Verify state is still draft
    const sliceFile = await readFile(join(BASE_DIR, '.zelto', 'slices', 'dry-slice.json'), 'utf-8');
    const slice = JSON.parse(sliceFile);
    assert.equal(slice.state, 'draft', 'slice should remain draft after dry-run');
  });

  it('rejects non-draft slices', async () => {
    // Create and freeze a slice first
    await zelto('create', 'frozen-slice', '--requirement', 'REQ-1: 已冻结的切片不该再澄清');
    await zelto('freeze', 'frozen-slice');

    const { stdout, code } = await zelto('clarify', 'frozen-slice', '--auto');
    assert.notEqual(code, 0, 'should fail for non-draft slice');
    assert.ok(stdout.includes('frozen'), 'should mention current state');
  });
});
