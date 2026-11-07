/**
 * `zelto contract` 命令的端到端测试（ADR-036）。
 *
 * 跑真实 CLI 进程（dist/cli/index.js），在一个临时项目里：
 *   1. 没有基线 → check 不做判断，退出码 0
 *   2. 建基线 → check 无破坏
 *   3. 改坏契约 → check 退出码 1，并说清是写入方还是读取方破坏
 *   4. 更新基线 → 破坏消失（基线更新 = 人签字接受）
 *
 * 放在 tests/ 而不是 tests/acceptance/：AGENTS.md 把 acceptance 目录
 * 定为冻结区（验收骨架随规格冻结），这里测的是 CLI 行为本身。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `zelto-contract-cli-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.on('error', reject);
  });
}

const SCHEMA_V1 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'demo',
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
    mode: { type: 'string', enum: ['fast', 'slow'] },
  },
};

// 新增必填字段 + 收窄 enum：两处都是「写入方破坏」
const SCHEMA_V2 = {
  ...SCHEMA_V1,
  required: ['id', 'owner'],
  properties: {
    ...SCHEMA_V1.properties,
    owner: { type: 'string' },
    mode: { type: 'string', enum: ['fast'] },
  },
};

describe('zelto contract', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, 'contracts', 'schemas'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto'), { recursive: true });
    await writeFile(
      join(TEST_DIR, 'contracts', 'schemas', 'demo.json'),
      JSON.stringify(SCHEMA_V1, null, 2),
      'utf-8',
    );
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('没有基线时不做判断，退出码 0', async () => {
    const result = await runCli('contract', 'check');
    assert.equal(result.code, 0);
    assert.match(result.stdout + result.stderr, /基线/);
  });

  it('建立基线后 check 通过', async () => {
    const baseline = await runCli('contract', 'baseline');
    assert.equal(baseline.code, 0);

    const check = await runCli('contract', 'check');
    assert.equal(check.code, 0);
    assert.match(check.stdout + check.stderr, /没有检出破坏性契约变化/);
  });

  it('契约改坏后 check 退出码 1，并说清破坏方向', async () => {
    await writeFile(
      join(TEST_DIR, 'contracts', 'schemas', 'demo.json'),
      JSON.stringify(SCHEMA_V2, null, 2),
      'utf-8',
    );

    const check = await runCli('contract', 'check');
    assert.equal(check.code, 1);
    const output = check.stdout + check.stderr;
    assert.match(output, /写入方破坏/);
    assert.match(output, /owner/);
  });

  it('--json 输出带 breaking 计数', async () => {
    const check = await runCli('contract', 'check', '--json');
    assert.equal(check.code, 1);
    const payload = JSON.parse(check.stdout) as {
      data: { breaking: number; checks: unknown[] };
    };
    assert.ok(payload.data.breaking >= 2);
    assert.equal(payload.data.checks.length, 1);
  });

  it('更新基线（人签字接受）后 check 重新通过', async () => {
    const baseline = await runCli('contract', 'baseline');
    assert.equal(baseline.code, 0);

    const check = await runCli('contract', 'check');
    assert.equal(check.code, 0);
  });

  it('contract status 显示基线状态', async () => {
    const status = await runCli('contract', 'status');
    assert.equal(status.code, 0);
    assert.match(status.stdout + status.stderr, /契约基线/);
  });
});
