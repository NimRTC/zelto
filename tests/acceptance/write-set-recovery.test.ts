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
  /**
   * 第一轮运行（真正越界的那一轮）的输出。
   *
   * 为什么存下来：第二轮跑**不会**再越界 ——
   * `src/evil.js` 在第一轮已经被写进 worktree，
   * 于是第二轮开工时它是「预置脏」（D-29），不算本轮的越界。
   * 所以「输出里说了什么」只能在第一轮验。
   */
  let firstRunOutput = '';

  before(async () => {
    await rm(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
    // Windows 上刚退出的子进程还可能攥着 cwd 句柄 → EBUSY。
    // maxRetries 让 Node 自己重试（只对 EPERM/EBUSY/ENOTEMPTY 生效）。
    await rm(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('越界时不进 gate，退出码非 0', async () => {
    const result = await runCli('run', 'offender');
    firstRunOutput = result.stdout + result.stderr;
    assert.notEqual(result.code, 0, '越界应当以非 0 退出码结束');
    assert.match(firstRunOutput, /写集越界/);
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

  it('越界时事件里带上「做成了什么」—— 只说违规，人只能重跑', async () => {
    // 病灶（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
    // agent 越界写了一个文件，事件里只有 violations。
    // 人看到的是「又跑废了」，看不到「写集内的活儿其实做完了大半」。
    // 于是只能重跑 —— 重跑会把做对的部分再做一遍。
    const file = join(TEST_DIR, '.zelto', 'events', 'offender', 'events.jsonl');
    const content = await readFile(file, 'utf-8');
    const events = content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });

    // 取**第一条** run.aborted —— 那是越界那一刻写的那条。
    // 后面的 run.aborted 来自重跑，写集已扩，不再越界。
    const aborted = events.find((e) => e.type === 'run.aborted');
    assert.ok(aborted, '缺少 run.aborted 事件');

    const progress = aborted.payload.progress as
      | {
          criteriaTotal: number | null;
          changedFiles: string[];
          outOfWriteSetFiles: string[];
          verdict: string;
        }
      | undefined;
    assert.ok(progress, 'run.aborted 事件里应当带 progress（做成了什么）');
    assert.equal(progress.criteriaTotal, 1, '规格里有一条验收标准');
    assert.ok(
      progress.changedFiles.includes('src/util.js'),
      `progress 应当列出 agent 真正改的写集内文件，实际是 ${JSON.stringify(progress.changedFiles)}`,
    );
    // 越界文件要单列 —— 「做成了什么」与「什么把这一轮废了」不能混
    assert.deepEqual(
      progress.outOfWriteSetFiles,
      ['src/evil.js'],
      '越界文件应当单列出来',
    );
    // zelto 自己写进 worktree 的文件（规格副本、bundle）不算 agent 的成果
    assert.ok(
      !progress.changedFiles.some((f) => f.includes('offender-bundle')),
      'zelto 自己写的 bundle 不该算成 agent 的成果',
    );
  });

  it('越界时终端输出里也说清「做成了什么」', async () => {
    // 用**第一轮**的输出 —— 第二轮不会再越界（`src/evil.js` 已是预置脏）。
    assert.match(firstRunOutput, /写集越界/);
    assert.match(
      firstRunOutput,
      /进展|做成了什么/,
      '输出里应当有「这一轮做成了什么」',
    );
    assert.match(
      firstRunOutput,
      /src\/util\.js/,
      '输出里应当列出 agent 真正做完的事（写集内改动）',
    );
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
