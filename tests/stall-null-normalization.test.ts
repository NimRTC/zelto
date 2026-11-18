import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// `stall: null` 的老状态文件回归
//
// 起因：驾驶舱自查时发现「磁盘上 130 个切片文件，Web 列表只显示 113 个」。
// 少的 17 个不是坏了 —— 它们是**已完成交付**的切片（agent-timeout、
// ai-pipeline-*、hotfix-mode、parallel-flag …），状态文件里的 `stall` 字段
// 写成了 `null` 而不是 `{class: null, ...}`（停机分类落地之前的写法）。
//
// 失效链条：
//   store.read() 里 `slice.stall.class` → `stall` 为 null 时抛
//   `Cannot read properties of null (reading 'class')`
//   → listSlices() 的 try/catch 把这一片**静默吞掉**
//   → 文件在磁盘上、切片已交付，但人看的列表里查不到。
//
// 严重性在于**静默**：切片的「存在」本身是追溯链的一环 —— 它消失了，
// 人就查不到它了，而且没有任何报错提示少了 17 片。
//
// 修法：读时归一化 + 写时归一化（闭环）—— `stall: null` 的语义就是
// 「这片没停机」，翻译成 `{class: null, autoResolved: 0, gateRetries: 0}`
// 是如实，不是编造。

