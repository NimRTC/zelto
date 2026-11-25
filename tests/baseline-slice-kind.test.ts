// 驾驶舱的「完成度」不许把基线切片算成开发进度
//
// 病灶（实测 nimrtc-v14，2026-11-25）：
//
//   驾驶舱概况页显示「8 个切片都完成了」—— 但那轮只开发了 **5 片**。
//
//   差的 3 片是 `v0-cmake` / `v0-src-log` / `v1-cmake` ——
//   **基线切片**：接管既有项目时登记的「现状」，不改代码，
//   从来不是这轮要开发的活。它们的状态也是 `completed`
//   （基线切片是既成事实，不是待办的活）。
//
//   驾驶舱的概况页把两者混在同一个 `byState` 计数里：
//
//     byState.completed = 8   ← 说的不是「开发完成度」
//
//   人看到的是「8 个切片都做完了」，而 v1.4 计划里
//   N5/N2/D3/D4/D5 只是 N、D 两条轨道的一部分 ——
//   「切片完成了」与「这版做完了」根本不是同一件事。
//
// 修法（两层）：
//   1. `core/slice/baseline-kind.ts`：**可证伪**的基线判据
//      （C3：纯判定，只读文件、不触网）
//   2. `adapters/web/api.ts` + 前端：基线与开发**分开计数**
//
// 这个文件钉住的核心是**判据的可证伪性** ——
// 特别是那条「零事件 + completed」的判据，它必须：
//   - 认得出老版本手工建的基线切片（`baseline` 字段缺失）
//   - **认不出**刚建还没动的开发切片（否则那片会从完成度里消失）
//   - **认不出**跑过的开发切片（哪怕事件流只剩下一条）
//
// 最后一条最要紧：**漏判基线 = 完成度虚高**，
// 而**误判基线 = 开发切片从完成度里消失**（少算）。
// 宁可少算 —— 人看到「少了一片」会去查，看到「多了一片」只会相信。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `zelto-baseline-kind-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');
const EVENTS_DIR = join(TEST_DIR, '.zelto', 'events');

/**
 * 写一个切片状态文件（直接写原始 JSON，绕过 create()）。
 *
 * `baseline` 默认**不写** —— 复现老状态文件的形态：
 * `store.create` 才写 `baseline: false`，那也是后来才加的字段，
 * 早期手工建的切片文件里压根没有它。
 */
