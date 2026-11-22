// ZD-025 · 运行中看不到 agent 的进展（回归测试）
//
// 病灶（实测 nimrtc-v14 v3-n4-d6-connectivity，2026-11-22）：
//   Claude Code 用 `--output-format json` 跑 —— stdout **一次性**到达，
//   整轮 101 分钟里会话文件的 `output` 只有最后那个 JSON blob。
//   于是运行期间 `lastOutputLine()` 恒为 null，驾驶舱只能显示
//   「1 小时没输出」—— 而 agent 明明在改 15 个文件。
//
// 关键：**这不是「输出没落盘」的 bug**。
//   心跳本来就在落盘，落的就是那个含 output 的活对象 ——
//   落盘的确实是空的，因为 stdout 本来就是空的。
//   所以「让 output 落盘」这个修法是**无效**的（改完现象一模一样）。
//
// 真正的修法：进展**不只看 stdout**，也看**事件流** ——
// agent 的每次工具调用都被 hook 判过并写了 append-only 事件，
// 那是运行期间真实存在的进展证据。
//
// 本测试锁死：
//   1. `readEventProgress` 能从事件流里读出最近一次有意义的进展；
//   2. 「没有可判定的写入目标」这类噪声**不**被当成进展（不制造假信号）；
//   3. 事件流为空 / 读不到时返回 null（不编造进展）；
//   4. `lastOutputLine` 对空输出返回 null（原有的诚实行为，不能被改坏）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  lastOutputLine,
  readEventProgress,
  readSessionLiveness,
} from '../src/core/activity/liveness.js';

/** 往事件流里追加一条事件。 */
async function appendEvent(
  eventsDir: string,
  sliceId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const dir = join(eventsDir, sliceId);
  await mkdir(dir, { recursive: true });
  const { appendFile } = await import('node:fs/promises');
  await appendFile(
    join(dir, 'events.jsonl'),
    `${JSON.stringify(event)}\n`,
    'utf-8',
  );
}

