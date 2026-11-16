import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// BOM 容错回归（D-34）
//
// 起因：Web 驾驶舱自查时，用 PowerShell 写出的探针事件文件带了 BOM，
// 结果 `EventStream.read()` 整行解析失败 → `gate.result` 事件被静默丢掉
// → 签字页的「验收真跑过」判据误判为不过 → 签字按钮永远解锁不了。
//
// 问题的严重性在于**静默**：C4 说事件流是「追溯的唯一证据载体」，
// 一行读不懂就被丢掉，等于证据凭空消失，而且没有任何报错。
//
// 修法：读时容错、写时不动（仓库既有惯例，8 处都是这个写法）。
// 注意 `trim()` 救不了 —— U+FEFF 属于 JS 的 WhiteSpace，trim() 会去掉它，
// 但 `JSON.parse` 不接受带 BOM 的字符串，必须显式剥。

const TEST_DIR = join(tmpdir(), `zelto-bom-test-${Date.now()}`);
const BOM = String.fromCharCode(0xfeff);

describe('BOM 容错：读时容错、写时不动（D-34）', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  // ── 事件流：证据不能凭空消失 ──────────────────────────────────────────

  it('事件流：带 BOM 的首行必须读得到，不能被静默丢掉', async () => {
    const { EventStream } = await import('../src/core/events/stream.js');
    const sliceId = 'bom-events';
    const dir = join(TEST_DIR, '.zelto', 'events', sliceId);
    await mkdir(dir, { recursive: true });

    const ev1 = {
      ts: '2026-11-16T00:00:00.000Z',
      runSeq: 1,
      slice: sliceId,
      run: null,
      type: 'gate.result',
      actor: 'zelto',
      payload: { passed: true },
    };
    const ev2 = {
      ts: '2026-11-16T00:00:01.000Z',
      runSeq: 2,
      slice: sliceId,
      run: null,
      type: 'sign.approved',
      actor: 'human',
      payload: {},
    };

    // 首行带 BOM —— 这是外部工具 / PowerShell 追加的典型痕迹
    await writeFile(
      join(dir, 'events.jsonl'),
      BOM + JSON.stringify(ev1) + '\n' + JSON.stringify(ev2) + '\n',
      'utf-8',
    );

    const stream = new EventStream(join(TEST_DIR, '.zelto', 'events'));
    const read = await stream.read(sliceId);

    assert.equal(read.length, 2, `带 BOM 的事件文件必须读全 2 条，实际读出 ${read.length} 条`);
    assert.equal(read[0].type, 'gate.result', '首条事件类型必须读对');
    assert.equal(read[0].runSeq, 1, '首条事件的 runSeq 必须读对');
    assert.equal(read[1].type, 'sign.approved', '第二条事件必须读得到');
  });

  it('事件流：BOM 只在首行时也不能影响后续行', async () => {
    const { EventStream } = await import('../src/core/events/stream.js');
    const sliceId = 'bom-mid';
    const dir = join(TEST_DIR, '.zelto', 'events', sliceId);
    await mkdir(dir, { recursive: true });

    const mk = (runSeq: number, type: string) =>
      JSON.stringify({
        ts: '2026-11-16T00:00:00.000Z',
        runSeq,
        slice: sliceId,
        run: null,
        type,
        actor: 'zelto',
        payload: {},
      });

    await writeFile(
      join(dir, 'events.jsonl'),
      mk(1, 'run.started') + '\n' + BOM + mk(2, 'run.finished') + '\n',
      'utf-8',
    );

    const stream = new EventStream(join(TEST_DIR, '.zelto', 'events'));
    const read = await stream.read(sliceId);

    assert.equal(read.length, 2, `两行都必须读得到，实际 ${read.length} 行`);
    assert.equal(read[1].type, 'run.finished');
  });

  it('事件流：重启后序号不能因 BOM 撞号（追溯链不能乱）', async () => {
    const { EventStream } = await import('../src/core/events/stream.js');
    const sliceId = 'bom-seq';
    const dir = join(TEST_DIR, '.zelto', 'events', sliceId);
    await mkdir(dir, { recursive: true });

    await writeFile(
      join(dir, 'events.jsonl'),
      BOM +
        JSON.stringify({
          ts: '2026-11-16T00:00:00.000Z',
          runSeq: 41,
          slice: sliceId,
          run: null,
          type: 'run.finished',
          actor: 'zelto',
          payload: {},
        }) +
        '\n',
      'utf-8',
    );

    const stream = new EventStream(join(TEST_DIR, '.zelto', 'events'));
    // restoreSeq 是异步的 —— 等它落定
    await new Promise((r) => setTimeout(r, 300));

    const next = await stream.append(sliceId, 'run.started', 'zelto', {});
    // 关键：runSeq 必须**大于**既有的 41 —— 撞号意味着追溯链乱了。
    // 断言不能写死具体数字（全局序号会被别的用例推进），
    // 只能断言「比既有的最大值更大」。
    assert.ok(
      next.runSeq > 41,
      `新事件的 runSeq 必须大于既有最大值 41，实际 ${next.runSeq}`,
    );
  });

  it('事件流：写出去的文件不该带 BOM（写时不动 = 不主动加，也不主动抹）', async () => {
    const { EventStream } = await import('../src/core/events/stream.js');
    const sliceId = 'bom-write';
    const stream = new EventStream(join(TEST_DIR, '.zelto', 'events'));
    await stream.append(sliceId, 'run.started', 'zelto', {});

    const raw = await readFile(
      join(TEST_DIR, '.zelto', 'events', sliceId, 'events.jsonl'),
      'utf-8',
    );
    assert.equal(raw.charCodeAt(0), 0x7b, '写出的文件首字符必须是 {（不能带 BOM）');
  });

  // ── 其它状态文件：同族容错 ────────────────────────────────────────────

  it('切片状态：带 BOM 的切片文件必须读得到', async () => {
    const { SliceStore } = await import('../src/core/slice/store.js');
    const store = new SliceStore(join(TEST_DIR, '.zelto', 'slices'));
    const id = 'bom-slice';

    const slice = {
      id,
      title: 'BOM 切片',
      state: 'completed',
      spec: { path: `specs/slices/${id}.md`, frozenHash: 'h', frozenAt: '2026-11-16T00:00:00.000Z' },
      acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
      baseCommit: null,
      drift: { detected: false, reason: null, at: null },
      trace: { requirements: ['REQ-1'], contracts: [], tests: ['T-1'] },
      traceWaiver: null,
      baseline: false,
      writes: ['src/a.ts'],
      runs: [],
      stall: { class: null, autoResolved: 0, gateRetries: 0 },
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z',
    };
    await writeFile(join(TEST_DIR, '.zelto', 'slices', `${id}.json`), BOM + JSON.stringify(slice), 'utf-8');

    const read = await store.read(id);
    assert.equal(read.id, id, '带 BOM 的切片文件必须读得到');
    assert.equal(read.title, 'BOM 切片');
  });

  it('签字请求：带 BOM 的签字文件必须读得到（否则签字页看不到待签）', async () => {
    const { SignManager } = await import('../src/core/gate/sign.js');
    const { EventStream } = await import('../src/core/events/stream.js');
    const { SliceStore } = await import('../src/core/slice/store.js');

    const events = new EventStream(join(TEST_DIR, '.zelto', 'events'));
    const store = new SliceStore(join(TEST_DIR, '.zelto', 'slices'));
    // SignManager 的 baseDir 是 .zelto 根目录（内部自己拼 locks/）
    const mgr = new SignManager(join(TEST_DIR, '.zelto'), events, store);
    const id = 'sign-bom-1';

    await writeFile(
      join(TEST_DIR, '.zelto', 'locks', `${id}.json`),
      BOM +
        JSON.stringify({
          id,
          sliceId: 'some-slice',
          requestedAt: '2026-11-16T00:00:00.000Z',
          requestedBy: 'human',
          status: 'pending',
          decidedAt: null,
          decidedBy: null,
          comment: null,
        }),
      'utf-8',
    );

    const got = await mgr.get(id);
    assert.equal(got.id, id, '带 BOM 的签字文件必须读得到');
    assert.equal(got.status, 'pending');

    // list() 也要能列出来 —— 签字页靠的是 list，不是 get
    const list = await mgr.list('pending');
    assert.ok(
      list.some((r: { id: string }) => r.id === id),
      '带 BOM 的签字请求必须出现在待签字列表里',
    );
  });

  it('写集预约：带 BOM 的预约文件必须读得到（fail closed 不能变 fail open）', async () => {
    const { ReservationStore } = await import('../src/core/sched/reservation.js');
    const store = new ReservationStore(join(TEST_DIR, '.zelto', 'locks'));
    const sliceId = 'bom-res';

    await writeFile(
      join(TEST_DIR, '.zelto', 'locks', `${sliceId}.json`),
      BOM +
        JSON.stringify({
          sliceId,
          writes: ['src/a.ts'],
          acquiredAt: '2026-11-16T00:00:00.000Z',
          runId: null,
        }),
      'utf-8',
    );

    const got = await store.read(sliceId);
    assert.ok(got, '带 BOM 的预约文件必须读得到');
    assert.deepEqual(got!.writes, ['src/a.ts']);
  });
});
