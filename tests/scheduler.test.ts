import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Scheduler } from '../src/core/sched/engine.js';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';
import type { PolicyConfig } from '../src/core/policy/types.js';

const TEST_DIR = join(tmpdir(), `zelto-sched-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, 'slices');
const EVENTS_DIR = join(TEST_DIR, 'events');

const samplePolicy: PolicyConfig = {
  rules: [
    { id: 'allow-src', match: { path: 'src/**/*.ts', operation: 'write' }, action: 'allow', basis: 'policy.yaml' },
    { id: 'allow-tests', match: { path: 'tests/**/*.ts', operation: 'write' }, action: 'allow', basis: 'policy.yaml' },
  ],
  protected: [],
};

describe('Scheduler — admit', () => {
  let store: SliceStore;
  let events: EventStream;
  let scheduler: Scheduler;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
    scheduler = new Scheduler(store, events, samplePolicy);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('admits a frozen slice with no conflicts', async () => {
    const slice = store.create('slice-a', 'Slice A', {
      writes: ['src/core/feature-a/**'],
      trace: { requirements: ['R1: 切片 A 的需求出处'], contracts: [], tests: [] },
    });
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    const result = await scheduler.admit('slice-a');
    assert.equal(result.decision, 'admitted');
    assert.equal(result.blockedBy.length, 0);
  });

  it('blocks a slice that is not frozen', async () => {
    const slice = store.create('slice-draft', 'Draft slice');
    // Default state is 'draft', no frozenHash
    await store.write(slice);

    const result = await scheduler.admit('slice-draft');
    assert.equal(result.decision, 'blocked');
    assert.ok(result.reason?.includes('draft'));
  });

  it('blocks a slice with write-set conflict', async () => {
    const sliceA = store.create('slice-conflict-a', 'Conflict A', {
      writes: ['src/shared/component.ts'],
      trace: { requirements: ['R1: 切片 A 的需求出处'], contracts: [], tests: [] },
    });
    sliceA.state = 'frozen';
    sliceA.spec.frozenHash = 'abc';
    sliceA.spec.frozenAt = new Date().toISOString();
    await store.write(sliceA);

    // Start slice A (simulate running)
    await store.transit('slice-conflict-a', 'RUN_START');

    const sliceB = store.create('slice-conflict-b', 'Conflict B', {
      writes: ['src/shared/component.ts'],
      trace: { requirements: ['R1: 切片 B 的需求出处'], contracts: [], tests: [] },
    });
    sliceB.state = 'frozen';
    sliceB.spec.frozenHash = 'def';
    sliceB.spec.frozenAt = new Date().toISOString();
    await store.write(sliceB);

    const result = await scheduler.admit('slice-conflict-b');
    assert.equal(result.decision, 'blocked');
    assert.ok(result.blockedBy.includes('slice-conflict-a'));
  });

  it('admits slices with non-overlapping write-sets', async () => {
    const sliceA = store.create('slice-nonoverlap-a', 'Non-overlap A', {
      writes: ['src/feature-x/**'],
      trace: { requirements: ['R1: 切片 A 的需求出处'], contracts: [], tests: [] },
    });
    sliceA.state = 'frozen';
    sliceA.spec.frozenHash = 'abc';
    sliceA.spec.frozenAt = new Date().toISOString();
    await store.write(sliceA);
    await store.transit('slice-nonoverlap-a', 'RUN_START');

    const sliceB = store.create('slice-nonoverlap-b', 'Non-overlap B', {
      writes: ['src/feature-y/**'],
      trace: { requirements: ['R1: 切片 B 的需求出处'], contracts: [], tests: [] },
    });
    sliceB.state = 'frozen';
    sliceB.spec.frozenHash = 'def';
    sliceB.spec.frozenAt = new Date().toISOString();
    await store.write(sliceB);

    const result = await scheduler.admit('slice-nonoverlap-b');
    assert.equal(result.decision, 'admitted');
  });

  it('records sched.admitted and sched.blocked events', async () => {
    const slice = store.create('slice-events', 'Events test', {
      writes: ['src/events-test/**'],
      trace: { requirements: ['R1: 准入要留下 sched.admitted 事件'], contracts: [], tests: [] },
    });
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    await scheduler.admit('slice-events');

    const evts = await events.read('slice-events');
    const types = evts.map((e) => e.type);
    assert.ok(types.includes('sched.admitted'));
  });
});

describe('Scheduler — buildConstraints', () => {
  let store: SliceStore;
  let events: EventStream;
  let scheduler: Scheduler;

  before(async () => {
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
    scheduler = new Scheduler(store, events, samplePolicy);
  });

  it('builds constraint bundle with instructions', async () => {
    const slice = store.create('constraint-test', 'Constraint test', {
      writes: ['src/feature/**/*.ts'],
      trace: { requirements: ['REQ-1'], contracts: ['CT-1'], tests: ['tests/feature.test.ts'] },
    });
    slice.spec.frozenHash = 'abc123';
    slice.acceptance = { dir: 'tests/acceptance/constraint-test/', frozenHash: null, oracleSrc: null };

    const bundle = scheduler.buildConstraints(slice);

    assert.equal(bundle.sliceId, 'constraint-test');
    assert.equal(bundle.frozenHash, 'abc123');
    assert.ok(bundle.writes.includes('src/feature/**/*.ts'));
    assert.ok(bundle.protectedPaths.includes('policy/**'));
    assert.ok(bundle.instructions.includes('Write-set'));
    assert.ok(bundle.instructions.includes('Protected paths'));
  });
});

describe('Scheduler — startRun 清停机分类', () => {
  let store: SliceStore;
  let events: EventStream;
  let scheduler: Scheduler;

  before(async () => {
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
    scheduler = new Scheduler(store, events, samplePolicy);
  });

  it('开跑时清掉挂着的停机分类（否则 zelto next 会一直指着它）', async () => {
    const slice = store.create('stalled-run', 'Stalled run');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc';
    slice.stall.class = 'human_halt';
    await store.write(slice);

    await scheduler.startRun('stalled-run');

    const after = await store.read('stalled-run');
    assert.equal(after.state, 'running');
    assert.equal(after.stall.class, null, '停机分类应当在开跑时清掉');
  });

  it('清分类时留一条 run.resumed 事件', async () => {
    const slice = store.create('stalled-run-2', 'Stalled run 2');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc';
    slice.stall.class = 'human_halt';
    await store.write(slice);

    await scheduler.startRun('stalled-run-2');

    const evts = await events.read('stalled-run-2');
    const resumed = evts.find((e) => e.type === 'run.resumed');
    assert.ok(resumed, '应当留下续跑事件');
    assert.equal(resumed?.payload.previousStallClass, 'human_halt');
  });

  it('没有停机分类时不写多余事件', async () => {
    const slice = store.create('clean-run', 'Clean run');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc';
    await store.write(slice);

    await scheduler.startRun('clean-run');

    const evts = await events.read('clean-run');
    assert.equal(evts.filter((e) => e.type === 'run.resumed').length, 0);
    assert.equal((await store.read('clean-run')).state, 'running');
  });

  it('transit 失败时什么都不落地 —— 事件不写、分类不清（账本与状态脱钩）', async () => {
    // 「状态被别处改过」的具体形态：读快照之后、transit 之前，有别处把它
    // 改成了终态。终态不能 RUN_START —— transit 会抛 Invalid transition。
    const slice = store.create('conflict-run', 'Conflict run');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc';
    slice.stall.class = 'human_halt';
    await store.write(slice);

    const realRead = store.read.bind(store);
    let reads = 0;
    store.read = async (id: string) => {
      // 第一次 read 是 startRun 的快照；之后（transit 内部）把它换成 abandoned = 被别处改过
      reads += 1;
      if (reads > 1) {
        const fresh = await realRead(id);
        return { ...fresh, state: 'abandoned' as const };
      }
      return realRead(id);
    };

    try {
      await assert.rejects(() => scheduler.startRun('conflict-run'));
    } finally {
      store.read = realRead;
    }

    // 读回来会触发终态自愈（abandoned 不该带停机分类），所以只断言：
    // 账本上没有「续跑」—— 迁移没成，事件就不能有。
    const evts = await events.read('conflict-run');
    assert.equal(evts.filter((e) => e.type === 'run.resumed').length, 0, '迁移失败时不能留下续跑事件');
  });
});
