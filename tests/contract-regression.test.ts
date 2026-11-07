// 契约基线 + 跨版本回归基线的存储与对比测试（ADR-036）

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContractBaselineStore } from '../src/core/contracts/baseline.js';
import {
  RegressionBaselineStore,
  compareRegression,
  hasRegression,
  mergeTapResults,
  parseTapResults,
} from '../src/core/regression/index.js';

const TEST_DIR = join(tmpdir(), 'zelto-contract-baseline-test');

describe('ContractBaselineStore', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('没有基线时 read 返回 null', async () => {
    const store = new ContractBaselineStore(TEST_DIR);
    assert.equal(await store.read(), null);
    assert.equal(store.exists(), false);
  });

  it('写入后能读回，契约内容一致', async () => {
    const store = new ContractBaselineStore(TEST_DIR);
    await store.write({
      format: 1,
      updatedAt: '2026-11-08T00:00:00.000Z',
      updatedBy: 'human',
      contracts: { slice: { type: 'object' } },
    });
    const baseline = await store.read();
    assert.ok(baseline);
    assert.equal(baseline.updatedBy, 'human');
    assert.deepEqual(baseline.contracts.slice, { type: 'object' });
    assert.equal(store.exists(), true);
  });

  it('写坏了的基线按「没有基线」处理，不会当成空基线', async () => {
    const store = new ContractBaselineStore(TEST_DIR);
    await mkdir(join(TEST_DIR, 'contracts'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(store.path, '{ 这不是 JSON', 'utf-8');
    assert.equal(await store.read(), null);
  });
});

describe('parseTapResults', () => {
  it('读不出用例列表时 known 为 false（不猜别的运行器格式）', () => {
    const result = parseTapResults('Tests  1 failed\n  1 passed\n');
    assert.equal(result.known, false);
    assert.equal(result.tests.length, 0);
  });

  it('认 node 测试运行器的 TAP 输出', () => {
    const output = [
      'TAP version 13',
      '# Subtest: tests/a.test.ts',
      'ok 1 - tests/a.test.ts',
      '    ok 1 - 第一个用例',
      '    not ok 2 - 第二个用例',
      '    ok 3 - 第三个用例 # TODO',
    ].join('\n');
    const result = parseTapResults(output);
    assert.equal(result.known, true);
    assert.equal(result.tests.length, 4);
    assert.equal(result.tests[1].name, '第一个用例');
    assert.equal(result.tests[1].status, 'pass');
    assert.equal(result.tests[2].status, 'fail');
    assert.equal(result.tests[3].status, 'todo');
    assert.equal(result.tests[1].file, 'tests/a.test.ts');
  });

  it('合并多段输出时同名用例取更差的状态', () => {
    const merged = mergeTapResults([
      { known: true, tests: [{ name: 'x', file: 'a.test.ts', status: 'pass' }] },
      { known: true, tests: [{ name: 'x', file: 'a.test.ts', status: 'fail' }] },
    ]);
    assert.equal(merged.tests.length, 1);
    assert.equal(merged.tests[0].status, 'fail');
  });
});

describe('compareRegression', () => {
  const prev = [
    { name: '保留', file: 'a.test.ts', status: 'pass' as const },
    { name: '变红', file: 'a.test.ts', status: 'pass' as const },
    { name: '退化', file: 'a.test.ts', status: 'pass' as const },
    { name: '消失', file: 'a.test.ts', status: 'pass' as const },
    { name: '修好', file: 'a.test.ts', status: 'fail' as const },
  ];

  const cur = [
    { name: '保留', file: 'a.test.ts', status: 'pass' as const },
    { name: '变红', file: 'a.test.ts', status: 'fail' as const },
    { name: '退化', file: 'a.test.ts', status: 'todo' as const },
    { name: '修好', file: 'a.test.ts', status: 'pass' as const },
  ];

  it('分清变红 / 退化 / 消失 / 修好', () => {
    const report = compareRegression(prev, cur, 'v1', 'v2');
    assert.equal(report.compared, true);
    assert.equal(report.previousVersion, 'v1');
    assert.deepEqual(report.regressed, ['a.test.ts :: 变红']);
    assert.deepEqual(report.degraded, ['a.test.ts :: 退化']);
    assert.deepEqual(report.missing, ['a.test.ts :: 消失']);
    assert.deepEqual(report.fixed, ['a.test.ts :: 修好']);
    assert.equal(report.unchanged, 1);
    assert.equal(hasRegression(report), true);
  });

  it('上版本本来就失败的用例，在新版本里消失不算回归', () => {
    const report = compareRegression(
      [{ name: '本来就红', file: 'a.test.ts', status: 'fail' }],
      [],
      'v1',
      'v2',
    );
    assert.deepEqual(report.missing, []);
    assert.equal(hasRegression(report), false);
  });

  it('没有可比基线时 compared 为 false', async () => {
    const store = new RegressionBaselineStore(TEST_DIR);
    assert.equal(store.exists('plan', 'v1'), false);
    assert.equal(await store.read('plan', 'v1'), null);
  });
});

describe('RegressionBaselineStore', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('写入后能读回', async () => {
    const store = new RegressionBaselineStore(TEST_DIR);
    await store.write({
      format: 1,
      planId: 'p1',
      version: 'v1',
      capturedAt: '2026-11-08T00:00:00.000Z',
      source: 'version-acceptance',
      tests: [{ name: '用例', file: 'a.test.ts', status: 'pass' }],
    });
    const baseline = await store.read('p1', 'v1');
    assert.ok(baseline);
    assert.equal(baseline.tests.length, 1);
    assert.equal(baseline.version, 'v1');
  });
});
