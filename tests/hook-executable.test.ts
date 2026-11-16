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
      // hook 进程用 `ZELTO_PROJECT_ROOT` 找 `policy/policy.yaml`
      // （src/hook/index.ts）。父进程里带着这个变量时（装着 git hook 的
      // 机器上就有），子进程会去读**别人的**策略文件而不是 TEST_DIR 里
      // 这份 —— 断言就变成在测环境而不是测代码。显式指到 TEST_DIR。
      env: { ...process.env, ZELTO_PROJECT_ROOT: TEST_DIR },
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

  // ─── D-24：保护域拦的是 agent，不是人 ─────────────────────────────────────
  //
  // C5 说「保护域硬编码、不可被任何策略规则覆盖」—— 保护域防的是 **agent**。
  // 但**人必须能改策略**：C5 的配套流程是「人改 policy/policy.yaml →
  // zelto policy lock --update 重新锚定」。原来 hook 不区分谁在提交，
  // 结果人的提交也被拦，逼人用 `--no-verify` 绕过。
  //
  // 判据由 git hook 脚本给出（它看提交那一刻的环境变量）。

  it('agent 提交保护域 → 拦截', async () => {
    const output = await runHook({
      path: 'policy/policy.yaml',
      operation: 'write',
      harness: 'git-agent',
    }) as any;

    assert.equal(output.decision, 'deny');
    assert.equal(output.matched_rule, 'protected:0b');
  });

  it('人提交保护域 → 放行（并提示重新锚定）', async () => {
    const output = await runHook({
      path: 'policy/policy.yaml',
      operation: 'write',
      harness: 'git-human',
    }) as any;

    assert.equal(output.decision, 'allow');
    assert.equal(output.matched_rule, 'protected:human');
    assert.ok(
      String(output.guidance).includes('policy lock --update'),
      `放行时必须提示重新锚定，实际：${output.guidance}`,
    );
  });

  it('人提交 .zelto/ → 也放行（同一个保护域，同一套口径）', async () => {
    const output = await runHook({
      path: '.zelto/slices/011.json',
      operation: 'write',
      harness: 'git-human',
    }) as any;

    assert.equal(output.decision, 'allow');
  });

  it('未知 harness → 按 agent 口径拦截（fail closed，不能开后门）', async () => {
    // 判成「人」等于给保护域开一个后门：任何填错 harness 的调用都能改策略。
    const output = await runHook({
      path: 'policy/policy.yaml',
      operation: 'write',
      harness: 'some-unknown-tool',
    }) as any;

    assert.equal(output.decision, 'deny');
    assert.equal(output.matched_rule, 'protected:0b');
  });

  it('harness 缺省 → 也按 agent 口径拦截', async () => {
    const output = await runHook({
      path: 'policy/policy.yaml',
      operation: 'write',
    }) as any;

    assert.equal(output.decision, 'deny');
  });

  it('人提交保护域时，普通文件仍然按策略判定（放行保护域不放行一切）', async () => {
    const output = await runHook({
      path: 'config.json',
      operation: 'write',
      harness: 'git-human',
    }) as any;

    // `config.json` 被显式 deny —— 人提交也不例外
    assert.equal(output.decision, 'deny');
    assert.equal(output.matched_rule, 'deny-config');
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
