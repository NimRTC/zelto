// ADR-034：切片规格的「生成草稿 → 人确认 → 才谈冻结」闭环
//
// 这组用例锁住三件事：
//
// 1. **确定性降级不自己编验收标准**。没有已批准的需求条目时，规格里的
//    「验收标准」章节不能有编号条目 —— 写了就会被物化成本片的需求追溯，
//    于是「追溯合格」变成 zelto 替人批准的需求（ADR-032 §4 方案四）。
// 2. **草稿不进正式规格**。只有人跑过 `zelto spec confirm` 之后，
//    规格才落到 specs/slices/ 下，冻结与追溯物化才有依据。
// 3. **验收骨架不算验证**。全是 todo 的验收文件退出码是 0，门禁不能把它
//    当成「验收通过」（core/gate/acceptance.ts 的 verifyAcceptanceRanTests）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import {
  buildDeterministicSliceSpec,
  isUsableSpec,
} from '../src/llm/generators/slice-spec.js';
import { extractAcceptanceCriteria } from '../src/core/spec/trace-extract.js';
import { buildAcceptanceSkeleton, writeAcceptanceSkeleton } from '../src/core/spec/skeleton.js';
import { parseTestRunnerStats, verifyAcceptanceRanTests } from '../src/core/gate/acceptance.js';

