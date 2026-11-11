// 切片记账回写（ADR-041 §3）
//
// 背景：在 nimrtc-zelto 上跑完一整轮切片后，切片状态里三处字段和实际发生的事对不上：
//   - `runs` 永远是空数组（死字段，从没被写入过）
//   - `baseCommit` 全为 null（合并守卫的「基点漂移」判据形同虚设）
//   - 已经 completed 的切片还留着 stall 分类
//
// 这里覆盖状态机这一层的记账行为（worktree 基点回写走真实 git，放集成测试）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SliceStore } from '../src/core/slice/store.js';

const TEST_DIR = join(tmpdir(), `zelto-slice-ledger-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');

describe('SliceStore — 运行记账（ADR-041 §3.1）', () => {
  let store: SliceStore;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    store = new SliceStore(SLICES_DIR);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('recordRun 追加一条运行记录', async () => {
    const slice = store.create('run-1', '跑一次');
    await store.write(slice);

    await store.recordRun('run-1', { ok: true, exitCode: 0 });

    const after = await store.read('run-1');
    assert.equal(after.runs.length, 1);
    assert.equal(after.runs[0].ok, true);
    assert.equal(after.runs[0].exitCode, 0);
    assert.ok(Date.parse(after.runs[0].at) > 0, '应带 ISO 8601 时间戳');
  });

  it('失败与被信号打断也各记一条', async () => {
    const slice = store.create('run-2', '跑两次');
    await store.write(slice);

    await store.recordRun('run-2', { ok: false, exitCode: 1 });
    await store.recordRun('run-2', { ok: false, exitCode: null });

    const after = await store.read('run-2');
    assert.equal(after.runs.length, 2);
    assert.equal(after.runs[0].exitCode, 1);
    assert.equal(after.runs[1].exitCode, null);
  });

  it('老状态文件里缺失的字段读出来是空值而不是崩', async () => {
    // 老文件：`runs` 是从未被写入过的字符串数组，也没有 clarifyRounds
    await writeFile(
      join(SLICES_DIR, 'legacy.json'),
      JSON.stringify({
        id: 'legacy',
        title: '老切片',
        state: 'draft',
        runs: ['2026-01-01T00:00:00.000Z'],
      }),
      'utf-8',
    );

    const slice = await store.read('legacy');
    assert.deepEqual(slice.runs, []);
    assert.equal(slice.clarifyRounds, 0);
  });
});

describe('SliceStore — 澄清轮次（ADR-041 §3.1）', () => {
  let store: SliceStore;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    store = new SliceStore(SLICES_DIR);
  });

  it('轮次单调递增（澄清问题 ID 靠它不撞号）', async () => {
    const slice = store.create('clarify-1', '澄清');
    await store.write(slice);

    assert.equal(await store.nextClarifyRound('clarify-1'), 1);
    assert.equal(await store.nextClarifyRound('clarify-1'), 2);
    assert.equal(await store.nextClarifyRound('clarify-1'), 3);

    const after = await store.read('clarify-1');
    assert.equal(after.clarifyRounds, 3);
  });
});

describe('SliceStore — 终态清停机分类（ADR-041 §3.3）', () => {
  let store: SliceStore;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    store = new SliceStore(SLICES_DIR);
  });

  it('转 completed 时清掉 stall.class', async () => {
    const slice = store.create('stall-1', '带停机');
    slice.state = 'frozen';
    slice.stall.class = 'gate_retry';
    slice.stall.gateRetries = 1;
    await store.write(slice);

    await store.transit('stall-1', 'GATE_PASS');

    const after = await store.read('stall-1');
    assert.equal(after.state, 'completed');
    assert.equal(after.stall.class, null, '已完成的切片不该还挂着停机分类');
  });

  it('转 abandoned 时清掉 stall.class', async () => {
    const slice = store.create('stall-2', '带停机');
    slice.state = 'frozen';
    slice.stall.class = 'human_halt';
    await store.write(slice);

    await store.transit('stall-2', 'ABANDON');

    const after = await store.read('stall-2');
    assert.equal(after.state, 'abandoned');
    assert.equal(after.stall.class, null);
  });

  it('非终态转换不动停机分类', async () => {
    const slice = store.create('stall-3', '带停机');
    slice.state = 'frozen';
    slice.stall.class = 'gate_retry';
    await store.write(slice);

    await store.transit('stall-3', 'RUN_START');

    const after = await store.read('stall-3');
    assert.equal(after.state, 'running');
    assert.equal(after.stall.class, 'gate_retry', '还在跑就不该清停机分类');
  });

  it('老状态文件里终态带着停机分类 —— 读的时候自愈', async () => {
    // 这就是 nimrtc-zelto 上 v1-net-feedback-core 的原样：
    // 门禁过了、切片 completed，却还挂着 gate_retry
    await writeFile(
      join(SLICES_DIR, 'legacy-terminal.json'),
      JSON.stringify({
        id: 'legacy-terminal',
        title: '老终态',
        state: 'completed',
        stall: { class: 'gate_retry', autoResolved: 0, gateRetries: 1 },
      }),
      'utf-8',
    );

    const slice = await store.read('legacy-terminal');
    assert.equal(slice.stall.class, null, '读出来就不该再带停机分类');

    const onDisk = JSON.parse(
      await readFile(join(SLICES_DIR, 'legacy-terminal.json'), 'utf-8'),
    );
    assert.equal(onDisk.stall.class, null, '文件里也要归正 —— 人是直接看文件的');
  });
});