describe('ZD-025 · 运行中看不到 agent 的进展', () => {
  let projectRoot: string;
  let eventsDir: string;

  beforeEach(async () => {
    projectRoot = join(
      tmpdir(),
      `zelto-zd025-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    eventsDir = join(projectRoot, '.zelto', 'events');
    await mkdir(join(projectRoot, '.zelto', 'sessions'), { recursive: true });
    await mkdir(eventsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('事件流里有工具调用 → 能读出进展', async () => {
    await appendEvent(eventsDir, 's1', {
      ts: '2026-11-22T01:00:00.000Z',
      type: 'policy.decision',
      payload: {
        decision: 'allow',
        tool: 'Write',
        reason: '写入在写集内',
      },
    });

    const progress = readEventProgress(eventsDir, 's1');
    assert.ok(progress, '应该读得出进展');
    assert.equal(progress.at, '2026-11-22T01:00:00.000Z');
    assert.match(progress.line, /判定 allow/);
    assert.match(progress.line, /Write/);
  });

  it('取**最后一条**有内容的事件（append-only 流里最后一条 = 最新）', async () => {
    await appendEvent(eventsDir, 's1', {
      ts: '2026-11-22T01:00:00.000Z',
      type: 'policy.decision',
      payload: { decision: 'allow', tool: 'Read', reason: '读文件' },
    });
    await appendEvent(eventsDir, 's1', {
      ts: '2026-11-22T01:05:00.000Z',
      type: 'policy.decision',
      payload: { decision: 'deny', tool: 'Bash', reason: '越界写入' },
    });

    const progress = readEventProgress(eventsDir, 's1');
    assert.ok(progress);
    assert.equal(progress.at, '2026-11-22T01:05:00.000Z');
    assert.match(progress.line, /判定 deny/);
  });

  it('「没有可判定的写入目标」是噪声 → 不算进展（不制造假信号）', async () => {
    // 这条在 Claude Code 跑 Bash 时**每几秒**就出现一次。
    // 若把它当进展，界面就会一直显示「刚动过」—— 那比「没输出」更糟，
    // 因为它让人以为 agent 在干活，而它可能已经卡住十分钟了。
    await appendEvent(eventsDir, 's1', {
      ts: '2026-11-22T01:00:00.000Z',
      type: 'policy.decision',
      payload: {
        decision: 'allow',
        tool: 'Bash',
        reason: '没有可判定的写入目标',
      },
    });

    assert.equal(
      readEventProgress(eventsDir, 's1'),
      null,
      '纯噪声不该被当成进展',
    );
  });

  it('噪声之后有真事件 → 取真事件', async () => {
    await appendEvent(eventsDir, 's1', {
      ts: '2026-11-22T01:00:00.000Z',
      type: 'policy.decision',
      payload: {
        decision: 'allow',
        tool: 'Bash',
        reason: '没有可判定的写入目标',
      },
    });
    await appendEvent(eventsDir, 's1', {
      ts: '2026-11-22T01:02:00.000Z',
      type: 'policy.decision',
      payload: { decision: 'allow', tool: 'Edit', reason: '改文件' },
    });

    const progress = readEventProgress(eventsDir, 's1');
    assert.ok(progress);
    assert.equal(progress.at, '2026-11-22T01:02:00.000Z');
    assert.match(progress.line, /Edit/);
  });

  it('事件流为空 / 不存在 → 返回 null（不编造进展）', async () => {
    assert.equal(readEventProgress(eventsDir, 's1'), null, '目录不存在');
    await appendEvent(eventsDir, 's1', {
      ts: '2026-11-22T01:00:00.000Z',
      type: 'policy.decision',
      payload: { decision: 'allow', tool: 'Bash', reason: '没有可判定的写入目标' },
    });
    assert.equal(readEventProgress(eventsDir, 's1'), null, '只有噪声');
  });

  it('since 过滤：只看某个时刻之后的事件', async () => {
    await appendEvent(eventsDir, 's1', {
      ts: '2026-11-22T01:00:00.000Z',
      type: 'policy.decision',
      payload: { decision: 'allow', tool: 'Read', reason: '读' },
    });
    await appendEvent(eventsDir, 's1', {
      ts: '2026-11-22T02:00:00.000Z',
      type: 'policy.decision',
      payload: { decision: 'allow', tool: 'Write', reason: '写' },
    });

    const progress = readEventProgress(eventsDir, 's1', '2026-11-22T01:30:00.000Z');
    assert.ok(progress);
    assert.equal(progress.at, '2026-11-22T02:00:00.000Z', '应只看到 after 之后的事件');
  });

  it('坏行不炸整个流', async () => {
    await appendEvent(eventsDir, 's1', {
      ts: '2026-11-22T01:00:00.000Z',
      type: 'policy.decision',
      payload: { decision: 'allow', tool: 'Read', reason: '读' },
    });
    const dir = join(eventsDir, 's1');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, 'events.jsonl'), '{ 这不是 JSON\n', 'utf-8');

    const progress = readEventProgress(eventsDir, 's1');
    assert.ok(progress, '坏行不该让好行也读不到');
  });

  it('lastOutputLine 对空输出返回 null（原有诚实行为不被改坏）', () => {
    assert.equal(lastOutputLine({ status: 'running', output: [] }), null);
    assert.equal(lastOutputLine({ status: 'running' }), null);
    assert.equal(lastOutputLine(null), null);
  });

  it('lastOutputLine 能从落盘的会话文件里读出真实输出', async () => {
    const sessionId = 'sess-read';
    await writeFile(
      join(projectRoot, '.zelto', 'sessions', `${sessionId}.json`),
      JSON.stringify({
        sessionId,
        sliceId: 's1',
        status: 'running',
        output: ['第一行\n', '正在跑 ctest\n', '\n'],
        lastActivityAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const rec = readSessionLiveness(projectRoot, sessionId);
    assert.ok(rec);
    assert.equal(lastOutputLine(rec), '正在跑 ctest');
  });
});
