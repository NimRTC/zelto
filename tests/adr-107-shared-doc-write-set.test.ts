// ADR-107 · 共享「只追加文档」不算写集硬冲突
//
// 病灶：两片的**代码**写集完全不重叠，但都写了 `CHANGELOG.md` 与
// `docs/api/engine_api.md` —— 于是 `zelto run` 把第二片拦下，
// 整个舰队降为串行。
//
// 而文档是**追加式**的：每片各写自己的一节，真撞上了也是 git 合并期
// 可见的冲突，不是代码被静默写坏。
//
// 这个文件钉住四件事：
//   1. 判据 `isAppendOnlyDocPath` 的边界（哪些算、哪些不算）；
//   2. 冲突判定 `writeSetsConflict` 分硬 / 软；
//   3. `admit()` 只按**硬**冲突拦，软重叠进事件留痕；
//   4. 规格副本、glob、代码路径**仍然**是硬冲突。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isAppendOnlyDocPath, writeSetsConflict } from '../src/core/sched/paths.js';
import { Scheduler } from '../src/core/sched/engine.js';
import { EventStream } from '../src/core/events/stream.js';
import { SliceStore, type SliceData } from '../src/core/slice/store.js';
import type { PolicyConfig } from '../src/core/policy/types.js';

const TEST_DIR = join(tmpdir(), `zelto-adr107-test-${Date.now()}`);

// ─── 判据边界 ───────────────────────────────────────────────────────────────

describe('ADR-107 · isAppendOnlyDocPath 的边界', () => {
  it('根级 markdown → 算', () => {
    assert.equal(isAppendOnlyDocPath('CHANGELOG.md'), true);
    assert.equal(isAppendOnlyDocPath('README.md'), true);
  });

  it('docs/ 下的 markdown → 算', () => {
    assert.equal(isAppendOnlyDocPath('docs/api/engine_api.md'), true);
    assert.equal(isAppendOnlyDocPath('docs/plan/v1.4-plan.md'), true);
  });

  it('反斜杠写法 → 算（路径统一正斜杠）', () => {
    assert.equal(isAppendOnlyDocPath('docs\\api\\engine_api.md'), true);
  });

  it('glob 形态 → 不算（那是在声称整片文档面）', () => {
    assert.equal(isAppendOnlyDocPath('docs/**'), false);
    assert.equal(isAppendOnlyDocPath('**/*.md'), false);
    assert.equal(isAppendOnlyDocPath('*.md'), false);
  });

  it('目录形态 → 不算', () => {
    assert.equal(isAppendOnlyDocPath('docs/api/'), false);
  });

  it('规格副本 → 不算（ADR-046 / ADR-106 管，真冲突）', () => {
    assert.equal(isAppendOnlyDocPath('specs/slices/v1-turn-tls-trust.md'), false);
  });

  it('非 markdown → 不算', () => {
    assert.equal(isAppendOnlyDocPath('docs/api/diagram.svg'), false);
    assert.equal(isAppendOnlyDocPath('src/engine/src/engine.cpp'), false);
    assert.equal(isAppendOnlyDocPath('CHANGELOG.txt'), false);
  });

  it('docs/ 之外的非根级 markdown → 不算', () => {
    // `src/README.md` 不是文档面的一部分 —— 它跟着代码走。
    assert.equal(isAppendOnlyDocPath('src/README.md'), false);
  });

  it('空串 → 不算', () => {
    assert.equal(isAppendOnlyDocPath(''), false);
    assert.equal(isAppendOnlyDocPath('   '), false);
  });
});

// ─── 冲突判定 ───────────────────────────────────────────────────────────────