const TEST_DIR = join(tmpdir(), `zelto-stall-null-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');
const EVENTS_DIR = join(TEST_DIR, '.zelto', 'events');

/** 写一个 `stall` 字段形态各异的切片状态文件（直接写原始 JSON，绕过 create()）。 */
async function writeSliceFile(id: string, stall: unknown, state = 'completed'): Promise<void> {
  const body = {
    id,
    title: `切片 ${id}`,
    state,
    spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes: [],
    runs: [],
    clarifyRounds: 0,
    stall,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
  };
  await writeFile(join(SLICES_DIR, `${id}.json`), JSON.stringify(body, null, 2), 'utf-8');
}

describe('stall 字段归一化：老文件里的 stall:null 不得让切片消失', () => {
  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  // ── store.read()：不许抛 ──────────────────────────────────────────────

  it('store.read()：stall 为 null 的切片必须读得出来，不许抛异常', async () => {
    const { SliceStore } = await import('../src/core/slice/store.js');
    const store = new SliceStore(SLICES_DIR);
    await writeSliceFile('stall-null-read', null);

    const slice = await store.read('stall-null-read');

    assert.equal(slice.id, 'stall-null-read', '切片必须读得到');
    assert.equal(slice.state, 'completed', '状态必须原样保留');
  });

  it('store.read()：stall 归一化成「没停机」的正统写法', async () => {
    const { SliceStore } = await import('../src/core/slice/store.js');
    const store = new SliceStore(SLICES_DIR);
    await writeSliceFile('stall-null-shape', null);

    const slice = await store.read('stall-null-shape');

    assert.deepEqual(
      slice.stall,
      { class: null, autoResolved: 0, gateRetries: 0 },
      'stall:null 必须归一化成 {class:null, autoResolved:0, gateRetries:0}',
    );
  });

  it('store.read()：stall 字段整个缺失时也要归一化（不能是 undefined）', async () => {
    const { SliceStore } = await import('../src/core/slice/store.js');
    const store = new SliceStore(SLICES_DIR);
    // 整个字段都没有 —— 比 null 更老的状态文件
    await writeFile(
      join(SLICES_DIR, 'stall-missing.json'),
      JSON.stringify({
        id: 'stall-missing',
        title: '没有 stall 字段',
        state: 'completed',
        spec: { path: '', frozenHash: null, frozenAt: null },
        acceptance: { dir: '', frozenHash: null, oracleSrc: null },
        baseCommit: null,
        drift: { detected: false, reason: null, at: null },
        trace: { requirements: [], contracts: [], tests: [] },
        traceWaiver: null,
        baseline: false,
        writes: [],
        runs: [],
        createdAt: '2026-11-16T00:00:00.000Z',
        updatedAt: '2026-11-16T00:00:00.000Z',
      }),
      'utf-8',
    );

    const slice = await store.read('stall-missing');

    assert.deepEqual(slice.stall, { class: null, autoResolved: 0, gateRetries: 0 });
  });

  it('store.read()：stall 已有分类时必须原样保留（不能被归一化抹掉）', async () => {
    const { SliceStore } = await import('../src/core/slice/store.js');
    const store = new SliceStore(SLICES_DIR);
    await writeSliceFile('stall-real', { class: 'gate_retry', autoResolved: 2, gateRetries: 3 }, 'running');

    const slice = await store.read('stall-real');

    assert.equal(slice.stall.class, 'gate_retry', '真实的停机分类不能被抹掉');
    assert.equal(slice.stall.autoResolved, 2);
    assert.equal(slice.stall.gateRetries, 3);
  });

  // ── 终态自愈：不该因此丢片 ────────────────────────────────────────────

  it('终态自愈：stall:null 的终态切片读完不能被吞掉', async () => {
    const { SliceStore } = await import('../src/core/slice/store.js');
    const store = new SliceStore(SLICES_DIR);
    await writeSliceFile('stall-null-terminal', null, 'completed');

    // 自愈逻辑会尝试写回（清空停机分类）—— 归一化后 class 已是 null，
    // 条件不成立，不需要写；即使写也必须不抛。
    const slice = await store.read('stall-null-terminal');
    assert.equal(slice.state, 'completed');
    assert.equal(slice.stall.class, null);
  });

  // ── write()：闭环，老形态不许再落回磁盘 ──────────────────────────────

  it('store.write()：写出去的 stall 不能又是 null（闭环）', async () => {
    const { SliceStore } = await import('../src/core/slice/store.js');
    const store = new SliceStore(SLICES_DIR);
    await writeSliceFile('stall-null-write', null);

    const slice = await store.read('stall-null-write');
    // 模拟某处构造了 stall:null 的对象再写回去
    (slice as unknown as { stall: unknown }).stall = null;
    await store.write(slice);

    const raw = JSON.parse(await readFile(join(SLICES_DIR, 'stall-null-write.json'), 'utf-8'));
    assert.notEqual(raw.stall, null, '写出去的文件里 stall 不能还是 null');
    assert.deepEqual(raw.stall, { class: null, autoResolved: 0, gateRetries: 0 });
  });

  // ── 端到端：列表不许少片 ─────────────────────────────────────────────

  it('WebApi.listSlices()：磁盘上几片就必须列出几片（不许静默吞片）', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const { SliceStore } = await import('../src/core/slice/store.js');

    // 三个形态各一片：null、缺失、正常
    const ids = ['e2e-null', 'e2e-normal'];
    for (const id of ids) await writeSliceFile(id, null);
    await writeSliceFile('e2e-ok', { class: null, autoResolved: 0, gateRetries: 0 });

    // listSlices 读的是 store.list() —— 让它看到我们这几个文件
    const store = new SliceStore(SLICES_DIR);
    const allIds = await store.list();
    assert.ok(allIds.length >= 3, `测试目录里至少要有 3 个切片文件，实际 ${allIds.length}`);

    const api = new WebApi(TEST_DIR);
    const summaries = await api.listSlices();
    const returned = new Set(summaries.map((s) => s.id));

    for (const id of ids) {
      assert.ok(returned.has(id), `切片 ${id} 必须出现在列表里（stall:null 不许让它消失）`);
    }
  });

  it('WebApi.summary()：totalSlices 必须等于磁盘上的切片数', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const { SliceStore } = await import('../src/core/slice/store.js');

    const store = new SliceStore(SLICES_DIR);
    const diskCount = (await store.list()).length;

    const api = new WebApi(TEST_DIR);
    const summary = (await api.summary()) as { totalSlices: number };

    assert.equal(
      summary.totalSlices,
      diskCount,
      `summary 说有 ${summary.totalSlices} 片，磁盘上有 ${diskCount} 片 —— 少的那几片是静默丢的`,
    );
  });
});
