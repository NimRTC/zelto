// 拉闸（halt）的判定测试
//
// 拉闸是「高速」的刹车。判定只有一件事：这份暂停请求该不该让这个批次停下。
// 停与不停都是确定性的 —— 只读文件、比对作用域，没有模型参与（C3）。
//
// C1: 状态只在文件里 —— 暂停请求是 `.zelto/halts/<scope>.json`

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HaltStore } from '../../../src/core/halt/index.js';

describe('HaltStore — 文件化的拉闸请求（C1: 状态只在文件里）', () => {
  let dir: string;
  let store: HaltStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-halt-'));
    store = new HaltStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('拉闸后请求落在磁盘上', async () => {
    const req = await store.request('batch', 'human', '跑偏了');
    assert.equal(req.scope, 'batch');
    assert.equal(req.reason, '跑偏了');
    assert.equal(req.requestedBy, 'human');

    const file = join(dir, 'halts', 'batch.json');
    assert.ok(existsSync(file), '暂停请求应当落盘');
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    assert.equal(onDisk.reason, '跑偏了');
  });

  it('没有请求时 get 返回 null', async () => {
    assert.equal(await store.get('batch'), null);
  });

  it('同一作用域重复拉闸覆盖旧请求（幂等）', async () => {
    await store.request('batch', 'human', '第一次');
    const second = await store.request('batch', 'human', '第二次');
    assert.equal(second.reason, '第二次');

    const list = await store.list();
    assert.equal(list.length, 1, '同一作用域只留一份请求');
    assert.equal(list[0].reason, '第二次');
  });

  it('全局拉闸（scope=all）对所有批次生效', async () => {
    await store.request('all', 'human', '全部停');
    const req = await store.isHalted('batch');
    assert.ok(req, '批次作用域应被全局拉闸命中');
    assert.equal(req?.scope, 'all');
  });

  it('批次作用域只对自己生效', async () => {
    await store.request('batch', 'human', '只停这个批次');
    assert.ok(await store.isHalted('batch'));
    assert.equal(await store.isHalted('version-v1'), null);
  });

  it('全局拉闸优先于批次拉闸', async () => {
    await store.request('batch', 'human', '批次级');
    await store.request('all', 'human', '全局级');
    const req = await store.isHalted('batch');
    assert.equal(req?.scope, 'all');
  });

  it('解除后不再拉闸', async () => {
    await store.request('batch', 'human', '停');
    assert.ok(await store.isHalted('batch'));

    assert.equal(await store.clear('batch'), true);
    assert.equal(await store.isHalted('batch'), null);
  });

  it('解除不存在的请求返回 false', async () => {
    assert.equal(await store.clear('batch'), false);
  });

  it('clearAll 解除全部作用域的请求', async () => {
    await store.request('all', 'human', '全停');
    await store.request('batch', 'human', '批次停');
    await store.request('version-v1', 'human', '版本停');

    const removed = await store.clearAll();
    assert.equal(removed.length, 3);
    assert.equal(await store.list().then((l) => l.length), 0);
    assert.equal(await store.isHalted('batch'), null);
  });

  it('作用域里的非法字符被替换，路径不会逃出目录', async () => {
    await store.request('../escape', 'human', 'x');
    const file = join(dir, 'halts', '.._escape.json');
    assert.ok(existsSync(file), '路径应被净化');
    assert.ok(!existsSync(join(dir, '..', 'escape.json')));
  });

  it('list 按请求时间排序', async () => {
    await store.request('batch', 'human', '一');
    await new Promise((r) => setTimeout(r, 5));
    await store.request('version-v1', 'human', '二');
    const list = await store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].scope, 'batch');
    assert.equal(list[1].scope, 'version-v1');
  });

  it('坏文件不炸 —— list 跳过它', async () => {
    await store.request('batch', 'human', '好的');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'halts', 'broken.json'), '{ not json', 'utf-8');
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].scope, 'batch');
  });
});