describe('ADR-107 · writeSetsConflict 分硬 / 软', () => {
  it('共享 CHANGELOG.md → 软冲突，不算硬', () => {
    const r = writeSetsConflict(
      ['src/engine/src/engine.cpp', 'CHANGELOG.md'],
      ['cmake/NimRTCInstall.cmake', 'CHANGELOG.md'],
    );
    assert.deepEqual(r.hard, []);
    assert.deepEqual(r.soft, ['CHANGELOG.md']);
  });

  it('共享代码文件 → 硬冲突', () => {
    const r = writeSetsConflict(
      ['src/engine/src/engine.cpp'],
      ['src/engine/src/engine.cpp'],
    );
    assert.deepEqual(r.hard, ['src/engine/src/engine.cpp']);
    assert.deepEqual(r.soft, []);
  });

  it('一边是 glob → 硬冲突（glob 不被容忍）', () => {
    const r = writeSetsConflict(['docs/**'], ['docs/api/engine_api.md']);
    assert.equal(r.hard.length, 1);
    assert.deepEqual(r.soft, []);
  });

  it('规格副本 → 硬冲突', () => {
    const r = writeSetsConflict(
      ['specs/slices/x.md'],
      ['specs/slices/x.md'],
    );
    assert.deepEqual(r.hard, ['specs/slices/x.md']);
  });

  it('硬与软同时存在 → 分开列', () => {
    const r = writeSetsConflict(
      ['src/a.cpp', 'CHANGELOG.md'],
      ['src/a.cpp', 'CHANGELOG.md', 'docs/api/x.md'],
    );
    assert.deepEqual(r.hard, ['src/a.cpp']);
    // 软冲突列的是**两边都写的**路径 —— A 没有 docs/api/x.md，
    // 所以它不是这一对的软重叠。
    assert.deepEqual(r.soft, ['CHANGELOG.md']);
  });

  it('无重叠 → 两边都空', () => {
    const r = writeSetsConflict(['src/a.cpp'], ['src/b.cpp']);
    assert.deepEqual(r.hard, []);
    assert.deepEqual(r.soft, []);
  });
});

// ─── admit() 的行为 ─────────────────────────────────────────────────────────

const EMPTY_POLICY: PolicyConfig = { version: 1, rules: [] } as unknown as PolicyConfig;

function makeSlice(id: string, writes: string[]): SliceData {
  return {
    id,
    title: id,
    state: 'frozen',
    writes,
    baseline: false,
    spec: {
      path: `specs/slices/${id}.md`,
      frozenHash: 'a'.repeat(64),
      boundaryHash: 'b'.repeat(64),
      frozenAt: new Date().toISOString(),
    },
    trace: { requirements: ['(test)'], contracts: [], tests: [] },
    traceWaiver: null,
    stall: { class: null, autoResolved: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as SliceData;
}

describe('ADR-107 · admit() 只按硬冲突拦', () => {
  let store: SliceStore;
  let events: EventStream;

  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto'), { recursive: true });
    store = new SliceStore(join(TEST_DIR, '.zelto'));
    events = new EventStream(join(TEST_DIR, '.zelto'));
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  /** 把某片置为 running（占着写集） */
  async function markRunning(id: string): Promise<void> {
    const s = await store.read(id);
    s.state = 'running';
    await store.write(s);
  }

  it('共享只追加文档 → 准入通过', async () => {
    await store.write(makeSlice('doc-a', ['src/engine/src/engine.cpp', 'CHANGELOG.md']));
    await store.write(makeSlice('doc-b', ['cmake/NimRTCInstall.cmake', 'CHANGELOG.md']));
    await markRunning('doc-a');

    const scheduler = new Scheduler(store, events, EMPTY_POLICY);
    const result = await scheduler.admit('doc-b');

    assert.equal(result.decision, 'admitted');
    assert.deepEqual(result.blockedBy, []);
  });

  it('共享代码文件 → 准入被拒', async () => {
    await store.write(makeSlice('code-a', ['src/engine/src/only-a.cpp']));
    await store.write(makeSlice('code-b', ['src/engine/src/only-a.cpp']));
    await markRunning('code-a');

    const scheduler = new Scheduler(store, events, EMPTY_POLICY);
    const result = await scheduler.admit('code-b');

    assert.equal(result.decision, 'blocked');
    assert.ok(result.blockedBy.includes('code-a'));
  });

  it('软重叠进 sched.admitted 事件留痕（C4）', async () => {
    await store.write(makeSlice('evt-a', ['src/evt/x.cpp', 'CHANGELOG.md']));
    await store.write(makeSlice('evt-b', ['src/evt/y.cpp', 'CHANGELOG.md']));
    await markRunning('evt-a');

    const scheduler = new Scheduler(store, events, EMPTY_POLICY);
    const result = await scheduler.admit('evt-b');
    assert.equal(result.decision, 'admitted');

    const chain = await events.read('evt-b');
    const admitted = chain.find((e) => e.type === 'sched.admitted');
    assert.ok(admitted, 'sched.admitted 事件应当存在');
    assert.deepEqual((admitted?.payload as Record<string, unknown>)['softOverlaps'], ['CHANGELOG.md']);
  });
});
