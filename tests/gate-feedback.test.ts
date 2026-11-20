// 上一轮门禁/验收的失败反馈（core/gate/feedback.ts，ZD-013）
//
// 实战病灶：
//
// agent 跑完 → 门禁②跑了 build/test 但**没跑验收**（没配 gate.acceptance）
// → 切片进 completed → 验收里的两个真 bug 一路溜到签字桌前。
//
// 人发现后让 agent 重跑修 —— 但 agent 拿不到「上次为什么失败」：
// 约束包里只有规格、写集、门禁命令。它可能把已经做对的东西改错。
//
// 这个模块解决的就是「把上一次的失败证据交给下一轮 agent」。
//
// C3: 纯读取 + 纯文本加工

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readGateFeedback, renderGateFeedback } from '../src/core/gate/feedback.js';
import { EventStream } from '../src/core/events/stream.js';

/** 造一个事件流目录，并写入若干事件 */
function makeEvents(events: Array<{ type: string; payload?: Record<string, unknown> }>): EventStream {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-feedback-'));
  mkdirSync(join(dir, 's1'), { recursive: true });
  const lines = events.map((e, i) =>
    JSON.stringify({
      id: `evt-${i}`,
      type: e.type,
      at: new Date().toISOString(),
      actor: 'zelto',
      payload: e.payload ?? {},
    }),
  );
  appendFileSync(join(dir, 's1', 'events.jsonl'), lines.join('\n') + '\n', 'utf-8');
  return new EventStream(dir);
}

describe('readGateFeedback', () => {
  it('验收失败 → 给出验收阶段的反馈，带失败原因', async () => {
    const events = makeEvents([
      {
        type: 'gate.result',
        payload: {
          sliceId: 's1',
          passed: false,
          results: [{ command: 'build', passed: true, stdout: '', stderr: null }],
          acceptance: {
            status: 'failed',
            reason: '【断言不成立】TURN 分配失败：错误码 400',
            path: 'tests/acceptance/s1/acceptance.test.cjs',
          },
        },
      },
    ]);
    const feedback = await readGateFeedback(events, 's1');
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].stage, 'acceptance');
    assert.ok(feedback[0].reason.includes('400'));
  });

  it('门禁命令失败 → 给出 gate 阶段的反馈，命令名是失败的那条', async () => {
    const events = makeEvents([
      {
        type: 'gate.result',
        payload: {
          sliceId: 's1',
          passed: false,
          results: [
            { command: 'build', passed: true, stdout: 'ok', stderr: null },
            { command: 'test', passed: false, stdout: '', stderr: '3 tests failed' },
          ],
          acceptance: { status: 'passed', path: 'x' },
        },
      },
    ]);
    const feedback = await readGateFeedback(events, 's1');
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].stage, 'gate');
    assert.equal(feedback[0].command, 'test');
    assert.ok(feedback[0].reason.includes('3 tests failed'));
  });

  it('门禁全过 → 没有反馈', async () => {
    const events = makeEvents([
      {
        type: 'gate.result',
        payload: {
          sliceId: 's1',
          passed: true,
          results: [{ command: 'build', passed: true, stdout: '', stderr: null }],
          acceptance: { status: 'passed', path: 'x' },
        },
      },
    ]);
    assert.deepEqual(await readGateFeedback(events, 's1'), []);
  });

  it('验收被跳过（没配 acceptance）→ 不算失败，不给反馈', async () => {
    // 实战里最关键的一条：验收**没跑**与验收**跑了但没过**是两回事。
    // 前者不是「通过了」，但也不能编造一个失败出来。
    const events = makeEvents([
      {
        type: 'gate.result',
        payload: {
          sliceId: 's1',
          passed: true,
          results: [{ command: 'build', passed: true, stdout: '', stderr: null }],
          acceptance: { status: 'skipped', reason: '未配置切片级验收' },
        },
      },
    ]);
    assert.deepEqual(await readGateFeedback(events, 's1'), []);
  });

  it('只带最近一次门禁的失败 —— 更早的失败已经被修好了', async () => {
    const events = makeEvents([
      {
        type: 'gate.result',
        payload: {
          sliceId: 's1',
          passed: false,
          results: [{ command: 'build', passed: false, stdout: '', stderr: '第一次失败' }],
          acceptance: { status: 'passed', path: 'x' },
        },
      },
      {
        type: 'gate.result',
        payload: {
          sliceId: 's1',
          passed: false,
          results: [{ command: 'build', passed: false, stdout: '', stderr: '第二次失败' }],
          acceptance: { status: 'passed', path: 'x' },
        },
      },
    ]);
    const feedback = await readGateFeedback(events, 's1');
    assert.equal(feedback.length, 1);
    assert.ok(feedback[0].reason.includes('第二次失败'));
    assert.ok(!feedback[0].reason.includes('第一次失败'), '更早的失败不该带过去');
  });

  it('没有任何门禁事件 → 没有反馈（不编造）', async () => {
    const events = makeEvents([{ type: 'run.started', payload: { sliceId: 's1' } }]);
    assert.deepEqual(await readGateFeedback(events, 's1'), []);
  });
});

describe('renderGateFeedback', () => {
  it('没有反馈 → 没有行', () => {
    assert.deepEqual(renderGateFeedback([]), []);
  });

  it('渲染成给 agent 看的段落，带标题与原文', () => {
    const lines = renderGateFeedback([
      {
        stage: 'acceptance',
        command: 'acceptance',
        reason: 'TURN 分配失败：错误码 400',
        output: 'TAP version 13\nnot ok 1 - TURN',
      },
    ]);
    const text = lines.join('\n');
    assert.ok(text.includes('Previous attempt failed'));
    assert.ok(text.includes('TURN 分配失败：错误码 400'), '失败原因要原文出现');
    assert.ok(text.includes('not ok 1 - TURN'), '完整输出要原文出现');
    assert.ok(text.includes('verbatim'), '要说明这是原文');
  });

  it('门禁阶段的反馈标题与验收阶段不同', () => {
    const gate = renderGateFeedback([{ stage: 'gate', command: 'build', reason: 'x' }]).join('\n');
    const acc = renderGateFeedback([
      { stage: 'acceptance', command: 'acceptance', reason: 'x' },
    ]).join('\n');
    assert.ok(gate.includes('Gate command'));
    assert.ok(acc.includes('Acceptance test'));
  });
});
