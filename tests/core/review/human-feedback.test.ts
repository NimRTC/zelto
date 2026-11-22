// 单元测试：人的意见读事件流 + 渲染（ADR-094 §5.2）
//
// 验的是 core 里的判定逻辑：
//   读哪些意见、怎么分类、渲染成什么样。
//
// 验不到的：命令接上去之后的行为（参数解析、退出码、状态转移）——
// 那是验收测试（tests/acceptance/sign-revise-command/）的事。

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStream, type EventEnvelope } from '../../../src/core/events/stream.js';
import {
  readHumanFeedback,
  renderHumanFeedback,
} from '../../../src/core/review/human-feedback.js';

const TEST_DIR = join(tmpdir(), `zelto-human-fb-${Date.now()}`);

/**
 * 每个用例一个**独有的切片 id**。
 *
 * 为什么不能都用 's1'：事件流按切片分目录（`.zelto/events/<id>/events.jsonl`），
 * 用同一个 id 会让前一个用例的事件**留在原地**被后一个用例读到 ——
 * 于是「没有意见」那个用例会读到上一个用例的意见。
 *
 * 这不是「测试写得不小心」，是事件流**追加语义**的真实体现：
 * 同一个切片的事件只增不减。单元测试要隔离，就得起不同的切片 id。
 */
let sliceCounter = 0;
function nextSliceId(): string {
  sliceCounter += 1;
  return `s${sliceCounter}`;
}

async function withStream(
  fn: (events: EventStream) => Promise<void>,
): Promise<void> {
  const events = new EventStream(join(TEST_DIR, 'events'));
  await fn(events);
}

describe('readHumanFeedback', () => {
  it('returns empty when there is no feedback event', async () => {
    await withStream(async (events) => {
      const id = nextSliceId();
      await events.append(id, 'run.started', 'zelto', {});
      await events.append(id, 'gate.result', 'zelto', { passed: true });
      assert.deepEqual(await readHumanFeedback(events, id), []);
    });
  });

  it('reads the comment of a sign.revised event', async () => {
    await withStream(async (events) => {
      const id = nextSliceId();
      await events.append(id, 'sign.revised', 'human', {
        signId: 'sign-s1-1',
        sliceId: id,
        comment: '3 号那个 parseInput 的 null 处理不对',
      });
      const feedback = await readHumanFeedback(events, id);
      assert.equal(feedback.length, 1);
      assert.equal(feedback[0].kind, 'revise');
      assert.equal(feedback[0].comment, '3 号那个 parseInput 的 null 处理不对');
      assert.equal(feedback[0].decidedBy, 'human');
      assert.equal(feedback[0].signId, 'sign-s1-1');
    });
  });

  it('reads the comment of a sign.returned event', async () => {
    await withStream(async (events) => {
      const id = nextSliceId();
      await events.append(id, 'sign.returned', 'human', {
        signId: 'sign-s1-2',
        comment: '方向不对：这块应该走事件总线而不是轮询',
      });
      const feedback = await readHumanFeedback(events, id);
      assert.equal(feedback.length, 1);
      assert.equal(feedback[0].kind, 'return');
    });
  });

  it('takes only the LATEST feedback — earlier ones are stale', async () => {
    await withStream(async (events) => {
      const id = nextSliceId();
      await events.append(id, 'sign.revised', 'human', { comment: '第一条意见' });
      await events.append(id, 'sign.revised', 'human', { comment: '第二条意见' });
      await events.append(id, 'sign.revised', 'human', { comment: '第三条意见' });

      const feedback = await readHumanFeedback(events, id);
      assert.equal(feedback.length, 1);
      assert.equal(feedback[0].comment, '第三条意见');
    });
  });

  it('takes the latest across both kinds — a return after a revise wins', async () => {
    await withStream(async (events) => {
      const id = nextSliceId();
      await events.append(id, 'sign.revised', 'human', { comment: '细节要改' });
      await events.append(id, 'sign.returned', 'human', { comment: '方向也要改' });

      const feedback = await readHumanFeedback(events, id);
      assert.equal(feedback.length, 1);
      assert.equal(feedback[0].kind, 'return');
      assert.equal(feedback[0].comment, '方向也要改');
    });
  });

  it('ignores sign.rejected — rejection is terminal, not rework', async () => {
    await withStream(async (events) => {
      const id = nextSliceId();
      await events.append(id, 'sign.rejected', 'human', { comment: '这版不要了' });
      assert.deepEqual(await readHumanFeedback(events, id), []);
    });
  });

  it('ignores sign.revoked — revocation keeps the slice completed', async () => {
    await withStream(async (events) => {
      const id = nextSliceId();
      await events.append(id, 'sign.revoked', 'human', { comment: '签错了' });
      assert.deepEqual(await readHumanFeedback(events, id), []);
    });
  });

  it('skips an empty comment — empty feedback is noise', async () => {
    await withStream(async (events) => {
      const id = nextSliceId();
      await events.append(id, 'sign.revised', 'human', { comment: '   ' });
      await events.append(id, 'sign.revised', 'human', {});
      assert.deepEqual(await readHumanFeedback(events, id), []);
    });
  });

  it('falls back to an earlier non-empty feedback when the latest is empty', async () => {
    await withStream(async (events) => {
      const id = nextSliceId();
      await events.append(id, 'sign.revised', 'human', { comment: '真意见' });
      await events.append(id, 'sign.revised', 'human', { comment: '' });
      const feedback = await readHumanFeedback(events, id);
      assert.equal(feedback.length, 1);
      assert.equal(feedback[0].comment, '真意见');
    });
  });

  it('reads feedback of one slice without leaking another slice feedback', async () => {
    await withStream(async (events) => {
      const id1 = nextSliceId();
      const id2 = nextSliceId();
      await events.append(id1, 'sign.revised', 'human', { comment: '第一片的意见' });
      await events.append(id2, 'sign.revised', 'human', { comment: '第二片的意见' });

      const f1 = await readHumanFeedback(events, id1);
      assert.equal(f1.length, 1);
      assert.equal(f1[0].comment, '第一片的意见');
    });
  });
});

describe('renderHumanFeedback', () => {
  it('renders nothing for empty feedback', () => {
    assert.deepEqual(renderHumanFeedback([]), []);
  });

  it('keeps the comment VERBATIM — no paraphrasing', () => {
    const comment = 'parseInput 的 null 处理不对，注意边界';
    const lines = renderHumanFeedback([
      {
        kind: 'revise',
        comment,
        decidedBy: 'human',
        at: '2026-11-22T00:00:00.000Z',
        signId: 'sign-s1-1',
      },
    ]);
    const text = lines.join('\n');
    assert.ok(text.includes(comment), 'comment must appear verbatim');
    assert.ok(text.includes('do not guess'), 'must tell the agent not to guess');
    assert.ok(text.includes('sign.revised'), 'must say which kind of feedback it is');
  });

  it('labels the return kind distinctly', () => {
    const lines = renderHumanFeedback([
      {
        kind: 'return',
        comment: '方向不对',
        decidedBy: 'human',
        at: '2026-11-22T00:00:00.000Z',
        signId: null,
      },
    ]);
    const text = lines.join('\n');
    assert.ok(text.includes('sign.returned'));
    assert.ok(!text.includes('sign.revised'));
  });
});

// 清理临时目录
process.on('exit', () => {
  void rm(TEST_DIR, { recursive: true, force: true });
});
