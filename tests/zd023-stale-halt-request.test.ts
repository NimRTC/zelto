/**
 * ZD-023：陈旧的全局暂停请求不得毒化后续切片。
 *
 * 回归来源：nimrtc-v14 v1-device-policy（2026-11-21）。
 * 一个全局暂停请求（`.zelto/halts/all.json`）在 agent 起跑前 3 分钟写好，
 * 但 `zelto run` 的准入完全不看它 —— agent 一路跑 2h45m，
 * 看门狗读到那个请求才把 agent 停掉，这一轮被记成「人工拉闸」
 * （actor=human），而人根本没干预过。
 *
 * 后果：
 *   - 一轮两小时四十分钟的活被一个陈旧请求打断；
 *   - 事件流里凭空多一次「人为干预」，追溯链被污染；
 *   - 那个 all.json 不会被自动清除 —— 一次误操作污染后面**所有**切片。
 *
 * 修法：`zelto run` 的准入检查暂停状态，有暂停请求就**拒绝起跑**，
 * 并说清怎么解除（`zelto halt --clear`）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../src/cli/commands/index.js';
import { commands } from '../src/cli/commands/shared.js';
import { HaltStore } from '../src/core/halt/index.js';

describe('ZD-023：陈旧的暂停请求不得毒化后续切片', () => {
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-zd023-halt-'));
    process.chdir(dir);
    mkdirSync(join(dir, '.zelto', 'slices'), { recursive: true });
    mkdirSync(join(dir, '.zelto', 'events'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  /** 建一个最小的可跑切片（frozen）。 */
  async function makeSlice(id: string): Promise<void> {
    await commands['create']([id, '--title', `Slice ${id}`, '--writes', 'src/**']);
    // 冻结准入要求需求追溯（ADR-032）—— 没有它 freeze 会被拦下，
    // 于是后面 run 在状态检查处就返回了，**根本走不到暂停检查**。
    await commands['set']([id, '--field', 'trace.requirements', '--value', 'ZD-023']);
    await commands['freeze']([id]);
    const raw = await import('node:fs').then((fs) =>
      fs.readFileSync(join(dir, '.zelto', 'slices', `${id}.json`), 'utf-8'),
    );
    const parsed = JSON.parse(raw) as { state: string };
    assert.equal(parsed.state, 'frozen', `测试前置：切片应当是 frozen（实际 ${parsed.state}）`);
  }

  it('全局暂停请求存在时，zelto run 拒绝起跑', async () => {
    await makeSlice('zd023-a');
    // 模拟「人早先踩下刹车，没松」—— 暂停请求先于 agent 起跑写好。
    const halts = new HaltStore(join(dir, '.zelto'));
    await halts.request('all', 'human', '人工拉闸');

    const code = await commands['run'](['zd023-a']);
    assert.equal(code, 1, '有全局暂停请求时应当拒绝起跑');
  });

  it('拒绝时不推 running 状态（切片仍可再跑）', async () => {
    await makeSlice('zd023-b');
    const halts = new HaltStore(join(dir, '.zelto'));
    await halts.request('all', 'human', '人工拉闸');

    await commands['run'](['zd023-b']);

    const raw = await import('node:fs').then((fs) =>
      fs.readFileSync(join(dir, '.zelto', 'slices', 'zd023-b.json'), 'utf-8'),
    );
    const parsed = JSON.parse(raw) as { state: string };
    assert.notEqual(
      parsed.state,
      'running',
      `拒绝起跑时不该把切片推到 running（实际 ${parsed.state}）—— ` +
      `否则切片卡在 running 且没人能救`,
    );
  });

  it('解除暂停后，zelto run 恢复可跑', async () => {
    await makeSlice('zd023-c');
    const halts = new HaltStore(join(dir, '.zelto'));
    await halts.request('all', 'human', '人工拉闸');
    await halts.clear('all');

    assert.equal(existsSync(join(dir, '.zelto', 'halts', 'all.json')), false);
    // 解除后 run 不该再被这条暂停请求挡住（agent 起没起来是另一回事，
    // 这里只断言「不再因为暂停被拒」—— 干跑模式足够验这一点）。
    const code = await commands['run'](['zd023-c', '--dry-run']);
    assert.equal(code, 0, '解除暂停后不该再被暂停请求拦住');
  });

  it('切片作用域的暂停请求同样拦得住（不只是 all）', async () => {
    await makeSlice('zd023-d');
    const halts = new HaltStore(join(dir, '.zelto'));
    await halts.request('zd023-d', 'human', '针对本片的暂停');

    const code = await commands['run'](['zd023-d']);
    assert.equal(code, 1, 'scope=切片id 的暂停请求同样应当拦得住');
  });
});
