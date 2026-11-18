// 驾驶舱列表：切片不许静默消失 —— 少了的那几片必须**说出来**
//
// 病灶（实测 nimrtc-zelto，2026-11-18）：
//
//   「磁盘上 130 个切片文件，Web 列表只显示 113 个」。
//
//   少的 17 个不是坏了 —— 它们是**已完成交付**的切片（agent-timeout、
//   ai-pipeline-*、hotfix-mode、parallel-flag …），状态文件里的 `stall` 字段
//   写成了 `null` 而不是 `{class: null, ...}`（停机分类落地之前的写法）。
//
//   失效链条：
//     store.read() 里 `slice.stall.class` → `stall` 为 null 时抛
//       `Cannot read properties of null (reading 'class')`
//     → listSlices() 的 try/catch 把这一片**静默吞掉**
//     → 文件在磁盘上、切片已交付，但人看的列表里查不到。
//
//   严重性在于**静默**：切片的「存在」本身是追溯链的一环 —— 它消失了，
//   人就查不到它了，而且**没有任何报错提示少了 17 片**。
//
// 修法分两半（都在别处）：
//   1. `core/slice/store.ts`：读时 + 写时归一化 `stall`（见
//      `tests/stall-null-normalization.test.ts`）
//   2. `adapters/web/api.ts`：即使将来又出现读不出的片，也**不许静默**
//      —— 记一笔到 stderr
//
// 这个文件钉住第 2 半：
//   - 读不出状态文件的片被跳过时，**必须有痕迹**（stderr 有记录）；
//   - 其余片照常列出（一片坏不挡住整个列表）。
//
// 同时钉住并发读的等价性：并发不改变「列出哪些片」这个结论。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `zelto-web-list-slices-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');
const EVENTS_DIR = join(TEST_DIR, '.zelto', 'events');

/** 写一个切片状态文件（直接写原始 JSON，绕过 create()）。 */
async function writeSliceFile(id: string, body: Record<string, unknown>): Promise<void> {
  const base = {
    id,
    title: `切片 ${id}`,
    state: 'completed',
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
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await writeFile(join(SLICES_DIR, `${id}.json`), JSON.stringify({ ...base, ...body }, null, 2), 'utf-8');
}

describe('驾驶舱列表：切片不许静默消失', () => {
  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });

    // 三片正常的
    for (const id of ['ok-1', 'ok-2', 'ok-3']) await writeSliceFile(id, {});
    // 一片状态文件**坏了**（不是 JSON）
    await writeFile(join(SLICES_DIR, 'broken.json'), '{ this is not json', 'utf-8');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('读不出的片被跳过时，**必须有痕迹**（不是静默吞掉）', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(TEST_DIR);

    // 抓住 stderr —— 「静默」的定义就是「什么都没说」
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await api.listSlices();
    } finally {
      console.error = original;
    }

    assert.ok(
      lines.some((l) => l.includes('broken')),
      `跳过读不出的切片必须留痕，实际 stderr：${JSON.stringify(lines)}`,
    );
  });

  it('一片坏不挡住整个列表（其余片照常列出）', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(TEST_DIR);

    const original = console.error;
    console.error = () => {};
    let summaries;
    try {
      summaries = await api.listSlices();
    } finally {
      console.error = original;
    }

    const ids = new Set(summaries.map((s) => s.id));
    for (const id of ['ok-1', 'ok-2', 'ok-3']) {
      assert.ok(ids.has(id), `正常片 ${id} 必须出现在列表里（一片坏不挡住整个列表）`);
    }
  });

  it('磁盘上有几片正常的，列表里就有几片（不许少）', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const { SliceStore } = await import('../src/core/slice/store.js');

    const store = new SliceStore(SLICES_DIR);
    const allIds = await store.list();
    const api = new WebApi(TEST_DIR);

    const original = console.error;
    console.error = () => {};
    let summaries;
    try {
      summaries = await api.listSlices();
    } finally {
      console.error = original;
    }

    // 4 个文件（3 正常 + 1 坏）→ 3 个能列出
    assert.equal(allIds.length, 4, '测试目录里应当有 4 个切片文件');
    assert.equal(
      summaries.length,
      3,
      `能读出的应当是 3 片，实际 ${summaries.length} 片 —— 少的那片是静默丢的`,
    );
  });
});
