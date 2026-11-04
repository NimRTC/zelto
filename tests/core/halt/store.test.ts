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
