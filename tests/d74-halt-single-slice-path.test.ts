// D-74：拉闸必须在**每一条**等待路径上都生效
//
// 病灶（实测 nimrtc-v14 v1-n5-turn-server，2026-11-20）：
//   人跑 `zelto halt --reason "人工介入"`，命令回了「已拉闸」——
//   但 agent 照跑不误。人以为喊停了，其实没喊停。
//
// 根因：**只有一条路径听了拉闸**。
//   - `run --parallel`（parallel-executor）调了 `haltStore.isHalted()` ✅
//   - `zelto run <id>` 前台单片路径 —— 压根没读过 `.zelto/halts/` ❌
//   - detach 监督进程路径（supervisor）—— 只重试、不听拉闸 ❌
//     （更糟：人杀掉 agent，监督进程**换个会话重启它**，一轮接一轮永不停止）
//
// 「每条路径都接上了」不等于「每条路径都测过了」——
// 这跟 D-55/D-56 是同一个形态：每层各有一个倒计时，只改一层等于没改。
//
// 这一组用例守的是：
//   1. 前台单片路径：拉闸后 agent 被停掉，等待方拿到 halted；
//   2. 前台单片路径：没人拉闸时，等 agent 正常退出（不能被拉闸逻辑误伤）；
//   3. 批次作用域的拉闸不影响别的切片；
//   4. 全局拉闸（scope=all）对单片路径同样生效；
//   5. **源码层面**：supervisor 的重试回路必须先问一次拉闸
//      （grep 级别的守护 —— 那条路径靠人工演练验代价太大）。
//
// C3: 只读文件、比对作用域 —— 停不停是确定的，没有模型参与。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HaltStore } from '../src/core/halt/index.js';
import { waitForExitWithWatchdog } from '../src/cli/commands/core-slice.js';

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
      markProgress: () => {},
    },
    release,
  };
}

describe('D-74：拉闸在单片前台路径上也生效', () => {
  let dir: string;
  let store: HaltStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-d74-halt-'));
    store = new HaltStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('拉闸后 agent 被停掉，等待方拿到 halted 与原因', async () => {
    const { adapter, stopped } = fakeAdapter();
    // 先拉闸，再开始等 —— watcher 一轮询就会看到
    await store.request('sess-slice-1', 'human', '跑偏了');

    const result = await waitForExitWithWatchdog({
      sliceId: 'sess-slice-1',
      sessionId: 'agent-session-1',
      adapter: adapter as never,
      runStartedAt: new Date().toISOString(),
      maxRetries: 2,
      haltStore: store,
    });

    assert.equal(result.halted, true, '单片前台路径必须听拉闸');
    assert.equal(result.haltReason, '跑偏了');
    assert.deepEqual(stopped, ['agent-session-1'], '被拉闸的 agent 应该被停掉');
  });

  it('没人拉闸时，等 agent 正常退出（不被拉闸逻辑误伤）', async () => {
    const { adapter, release } = fakeAdapter();

    const waiting = waitForExitWithWatchdog({
      sliceId: 'sess-slice-2',
      sessionId: 'agent-session-2',
      adapter: adapter as never,
      runStartedAt: new Date().toISOString(),
      maxRetries: 2,
      haltStore: store,
    });

    // agent 正常退出（退出码 0）
    setTimeout(() => release(0), 50);

    const result = await waiting;
    assert.equal(result.halted, undefined, '没人拉闸就不该报 halted');
    assert.equal(result.exitCode, 0, 'agent 正常退出时退出码要如实带出来');
  });

  it('批次作用域的拉闸不影响别的切片', async () => {
    const { adapter, stopped } = fakeAdapter({ exitAfterMs: 50 });
    await store.request('other-slice', 'human', '别的切片');

    const result = await waitForExitWithWatchdog({
      sliceId: 'sess-slice-3',
      sessionId: 'agent-session-3',
      adapter: adapter as never,
      runStartedAt: new Date().toISOString(),
      maxRetries: 2,
      haltStore: store,
    });

    assert.equal(result.halted, undefined);
    assert.deepEqual(stopped, [], '别的切片的拉闸不该停掉本切片');
  });

  it('全局拉闸（scope=all）对单片路径同样生效', async () => {
    const { adapter, stopped } = fakeAdapter();
    await store.request('all', 'human', '全部停');

    const result = await waitForExitWithWatchdog({
      sliceId: 'sess-slice-4',
      sessionId: 'agent-session-4',
      adapter: adapter as never,
      runStartedAt: new Date().toISOString(),
      maxRetries: 2,
      haltStore: store,
    });

    assert.equal(result.halted, true, '全局拉闸必须对单片路径生效');
    assert.equal(result.haltReason, '全部停');
    assert.deepEqual(stopped, ['agent-session-4']);
  });

  it('源码层面：detach 监督进程的重试回路必须先问一次拉闸', () => {
    // 这条路径靠人工演练验代价太大（要真起一个 agent 进程），
    // 所以用源码守护钉住「重试前必须查拉闸」这个结构。
    const src = readFileSync(
      join(process.cwd(), 'src', 'cli', 'commands', 'supervisor.ts'),
      'utf-8',
    );
    assert.match(src, /isHalted/, '监督进程必须读拉闸请求');
    // 拉闸检查必须在重试判断之前
    const haltIdx = src.indexOf('isHalted');
    const retryIdx = src.indexOf('isAutoResolvable');
    assert.ok(haltIdx > 0, '监督进程里必须有拉闸检查');
    assert.ok(
      haltIdx < retryIdx,
      '拉闸检查必须在重试判断之前 —— 否则人喊停后还会重启 agent',
    );
  });
});
