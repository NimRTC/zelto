import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), `zelto-hook-test-${Date.now()}`);
const HOOK_SCRIPT = join(process.cwd(), 'dist', 'hook', 'index.js');

// Create a minimal policy.yaml for testing
const TEST_POLICY = `# zelto policy — test
rules:
  - id: allow-read-all
    match: { path: "**", operation: "read" }
    action: allow
    basis: "test.yaml#allow-read-all"
    priority: 0
  - id: allow-src
    match: { path: "src/**/*.ts", operation: "write" }
    action: allow
    basis: "test.yaml#allow-src"
  - id: deny-config
    match: { path: "config.json", operation: "write" }
    action: deny
    basis: "test.yaml#deny-config"
`;

async function runHook(input: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK_SCRIPT], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Hook exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (err) {
        reject(new Error(`Failed to parse output: ${stdout}`));
      }
    });

    child.on('error', reject);

    child.stdin.write(JSON.stringify(input) + '\n');
    child.stdin.end();
  });
}

describe('zelto-hook', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, 'policy'), { recursive: true });
    await writeFile(join(TEST_DIR, 'policy', 'policy.yaml'), TEST_POLICY, 'utf-8');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('allows write to src/', async () => {
    const output = await runHook({
      path: 'src/core/feature.ts',
      operation: 'write',
      harness: 'test-harness',
    }) as any;

    assert.equal(output.decision, 'allow');
    assert.equal(output.matched_rule, 'allow-src');
    assert.ok(output.decision_id.startsWith('hook-'));
    assert.ok(output.policy_version.startsWith('sha256:'));
  });

  it('denies write to protected policy/', async () => {
    const output = await runHook({
      path: 'policy/policy.yaml',
      operation: 'write',
      harness: 'test-harness',
    }) as any;

    assert.equal(output.decision, 'deny');
    assert.equal(output.matched_rule, 'protected:0b');
  });

  it('denies path escape', async () => {
    const output = await runHook({
      path: '../outside/file.txt',
      operation: 'write',
      harness: 'test-harness',
    }) as any;

    assert.equal(output.decision, 'deny');
    assert.equal(output.matched_rule, 'protected:0a');
  });

  it('denies write to config.json', async () => {
    const output = await runHook({
      path: 'config.json',
      operation: 'write',
      harness: 'test-harness',
    }) as any;

    assert.equal(output.decision, 'deny');
    assert.equal(output.matched_rule, 'deny-config');
  });

  it('allows read on any path', async () => {
    const output = await runHook({
      path: 'policy/policy.yaml',
      operation: 'read',
      harness: 'test-harness',
    }) as any;

    assert.equal(output.decision, 'allow');
  });

  it('rejects missing required fields', async () => {
    const output = await runHook({
      path: 'test.txt',
      // missing operation and harness
    }) as any;

    assert.equal(output.decision, 'deny');
    assert.ok(output.guidance?.includes('Missing required'));
  });

  it('produces unique decision IDs', async () => {
    const r1 = await runHook({ path: 'src/test.ts', operation: 'write', harness: 'test' }) as any;
    const r2 = await runHook({ path: 'src/test.ts', operation: 'write', harness: 'test' }) as any;
    assert.notEqual(r1.decision_id, r2.decision_id);
  });
});