async function writeSliceFile(
  id: string,
  body: Record<string, unknown> = {},
  opts: { withBaselineField?: boolean } = {},
): Promise<void> {
  const base: Record<string, unknown> = {
    id,
    title: `切片 ${id}`,
    state: 'completed',
    spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    writes: [],
    runs: [],
    clarifyRounds: 0,
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  if (opts.withBaselineField) base.baseline = false;
  await writeFile(join(SLICES_DIR, `${id}.json`), JSON.stringify({ ...base, ...body }, null, 2), 'utf-8');
}

/** 写一片的事件流。 */
async function writeEvents(sliceId: string, types: string[]): Promise<void> {
  const dir = join(EVENTS_DIR, sliceId);
  await mkdir(dir, { recursive: true });
  const lines = types.map((type, i) =>
    JSON.stringify({
      ts: `2026-01-01T00:00:0${i}.000Z`,
      runSeq: i,
      slice: sliceId,
      run: null,
      type,
      actor: 'zelto',
      payload: {},
    }),
  );
  await writeFile(join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

describe('基线切片 vs 开发切片：判据', () => {
  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('`baseline: true` 是基线切片（工具生成的权威标记）', async () => {
    const { classifySliceKind } = await import('../src/core/slice/baseline-kind.js');
    const kind = classifySliceKind({ id: 'x', state: 'completed', baseline: true }, []);
    assert.equal(kind, 'baseline');
  });

  it('`baseline` 字段缺失 + 零事件 + completed → 基线（老版本手工建的）', async () => {
    const { classifySliceKind } = await import('../src/core/slice/baseline-kind.js');
    const kind = classifySliceKind({ id: 'x', state: 'completed' }, []);
    assert.equal(kind, 'baseline');
  });

  it('`baseline` 字段缺失 + 零事件 + **不是 completed** → 开发切片', async () => {
    // 刚建、还没动的开发切片也是零事件 ——
    // 但它不是 completed（状态机还没走完），所以不是基线。
    const { classifySliceKind } = await import('../src/core/slice/baseline-kind.js');
    for (const state of ['draft', 'clarifying', 'frozen', 'running', 'abandoned']) {
      const kind = classifySliceKind({ id: 'x', state }, []);
      assert.equal(kind, 'development', `状态 ${state} 的零事件切片必须是开发切片`);
    }
  });

  it('`baseline` 字段缺失 + completed + **有事件** → 开发切片（跑过就不是基线）', async () => {
    const { classifySliceKind } = await import('../src/core/slice/baseline-kind.js');
    const events = [
      {
        ts: '',
        runSeq: 0,
        slice: 'x',
        run: null,
        type: 'run.started' as const,
        actor: 'zelto',
        payload: {},
      },
    ];
    const kind = classifySliceKind({ id: 'x', state: 'completed' }, events);
    assert.equal(kind, 'development');
  });

  it('`baseline: false` 明确不是基线（哪怕零事件）', async () => {
    const { classifySliceKind } = await import('../src/core/slice/baseline-kind.js');
    const kind = classifySliceKind({ id: 'x', state: 'completed', baseline: false }, []);
    assert.equal(kind, 'development');
  });

  it('事件流读不到（null）视作零事件 —— fail closed 到「更保守」的一侧', async () => {
    const { classifySliceKind } = await import('../src/core/slice/baseline-kind.js');
    // 读不到事件 → 视作零事件 → completed + 缺 baseline 字段 → 判成基线。
    // 这是「少算」的方向（不会把开发切片误算成完成）。
    const kind = classifySliceKind({ id: 'x', state: 'completed' }, null);
    assert.equal(kind, 'baseline');
  });

  it('异步版只在真需要时才读事件流', async () => {
    const { classifySliceKindAsync } = await import('../src/core/slice/baseline-kind.js');

    let reads = 0;
    const load = async () => {
      reads += 1;
      return [];
    };

    // `baseline: true` → 判据 1 出结论，不需要事件。
    await classifySliceKindAsync({ id: 'a', state: 'completed', baseline: true }, load);
    assert.equal(reads, 0, '`baseline: true` 时不该读事件流');

    // `baseline: false` → 判据 3 出结论，不需要事件。
    await classifySliceKindAsync({ id: 'b', state: 'completed', baseline: false }, load);
    assert.equal(reads, 0, '`baseline: false` 时不该读事件流');

    // 状态不是 completed → 判据 3 出结论，不需要事件。
    await classifySliceKindAsync({ id: 'c', state: 'draft' }, load);
    assert.equal(reads, 0, '状态不是 completed 时不该读事件流');

    // 缺 baseline 字段 + completed → 需要事件。
    const kind = await classifySliceKindAsync({ id: 'd', state: 'completed' }, load);
    assert.equal(reads, 1, '只有「缺 baseline 字段 + completed」才读事件流');
    assert.equal(kind, 'baseline');
  });
});

describe('驾驶舱：基线与开发分开计数', () => {
  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('nimrtc-v14 的真实形态：8 片 completed 里 3 片是基线，只 5 片是开发', async () => {
    // 完全复刻 nimrtc-v14 的现场：
    //   - 3 片老基线切片（`baseline` 字段缺失、零事件）
    //   - 5 片 v1.4 开发切片（`baseline: false`、有完整事件流）
    for (const id of ['v0-cmake', 'v0-src-log', 'v1-cmake']) {
      await writeSliceFile(id, { title: `基线 ${id}` });
    }
    for (const id of [
      'v1-audio-p2',
      'v1-device-policy',
      'v1-n5-turn-server',
      'v2-ice',
      'v3-n4-d6-connectivity',
    ]) {
      await writeSliceFile(id, { title: `开发 ${id}` }, { withBaselineField: true });
      await writeEvents(id, ['spec.drafted', 'spec.frozen', 'run.started', 'sign.approved']);
    }

    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(TEST_DIR);
    const summary = (await api.summary()) as {
      totalSlices: number;
      byState: Record<string, number>;
      development: { total: number; byState: Record<string, number>; completed: number };
      baseline: { total: number; ids: string[] };
    };

    assert.equal(summary.totalSlices, 8, '盘上共 8 片');
    assert.equal(summary.byState.completed, 8, 'byState 是「盘上各状态的片数」这个事实，不许被改');

    assert.equal(summary.development.total, 5, '开发切片只有 5 片');
    assert.equal(summary.development.completed, 5, '开发切片里 5 片 completed');

    assert.equal(summary.baseline.total, 3, '基线切片 3 片');
    assert.deepEqual(
      [...summary.baseline.ids].sort(),
      ['v0-cmake', 'v0-src-log', 'v1-cmake'],
    );
  });

  it('刚建还没动的开发切片不算基线（不许从完成度里消失）', async () => {
    await writeSliceFile('fresh-draft', { state: 'draft' });

    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(TEST_DIR);
    const summaries = await api.listSlices();
    const fresh = summaries.find((s) => s.id === 'fresh-draft');
    assert.ok(fresh, 'fresh-draft 必须在列表里');
    assert.equal(fresh.kind, 'development', 'draft 状态的切片是开发切片');
  });

  it('切片列表里每片都带 kind（前端据此分组）', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(TEST_DIR);
    const summaries = await api.listSlices();
    assert.ok(summaries.length > 0);
    for (const s of summaries) {
      assert.ok(
        s.kind === 'baseline' || s.kind === 'development',
        `切片 ${s.id} 的 kind 必须是 baseline 或 development，实际 ${s.kind}`,
      );
    }
  });
});
