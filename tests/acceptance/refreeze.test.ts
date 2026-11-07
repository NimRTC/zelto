/**
 * 回归测试：规格改了之后要能重新冻结。
 *
 * 背景：规格冻结之后人可能还要改它 —— 最常见的是**写集越界之后扩写集**
 * （写集写在规格的「范围」章节里，改规格 = 改哈希）。
 *
 * 修复前那个切片就永久卡住：
 *   - `zelto check` 报 "Spec file has changed since freeze (hash mismatch)"
 *   - `zelto freeze` 报 "Slice is in state frozen, cannot freeze"
 *
 * 两条命令互相堵死，人既不能确认新规格，也不能继续干活。
 * 现在有 `zelto freeze <id> --refreeze`：人确认新规格 → 退回 draft → 重新冻结。
 *
 * 这些用例跑真实 CLI 进程（dist/cli/index.js），所以必须先 `npm run build`。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `zelto-refreeze-${Date.now()}`);
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

async function readSlice(id: string): Promise<{ state: string; frozenHash: string | null; requirements: string[] }> {
  const raw = await readFile(join(TEST_DIR, '.zelto', 'slices', `${id}.json`), 'utf-8');
  const parsed = JSON.parse(raw) as {
    state: string;
    spec: { frozenHash: string | null };
    trace: { requirements: string[] };
  };
  return {
    state: parsed.state,
    frozenHash: parsed.spec.frozenHash,
    requirements: parsed.trace.requirements,
  };
}

function specWith(writes: string[], extraCriterion: string): string {
  return [
    '# Slice: adjustable',
    '',
    '## 目的',
    '',
    '版本 v1 — 重新冻结测试',
    '',
    '## 范围',
    '',
    ...writes.map((w) => `- \`${w}\``),
    '',
    '## 验收标准',
    '',
    '1. src/util.js 导出 sub(a,b) 函数，返回 a-b',
    ...(extraCriterion ? [extraCriterion] : []),
    '',
    '## 风险',
    '',
    '- 无',
    '',
  ].join('\n');
}

describe('acceptance: 规格改动后的重新冻结', { concurrency: false }, () => {
  before(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });
    await writeFile(join(TEST_DIR, 'src', 'util.js'), 'export function add(a,b){return a+b}\n');

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

    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await writeFile(
      join(TEST_DIR, 'specs', 'slices', 'adjustable.md'),
      specWith(['src/util.js'], ''),
      'utf-8',
    );

    const createResult = await runCli('create', 'adjustable', '--title', '重新冻结测试');
    assert.equal(createResult.code, 0, `create failed: ${createResult.stderr}`);

    const checkResult = await runCli('check', 'adjustable');
    assert.equal(checkResult.code, 0, `check failed: ${checkResult.stdout}`);

    const freezeResult = await runCli('freeze', 'adjustable');
    assert.equal(freezeResult.code, 0, `freeze failed: ${freezeResult.stderr}`);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('改规格后 check 报哈希不匹配（漂移可见）', async () => {
    await writeFile(
      join(TEST_DIR, 'specs', 'slices', 'adjustable.md'),
      specWith(['src/util.js', 'src/extra.js'], '2. src/extra.js 存在'),
      'utf-8',
    );
    const result = await runCli('check', 'adjustable');
    assert.notEqual(result.code, 0, '规格漂移时 check 应当不通过');
    assert.match(result.stdout + result.stderr, /hash mismatch/);
  });

  it('不带 --refreeze 的 freeze 拒绝已冻结的切片', async () => {
    const result = await runCli('freeze', 'adjustable');
    assert.notEqual(result.code, 0, '已冻结的切片不该能被直接再次冻结');
    assert.match(result.stdout + result.stderr, /--refreeze/, '应当提示 --refreeze 的用法');
  });

  it('--refreeze 重新冻结：哈希重置后按新规格重新冻结', async () => {
    const before = await readSlice('adjustable');
    assert.ok(before.frozenHash, '冻结后应当有哈希');

    const result = await runCli('freeze', 'adjustable', '--refreeze');
    assert.equal(result.code, 0, `refreeze 失败: ${result.stdout}${result.stderr}`);

    // --refreeze 是一次性动作：退回 draft 后立刻按新规格重新冻结，
    // 所以最终状态是 frozen（新哈希），不是 draft。
    const after = await readSlice('adjustable');
    assert.equal(after.state, 'frozen', `refreeze 后应为 frozen，实际 ${after.state}`);
    assert.ok(after.frozenHash, '应当记录新的冻结哈希');
    assert.notEqual(after.frozenHash, before.frozenHash, '哈希应当变了 —— 规格改了');
  });

  it('refreeze 后 check 重新通过（漂移已消解）', async () => {
    const result = await runCli('check', 'adjustable');
    assert.equal(result.code, 0, `refreeze 后 check 应当通过: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /hash mismatch/);
  });

  it('refreeze 后追溯按新规格重新物化', async () => {
    const slice = await readSlice('adjustable');
    // 新规格有 2 条验收标准 —— 追溯应当按新规格重新物化
    assert.equal(slice.requirements.length, 2, `追溯应重新物化为 2 条，实际 ${slice.requirements.length}`);
  });
});