describe('HaltStore — 暂停请求有 TTL（ZD-023 补）', () => {
  let dir: string;
  let store: HaltStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-halt-ttl-'));
    store = new HaltStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('新写的请求带 expiresAt（默认 30 分钟）', async () => {
    const req = await store.request('all', 'human', '停');
    assert.ok(req.expiresAt, '新写的请求应当带 expiresAt');
    const ttl = Date.parse(req.expiresAt as string) - Date.parse(req.requestedAt);
    // 允许 1 秒的写入耗时误差。
    //
    // **上下界都要给容差**：实现是 `Date.now() + ttl`（expiresAt 的基准点），
    // 而 `requestedAt` 是**更早**取的 `new Date().toISOString()`。
    // 两个取时间点差 1ms，ttl 就变成 `30*60*1000 + 1` ——
    // 上界卡死的话，这条用例会**偶发**红（实测 1800001ms）。
    assert.ok(
      ttl > 29 * 60 * 1000 && ttl <= 30 * 60 * 1000 + 1000,
      `TTL 应当是 30 分钟（实际 ${ttl}ms）`,
    );
  });

  it('显式永不过期时 expiresAt 为 null', async () => {
    const req = await store.request('all', 'human', '永久停', 0);
    assert.equal(req.expiresAt, null);
  });

  it('显式指定 TTL 时按指定的算', async () => {
    const req = await store.request('all', 'human', '短停', 5 * 60 * 1000);
    const ttl = Date.parse(req.expiresAt as string) - Date.parse(req.requestedAt);
    // 同上：上界也要给 1 秒容差（两个取时间点可能差 1ms）。
    assert.ok(
      ttl > 4 * 60 * 1000 && ttl <= 5 * 60 * 1000 + 1000,
      `TTL 应当是 5 分钟（实际 ${ttl}ms）`,
    );
  });

  it('isExpired：没过期 → false，过期 → true', async () => {
    const req = await store.request('all', 'human', '停');
    assert.equal(store.isExpired(req), false, '刚写的请求不该算过期');

    const future = Date.now() + 31 * 60 * 1000;
    assert.equal(store.isExpired(req, future), true, '31 分钟后应当算过期');
  });

  it('永不过期的请求永远不算过期', async () => {
    const req = await store.request('all', 'human', '永久停', 0);
    assert.equal(store.isExpired(req, Date.now() + 365 * 24 * 60 * 60 * 1000), false);
  });

  it('isHalted 不看过期 —— 人喊停就是喊停（在跑的活该停还得停）', async () => {
    const req = await store.request('all', 'human', '停');
    const later = Date.now() + 31 * 60 * 1000;
    const got = await store.isHalted('batch');
    assert.ok(got, 'isHalted 应当仍能读到请求');

    // 用显式的 now 验证过期不影响 isHalted —— isHalted 不带 now 参数，
    // 所以这里直接验 isExpired 与 isBlockingNewWork 的分工。
    assert.equal(store.isExpired(req, later), true);
    assert.ok(got, 'isHalted 不过期 —— 请求仍在');
  });

  it('isBlockingNewWork：过期 → null（放行新工作）', async () => {
    await store.request('all', 'human', '停');
    const later = Date.now() + 31 * 60 * 1000;
    assert.equal(await store.isBlockingNewWork('batch', later), null, '过期后不该再拦新工作');
  });

  it('isBlockingNewWork：没过期 → 返回请求（拦住新工作）', async () => {
    const req = await store.request('all', 'human', '停');
    const got = await store.isBlockingNewWork('batch');
    assert.ok(got, '没过期时应当拦住新工作');
    assert.equal(got?.id, req.id);
  });

  it('旧格式请求（没有 expiresAt 字段）按 requestedAt 回填 TTL', async () => {
    // 模拟 TTL 上线前写的请求文件
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'halts'), { recursive: true });
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeFileSync(
      join(dir, 'halts', 'all.json'),
      JSON.stringify({
        id: 'halt-legacy',
        scope: 'all',
        requestedBy: 'human',
        reason: '旧的暂停请求',
        requestedAt: old,
      }),
      'utf-8',
    );

    const req = await store.get('all');
    assert.ok(req, '旧请求应当能读出来');
    assert.ok(req?.expiresAt, '旧请求应当被回填 expiresAt');
    assert.equal(store.isExpired(req as NonNullable<typeof req>), true, '31 分钟前的旧请求应当算过期');
  });

  it('旧格式请求：requestedAt 坏掉时按「从现在起算」处理', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'halts'), { recursive: true });
    writeFileSync(
      join(dir, 'halts', 'all.json'),
      JSON.stringify({
        id: 'halt-bad',
        scope: 'all',
        requestedBy: 'human',
        reason: '时间戳坏掉',
        requestedAt: 'not-a-date',
      }),
      'utf-8',
    );

    const req = await store.get('all');
    assert.ok(req?.expiresAt, '应当被回填');
    assert.equal(store.isExpired(req as NonNullable<typeof req>), false, '坏时间戳 → 当作没过期（fail closed）');
  });
});
