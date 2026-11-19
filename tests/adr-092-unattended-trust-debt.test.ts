// ADR-092 · 无人值守可信度的三处债务
//
// 三件事（详见 docs/adr/adr-092-unattended-trust-debt.md）：
//   ① spec confirm 不再静默覆盖含真断言的验收骨架；
//   ② runs 口径统一为「每次 agent 进程结束 = 一条」，带 phase / attempt；
//   ③ 冻结边界（writes + gateCommands）纳入 boundaryHash，且 set 在 frozen 下拒绝改。
//
// 这里钉住可纯函数化的部分：
//   - writeAcceptanceSkeleton 能报出「现有文件是不是纯 todo」（① 的判据）；
//   - computeBoundaryHash 确定性（顺序无关 / 正斜杠 / 空 gate 与未设同值）；
//   - SliceRun 归一化保留 phase / attempt，老记录缺省不伪造。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeAcceptanceSkeleton } from '../src/core/spec/skeleton.js';
import { computeBoundaryHash } from '../src/core/lifecycle/freeze.js';
import { SliceStore } from '../src/core/slice/store.js';
import { isPureTodoSkeleton } from '../src/core/project/managed-acceptance.js';

const TEST_DIR = join(tmpdir(), `zelto-adr092-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');

const SPEC = '# Slice: s\n\n## 验收标准\n\n1. 甲要成立；验证方式：测试\n';

// ─── ① 骨架覆盖判据 ──────────────────────────────────────────────────────

describe('ADR-092 · 骨架覆盖判据（existingIsPureTodo）', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });
  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('骨架不存在时正常生成（不 skip）', () => {
    const r = writeAcceptanceSkeleton('tests/acceptance/s1/', SPEC, 's1', TEST_DIR);
    assert.ok(r.path, '应当生成骨架');
    assert.equal(r.skippedExisting, undefined);
  });

  it('已存在且是纯 todo → skippedExisting 且 existingIsPureTodo=true（可无损失覆盖）', async () => {
    const dir = 'tests/acceptance/s2/';
    writeAcceptanceSkeleton(dir, SPEC, 's2', TEST_DIR); // 先生成（全是 todo）
    const r = writeAcceptanceSkeleton(dir, SPEC, 's2', TEST_DIR); // 不 force → skip
    assert.equal(r.path, null);
    assert.equal(r.skippedExisting, true);
    assert.equal(r.existingIsPureTodo, true, '纯 todo 应被识别为可无损失覆盖');
  });

  it('已存在且含真断言 → existingIsPureTodo=false（confirm 应保全、不覆盖）', async () => {
    const dir = 'tests/acceptance/s3/';
    const target = join(TEST_DIR, dir, 'acceptance.test.cjs');
    await mkdir(join(TEST_DIR, dir), { recursive: true });
    // 模拟 agent 上轮把 todo 换成了真断言
    await writeFile(target, "const test = require('node:test');\ntest('甲要成立', () => {});\n", 'utf-8');

    const r = writeAcceptanceSkeleton(dir, SPEC, 's3', TEST_DIR);
    assert.equal(r.path, null);
    assert.equal(r.skippedExisting, true);
    assert.equal(r.existingIsPureTodo, false, '含真断言的文件不能被当作纯 todo 覆盖');
  });

  it('isPureTodoSkeleton 判据与骨架生成形态一致', () => {
    assert.equal(isPureTodoSkeleton("test.todo('a');\n"), true);
    assert.equal(isPureTodoSkeleton("test('a', () => {});\n"), false);
  });
});

// ─── ③ 冻结边界摘要 ────────────────────────────────────────────────────

describe('ADR-092 · 冻结边界摘要（computeBoundaryHash）', () => {
  const base = (writes: string[], gate?: Array<{ name: string; run: string }>) => ({
    writes,
    spec: gate ? { gateCommands: gate } : {},
  });

  it('写集顺序无关（排序后取值）', () => {
    const a = computeBoundaryHash(base(['src/a/**', 'src/b/**']));
    const b = computeBoundaryHash(base(['src/b/**', 'src/a/**']));
    assert.equal(a, b);
  });

  it('反斜杠与正斜杠等价', () => {
    const a = computeBoundaryHash(base(['src\\a\\b.ts']));
    const b = computeBoundaryHash(base(['src/a/b.ts']));
    assert.equal(a, b);
  });

  it('写集去重等价', () => {
    const a = computeBoundaryHash(base(['src/a.ts', 'src/a.ts']));
    const b = computeBoundaryHash(base(['src/a.ts']));
    assert.equal(a, b);
  });

  it('写集变了 → 摘要变（偷改能被发现）', () => {
    const a = computeBoundaryHash(base(['src/a.ts']));
    const b = computeBoundaryHash(base(['src/a.ts', 'src/evil.ts']));
    assert.notEqual(a, b);
  });

  it('空 gateCommands 与未设置等价', () => {
    const a = computeBoundaryHash(base(['src/a.ts']));
    const b = computeBoundaryHash(base(['src/a.ts'], []));
    assert.equal(a, b);
  });

  it('门禁命令变了 → 摘要变（偷改能被发现）', () => {
    const a = computeBoundaryHash(base(['src/a.ts'], [{ name: 'test', run: 'npm test' }]));
    const b = computeBoundaryHash(base(['src/a.ts'], [{ name: 'test', run: 'echo ok' }]));
    assert.notEqual(a, b);
  });

  it('门禁命令顺序是语义（顺序变了摘要也变）', () => {
    const a = computeBoundaryHash(base(['src/a.ts'], [{ name: 'a', run: '1' }, { name: 'b', run: '2' }]));
    const b = computeBoundaryHash(base(['src/a.ts'], [{ name: 'b', run: '2' }, { name: 'a', run: '1' }]));
    assert.notEqual(a, b);
  });

  it('摘要带 sha256: 前缀（与 frozenHash 同格式）', () => {
    assert.match(computeBoundaryHash(base(['src/a.ts'])), /^sha256:[0-9a-f]{64}$/);
  });
});

// ─── ② runs 口径 ────────────────────────────────────────────────────────

describe('ADR-092 · runs 口径（每次进程一条 + phase/attempt）', () => {
  let store: SliceStore;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    store = new SliceStore(SLICES_DIR);
  });
  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('recordRun 写入 phase 与 attempt', async () => {
    await store.write(store.create('r1', 'x'));
    await store.recordRun('r1', { ok: false, exitCode: 1, phase: 'foreground', attempt: 1 });
    await store.recordRun('r1', { ok: true, exitCode: 0, phase: 'foreground', attempt: 2 });

    const s = await store.read('r1');
    assert.equal(s.runs.length, 2);
    assert.equal(s.runs[0].phase, 'foreground');
    assert.equal(s.runs[0].attempt, 1);
    assert.equal(s.runs[1].attempt, 2);
  });

  it('并行重试 3 次 = 3 条（与前台同口径）', async () => {
    await store.write(store.create('r2', 'x'));
    for (let i = 1; i <= 3; i++) {
      await store.recordRun('r2', { ok: false, exitCode: 1, phase: 'parallel', attempt: i });
    }
    const s = await store.read('r2');
    assert.equal(s.runs.length, 3);
    assert.deepEqual(s.runs.map((r) => r.attempt), [1, 2, 3]);
    assert.ok(s.runs.every((r) => r.phase === 'parallel'));
  });

  it('老记录（无 phase/attempt）读出来不伪造 —— 字段缺省', async () => {
    await writeFile(
      join(SLICES_DIR, 'legacy-run.json'),
      JSON.stringify({
        id: 'legacy-run',
        title: '老记录',
        state: 'draft',
        runs: [{ at: '2026-01-01T00:00:00.000Z', ok: true, exitCode: 0 }],
      }),
      'utf-8',
    );
    const s = await store.read('legacy-run');
    assert.equal(s.runs.length, 1);
    assert.equal(s.runs[0].phase, undefined, '老记录不补 phase（不伪造语义）');
    assert.equal(s.runs[0].attempt, undefined);
  });

  it('老记录带 phase/attempt 时原样保留', async () => {
    await writeFile(
      join(SLICES_DIR, 'legacy-run2.json'),
      JSON.stringify({
        id: 'legacy-run2',
        title: 'x',
        state: 'draft',
        runs: [{ at: '2026-01-01T00:00:00.000Z', ok: false, exitCode: 2, phase: 'watchdog', attempt: 3 }],
      }),
      'utf-8',
    );
    const s = await store.read('legacy-run2');
    assert.equal(s.runs[0].phase, 'watchdog');
    assert.equal(s.runs[0].attempt, 3);
  });

  it('新建切片 spec.boundaryHash 缺省为 null', async () => {
    const s = store.create('nb', 'x');
    assert.equal(s.spec.boundaryHash, null);
  });
});
