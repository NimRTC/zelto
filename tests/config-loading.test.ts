import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const TEST_DIR = join(tmpdir(), `zelto-config-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

describe('config loading', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, 'policy'), { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  function runCommand(...args: string[]): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI_SCRIPT, ...args], {
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

  it('reads policy.yaml for policy decisions', async () => {
    // Create a custom policy
    await writeFile(join(TEST_DIR, 'policy', 'policy.yaml'), `
rules:
  - id: allow-all
    match: { path: "**", operation: "write" }
    action: allow
    basis: "test.yaml#allow-all"
`, 'utf-8');

    // Create a slice
    await runCommand('create', 'policy-test', '--title', 'Policy Test', '--requirement', 'REQ-1: 策略判定要读 policy.yaml');
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'policy-test.md'), '# test', 'utf-8');
    await runCommand('freeze', 'policy-test');

    // Read the slice and check frozenHash is a real sha256
    const content = JSON.parse(await readFile(join(TEST_DIR, '.zelto', 'slices', 'policy-test.json'), 'utf-8'));
    assert.ok(content.spec.frozenHash?.startsWith('sha256:'));
    assert.ok(content.spec.frozenHash.length > 20); // real hash, not Date.now()
  });

  it('reads config.yaml for gate commands', async () => {
    // Create a custom config
    await writeFile(join(TEST_DIR, '.zelto', 'config.yaml'), `
gate:
  commands:
    - name: echo-test
      run: echo hello
  timeoutSec: 30
  retry:
    max: 1
`, 'utf-8');

    // Create and freeze a slice, then run gate
    await runCommand('create', 'gate-config-test', '--title', 'Gate Config Test', '--requirement', 'REQ-2: 门禁命令要读 config.yaml');
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'gate-config-test.md'), '# test gate config', 'utf-8');
    await runCommand('freeze', 'gate-config-test');

    const { stdout, code } = await runCommand('gate', 'gate-config-test');
    assert.equal(code, 0, `Gate failed: ${stdout}`);
    assert.ok(stdout.includes('echo-test'), `Should use custom command: ${stdout}`);
  });

  it('falls back to defaults when policy.yaml is missing', async () => {
    // Remove policy dir
    await rm(join(TEST_DIR, 'policy'), { recursive: true, force: true });

    // Create a slice and freeze — should use default policy
    await runCommand('create', 'no-policy-test', '--title', 'No Policy', '--requirement', 'REQ-3: 缺 policy.yaml 时冻结仍按默认规则工作');
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'no-policy-test.md'), '# test', 'utf-8');
    const { stdout, code } = await runCommand('freeze', 'no-policy-test');
    assert.equal(code, 0, `Freeze failed: ${stdout}`);
  });

  it('falls back to defaults when config.yaml is missing', async () => {
    // Remove config
    await rm(join(TEST_DIR, '.zelto', 'config.yaml'), { recursive: true, force: true });

    // Gate should work with defaults
    await runCommand('create', 'no-config-test', '--title', 'No Config', '--requirement', 'REQ-4: 缺 config.yaml 时门禁回退到默认命令');
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'no-config-test.md'), '# test', 'utf-8');
    await runCommand('freeze', 'no-config-test');
    const { stdout, code } = await runCommand('gate', 'no-config-test');
    assert.equal(code, 0, `Gate with defaults failed: ${stdout}`);
  });

  it('check detects spec hash mismatch after freeze', async () => {
    await runCommand('create', 'drift-test', '--title', 'Drift Test', '--requirement', 'REQ-5: 规格被改动后要能检出漂移');
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'drift-test.md'), '# original content', 'utf-8');
    await runCommand('freeze', 'drift-test');

    // Modify the spec file
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'drift-test.md'), '# modified content', 'utf-8');

    const { stdout, code } = await runCommand('check', 'drift-test');
    // ADR-032 §3.4：check 的退出码与 --json 对齐——有问题返回 1。
    // 规格漂移就是问题，所以这里期望 1（改动前文本模式恒为 0）。
    assert.equal(code, 1, `check should exit 1 when drift detected: ${stdout}`);
    assert.ok(stdout.includes('hash mismatch') || stdout.includes('changed'), `Should detect drift: ${stdout}`);
  });
});
