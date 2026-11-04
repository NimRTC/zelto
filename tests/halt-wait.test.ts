// 拉闸在等待 agent 时生效的判定测试
//
// 「边等边听」是拉闸的核心：批次跑起来之后，人是在看到某个 agent 跑偏的
// 那一刻才想喊停。等到 agent 自己结束再停，就没有「拉闸」可言了。
//
// C3: 只读文件、比对作用域 —— 停不停是确定的，没有模型参与。

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HaltStore } from '../src/core/halt/index.js';
import { waitForExitOrHalt } from '../src/cli/commands/parallel-executor.js';

/** 假 adapter：waitForExit 一直挂着，直到被 stop 或超时 */
function fakeAdapter(opts: { exitAfterMs?: number } = {}) {
  const stopped: string[] = [];
  let release: (code: number | null) => void = () => {};

  const exitPromise = new Promise<number | null>((resolve) => {
    release = resolve;
    if (opts.exitAfterMs !== undefined) {
      setTimeout(() => resolve(0), opts.exitAfterMs);
    }
  });

  return {
    stopped,
    adapter: {
      waitForExit: () => exitPromise,
      stop: async (id: string) => {
        stopped.push(id);
        release(null);
      },
    },
    release,
  };
}

describe('waitForExitOrHalt — 等待 agent 时也能被叫停', () => {
  let dir: string;
  let store: HaltStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-halt-wait-'));
    store = new HaltStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('没人拉闸时，等 agent 正常退出', async () => {
    const { adapter } = fakeAdapter({ exitAfterMs: 50 });
    const result = await waitForExitOrHalt(adapter, 'sess-1', store, 'batch');
    assert.equal(result.halted, false);
    assert.equal(result.exitCode, 0);
  });

  it('拉闸后 agent 被停掉，等候方拿到 halted', async () => {
    const { adapter, stopped } = fakeAdapter();
    // 先拉闸，再开始等 —— watcher 一轮询就会看到
    await store.request('batch', 'human', '跑偏了');

    const result = await waitForExitOrHalt(adapter, 'sess-2', store, 'batch');
    assert.equal(result.halted, true);
    assert.equal(result.reason, '跑偏了');
    assert.deepEqual(stopped, ['sess-2'], '被拉闸的 agent 应该被停掉');
  });

  it('批次作用域的拉闸不影响别的批次', async () => {
    const { adapter, stopped } = fakeAdapter({ exitAfterMs: 50 });
    await store.request('other-batch', 'human', '别的批次');

    const result = await waitForExitOrHalt(adapter, 'sess-3', store, 'batch');
    assert.equal(result.halted, false);
    assert.deepEqual(stopped, []);
  });

  it('全局拉闸对任何批次生效', async () => {
    const { adapter } = fakeAdapter();
    await store.request('all', 'human', '全部停');

    const result = await waitForExitOrHalt(adapter, 'sess-4', store, 'batch');
    assert.equal(result.halted, true);
    assert.equal(result.reason, '全部停');
  });
});
