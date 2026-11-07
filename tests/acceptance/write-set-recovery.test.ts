/**
 * 回归测试：写集越界之后，切片不能卡死在 `running`。
 *
 * 背景（ADR-014 §5）：agent 跑完之后的写集审计发现越界，就不进 gate、不发签字。
 * 修复前这条路径直接 `return 1`，状态留在 `running` —— 于是这个切片：
 *   - `zelto run` 拒绝跑（状态必须是 frozen 或 completed）
 *   - `zelto merge` 不收它（没签字）
 *   - `zelto resume` 说它没停机
 *   - 唯一出路是 `zelto abandon` —— 整个切片作废，规格得重写
 *
 * 也就是「越界一次，切片就废了」。越界通常只说明**写集划窄了**，
 * 人扩一下写集就该能重跑。现在越界时退回 `frozen`（状态机 running --RUN_FINISH-->
 * frozen），恢复闭环才成立。
 *
 * 这些用例跑真实 CLI 进程（dist/cli/index.js），所以必须先 `npm run build`。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `zelto-write-set-recovery-${Date.now()}`);
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

/** 读切片状态 */
async function readSliceState(id: string): Promise<string> {
  const raw = await readFile(join(TEST_DIR, '.zelto', 'slices', `${id}.json`), 'utf-8');
  return (JSON.parse(raw) as { state: string }).state;
}

/** 读事件流里的事件类型序列 */
async function readEventTypes(id: string): Promise<string[]> {
  const file = join(TEST_DIR, '.zelto', 'events', id, 'events.jsonl');
  if (!existsSync(file)) return [];
  const content = await readFile(file, 'utf-8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

const SPEC = [
  '# Slice: offender',
  '',
  '## 目的',
  '',
  '版本 v1 — 越界测试',
  '',
  '## 范围',
  '',
  '- `src/util.js`',
  '',
  '## 验收标准',
  '',
  '1. src/util.js 导出 sub(a,b) 函数，返回 a-b',
  '',
  '## 风险',
  '',
  '- 无',
  '',
].join('\n');

/** 越界 agent：写集内的文件 + 写集外的文件 */
const MOCK_AGENT = [
  "const fs = require('fs');",
  "const path = process.env.ZELTO_WORKTREE || process.cwd();",
  "fs.writeFileSync(path + '/src/util.js', 'export function sub(a,b){return a-b}\\n');",
  "fs.writeFileSync(path + '/src/evil.js', '// 越界写入\\n');",
  "console.log('mock agent done');",
].join('\n');

const CONFIG = [
  'gate:',
  '  commands:',
  '    - name: test',
  '      run: "echo ok"',
  '  timeoutSec: 60',
  '  retry:',
  '    max: 0',
  'agent:',
  '  command: "node <MOCK_AGENT_PATH>"',
  'budgetLimitUsd: 0',
  '',
].join('\n');

describe('acceptance: 写集越界后的恢复', { concurrency: false }, () => {
  before(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });
    await writeFile(join(TEST_DIR, 'src', 'util.js'), 'export function add(a,b){return a+b}\n');

    // git 仓库是 worktree 隔离的前提
    const { execFileSync } = await import('node:child_process');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: TEST_DIR, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('add', '-A');
    git('commit', '-qm', 'init');

    const initResult = await runCli('init');
    assert.equal(initResult.code, 0, `init failed: ${initResult.stderr}`);

    const agentPath = join(TEST_DIR, 'mock-agent.js');
    await writeFile(agentPath, MOCK_AGENT, 'utf-8');
    await writeFile(
      join(TEST_DIR, '.zelto', 'config.yaml'),
      CONFIG.replace('<MOCK_AGENT_PATH>', agentPath.replace(/\\/g, '/')),
      'utf-8',
    );

    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'offender.md'), SPEC, 'utf-8');

    const createResult = await runCli('create', 'offender', '--title', '越界测试');
    assert.equal(createResult.code, 0, `create failed: ${createResult.stderr}`);

    const checkResult = await runCli('check', 'offender');
    assert.equal(checkResult.code, 0, `check failed: ${checkResult.stdout}`);

    const freezeResult = await runCli('freeze', 'offender');
    assert.equal(freezeResult.code, 0, `freeze failed: ${freezeResult.stderr}`);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('越界时不进 gate，退出码非 0', async () => {
    const result = await runCli('run', 'offender');
    assert.notEqual(result.code, 0, '越界应当以非 0 退出码结束');
    assert.match(result.stdout + result.stderr, /写集越界/);
  });

  it('越界后切片退回 frozen，不卡死在 running', async () => {
    const state = await readSliceState('offender');
    assert.equal(state, 'frozen', `越界后应为 frozen，实际是 ${state}`);
  });

  it('越界后可以立即重跑（不再被状态挡住）', async () => {
    const result = await runCli('run', 'offender', '--dry-run');
    assert.equal(result.code, 0, `越界后应当可以重跑: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Would admit/);
  });

  it('越界写进事件流（run.aborted + policy.violation）', async () => {
    const types = await readEventTypes('offender');
    assert.ok(types.includes('run.aborted'), '缺少 run.aborted 事件');
    assert.ok(types.includes('policy.violation'), '缺少 policy.violation 事件');
  });

  it('扩写集后重跑能走完门禁并发签字请求', async () => {
    const setResult = await runCli('set', 'offender', '--field', 'writes', '--value', 'src/util.js,src/evil.js');
    assert.equal(setResult.code, 0, `set writes failed: ${setResult.stderr}`);

    const runResult = await runCli('run', 'offender');
    const output = runResult.stdout + runResult.stderr;
    assert.match(output, /Gate/, '扩写集后应当跑门禁');
    assert.doesNotMatch(output, /写集越界/, '扩写集后不应再越界');

    const state = await readSliceState('offender');
    assert.equal(state, 'completed', `门禁通过后应为 completed，实际是 ${state}`);
  });
});