const TEST_DIR = join(tmpdir(), `zelto-adr034-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZELTO_SKIP_LLM: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
    setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, 15000).unref();
  });
}

// ─── 确定性降级规格 ────────────────────────────────────────────────────────

describe('ADR-034 · 确定性降级规格', () => {
  it('没有需求条目时，验收标准章节不留编号条目（不被物化成追溯）', () => {
    const spec = buildDeterministicSliceSpec({
      sliceId: 's1',
      title: '做一件事',
      module: 'Core',
      writes: ['src/a.ts'],
      version: 'v1',
      requirements: [],
    });

    const criteria = extractAcceptanceCriteria(spec);
    assert.equal(criteria.length, 0, `不该物化出任何验收条目，实际：${JSON.stringify(criteria)}`);
    assert.ok(spec.includes('## 验收标准'), '规格仍要有验收标准章节');
    assert.ok(!/^\s*1\.\s/m.test(spec.split('## 验收标准')[1] ?? ''), '验收标准章节里不能有编号条目');
  });

  it('有需求条目时，验收标准由需求原文推导', () => {
    const spec = buildDeterministicSliceSpec({
      sliceId: 's2',
      title: '做另一件事',
      module: 'Core',
      writes: ['src/b.ts'],
      version: 'v1',
      requirements: ['R1: 用户能登录', 'R2: 登录失败要有提示'],
    });

    const criteria = extractAcceptanceCriteria(spec).map((c) => c.text);
    assert.equal(criteria.length, 2);
    assert.ok(criteria[0].includes('用户能登录'), `验收条目应来自需求原文：${criteria[0]}`);
    assert.ok(spec.includes('## 需求'), '有需求时规格里要有需求章节');
  });

  it('空写集不编造路径', () => {
    const spec = buildDeterministicSliceSpec({
      sliceId: 's3',
      title: '空写集',
      module: '',
      writes: [],
      version: 'v1',
    });
    assert.ok(spec.includes('## 范围'));
    assert.ok(!spec.includes('- `undefined`'));
  });

  it('模型产出缺章节或全是套话时判为不可用', () => {
    assert.equal(isUsableSpec(''), false);
    assert.equal(isUsableSpec('# Slice: x\n\n## 目的\n\n做点事\n'), false, '缺验收标准章节');
    assert.equal(
      isUsableSpec('# Slice: x\n\n## 目的\n\n做点事\n\n## 验收标准\n\n1. 完成这件事\n2. 全部测试通过\n'),
      false,
      '全是套话',
    );
    assert.equal(
      isUsableSpec('# Slice: x\n\n## 目的\n\n做点事\n\n## 验收标准\n\n1. 登录接口返回 401；验证方式：有对应测试\n'),
      true,
    );
  });
});

// ─── 验收骨架 ──────────────────────────────────────────────────────────────

describe('ADR-034 · 验收测试骨架', () => {
  it('每条验收标准生成一条 todo 用例', () => {
    const skeleton = buildAcceptanceSkeleton('s1', ['第一条', '第二条']);
    assert.ok(skeleton.includes('test.todo("第一条")'), skeleton);
    assert.ok(skeleton.includes('test.todo("第二条")'), skeleton);
    assert.ok(skeleton.includes('切片：s1'));
  });

  it('目录形态：写进 <目录>/acceptance.test.cjs', async () => {
    const dir = join(TEST_DIR, 'skeleton-dir');
    await mkdir(dir, { recursive: true });
    const spec = '# Slice: s\n\n## 验收标准\n\n1. 甲要成立；验证方式：测试\n';

    const result = writeAcceptanceSkeleton('tests/acceptance/s/', spec, 's', TEST_DIR);
    assert.equal(result.reason, null);
    const relPath = result.path;
    assert.ok(relPath, '应给出骨架路径');

    const abs = join(TEST_DIR, relPath);
    assert.ok(existsSync(abs), `骨架文件应存在：${abs}`);
    const content = readFileSync(abs, 'utf-8');
    assert.ok(content.includes('test.todo('), content);
  });

  it('文件形态：不覆盖人自己的验收文件', async () => {
    const existing = join(TEST_DIR, 'tests', 'acceptance', 'x.test.ts');
    await mkdir(join(TEST_DIR, 'tests', 'acceptance'), { recursive: true });
    await writeFile(existing, '// 人写的\n', 'utf-8');

    const spec = '# Slice: s\n\n## 验收标准\n\n1. 甲要成立；验证方式：测试\n';
    const result = writeAcceptanceSkeleton('tests/acceptance/x.test.ts', spec, 's', TEST_DIR);
    assert.equal(result.path, null);
    assert.ok(result.reason, '应说明为什么没生成');    assert.equal(readFileSync(existing, 'utf-8'), '// 人写的\n');
  });

  it('规格里没有验收条目时如实报告，不硬造', () => {
    const result = writeAcceptanceSkeleton('tests/acceptance/y/', '# Slice: s\n\n## 目的\n\n做事\n', 's', TEST_DIR);
    assert.equal(result.path, null);
    assert.ok(result.reason?.includes('验收标准') === true, result.reason ?? '');
  });
});

// ─── 门禁②的「真跑过用例」判定 ────────────────────────────────────────────

describe('ADR-034 · 验收统计判定', () => {
  it('读得出 TAP 汇总行', () => {
    const stats = parseTestRunnerStats('# pass 3\n# fail 0\n# todo 1\n# skipped 0\n');
    assert.equal(stats.known, true);
    assert.equal(stats.pass, 3);
    assert.equal(stats.todo, 1);
  });

  it('读不出统计时不做判断', () => {
    const stats = parseTestRunnerStats('随便一段输出');
    assert.equal(stats.known, false);
    assert.equal(verifyAcceptanceRanTests(stats).ok, true);
  });

  it('全是 todo 不算验证', () => {
    const verdict = verifyAcceptanceRanTests({ pass: 0, fail: 0, todo: 3, skipped: 0, known: true });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reason?.includes('todo') === true, verdict.reason ?? '');
  });

  it('有真正跑过的用例才算验证', () => {
    const verdict = verifyAcceptanceRanTests({ pass: 1, fail: 0, todo: 2, skipped: 0, known: true });
    assert.equal(verdict.ok, true);
  });
});

// ─── CLI 闭环 ──────────────────────────────────────────────────────────────

describe('ADR-034 · zelto spec 命令', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('draft 生成草稿与验收骨架，confirm 才写进正式规格', async () => {
    const created = await runCli(
      'create',
      'adr034-a',
      '--title',
      '闭环演示',
      '--writes',
      'src/a.ts',
      '--requirement',
      'R1: 闭环要成立',
    );
    assert.equal(created.code, 0, `${created.stdout} ${created.stderr}`);

    const draft = await runCli('spec', 'draft', 'adr034-a');
    assert.equal(draft.code, 0, `${draft.stdout} ${draft.stderr}`);

    const draftPath = join(TEST_DIR, '.zelto', 'drafts', 'specs', 'adr034-a.md');
    assert.ok(existsSync(draftPath), '草稿应落在 .zelto/drafts/specs/ 下');
    assert.ok(!existsSync(join(TEST_DIR, 'specs', 'slices', 'adr034-a.md')), '草稿阶段不该有正式规格');

    const skeleton = join(TEST_DIR, 'tests', 'acceptance', 'adr034-a', 'acceptance.test.cjs');
    assert.ok(existsSync(skeleton), '验收骨架应生成');

    const confirmed = await runCli('spec', 'confirm', 'adr034-a');
    assert.equal(confirmed.code, 0, `${confirmed.stdout} ${confirmed.stderr}`);

    const official = join(TEST_DIR, 'specs', 'slices', 'adr034-a.md');
    assert.ok(existsSync(official), '确认后正式规格应存在');
    assert.equal(
      readFileSync(official, 'utf-8'),
      readFileSync(draftPath, 'utf-8'),
      '正式规格内容应与草稿一致',
    );
  });

  it('确认后的规格能被冻结（追溯物化得出处）', async () => {
    const created = await runCli('create', 'adr034-b', '--title', '冻结演示', '--requirement', 'R2: 冻结要成立');
    assert.equal(created.code, 0, `${created.stdout} ${created.stderr}`);

    await runCli('spec', 'draft', 'adr034-b');
    await runCli('spec', 'confirm', 'adr034-b');

    const frozen = await runCli('freeze', 'adr034-b');
    assert.equal(frozen.code, 0, `${frozen.stdout} ${frozen.stderr}`);
  });

  it('没有草稿时 confirm 直接拒绝', async () => {
    await runCli('create', 'adr034-c', '--title', '没草稿', '--requirement', 'R3: 也要有出处');
    const confirmed = await runCli('spec', 'confirm', 'adr034-c');
    assert.equal(confirmed.code, 1, '没有草稿不该确认成功');
  });
});
