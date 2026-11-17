// D-55：适配器的超时是**空转超时**，不是绝对超时
//
// 病灶（实测于 nimrtc-zelto v3-chrome-waterfall，2026-11-17）：
//   原本是「起跑 1800s 一刀切」。而那个 agent 在被砍的前 30 秒**还在改文件**
//   —— 它不是做不完，是「做得完但总时长超过上限」。于是一轮 30 分钟的工作
//   被砍掉、续跑、再砍、再续跑 —— 三轮 90 分钟、token 大把烧掉，
//   产物仍未过门禁。
//
//   绝对超时惩罚的是「做得久」，而超时真正该抓的是「卡住不动」。
//
// 这一组用例守的是：
//   1. 进展探针能看出「事件流变长了」= agent 又动了；
//   2. 没变 = 没动；
//   3. 探针只读文件大小（O(1)），不整份读事件流；
//   4. 适配器实现了 `markProgress`（可选能力，但 claude-agent 必须有）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SliceProgressProbe, sliceEventFile } from '../src/cli/commands/progress-probe.js';

describe('D-55 进展探针', () => {
  it('事件流变长了 = 有进展', () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-probe-'));
    try {
      const dir = join(root, '.zelto', 'events', 's1');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'events.jsonl');
      writeFileSync(file, '', 'utf-8');

      const probe = new SliceProgressProbe(root, 's1');
      assert.equal(probe.poll(), false, '刚建好还没有事件 → 没有进展');

      appendFileSync(file, '{"ts":"2026-11-17T00:00:00.000Z","type":"policy.decision"}\n', 'utf-8');
      assert.equal(probe.poll(), true, '事件流变长了 → 有进展');
      assert.equal(probe.poll(), false, '同一批内容不该反复算进展');
      assert.equal(probe.observedBatches, 1);

      appendFileSync(file, '{"ts":"2026-11-17T00:00:01.000Z","type":"policy.decision"}\n', 'utf-8');
      assert.equal(probe.poll(), true);
      assert.equal(probe.observedBatches, 2);
    } finally {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 残留不致命 */ }
    }
  });

  it('事件流文件还不存在时探针不炸', () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-probe2-'));
    try {
      const probe = new SliceProgressProbe(root, 'never-started');
      assert.equal(probe.poll(), false);
      assert.equal(probe.idleMs(), 0);
    } finally {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 残留不致命 */ }
    }
  });

  it('事件流路径落在 .zelto/events/<sliceId>/events.jsonl', () => {
    const p = sliceEventFile('D:/proj', 's1');
    assert.ok(p.includes('.zelto'));
    assert.ok(p.endsWith(join('s1', 'events.jsonl')));
  });
});

describe('D-55 适配器：markProgress 是可选能力但 claude-agent 必须有', () => {
  it('claude-agent 适配器实现了 markProgress', async () => {
    const { ClaudeAgentAdapter } = await import('../src/adapters/claude-agent/index.js');
    const adapter = new ClaudeAgentAdapter();
    assert.equal(typeof adapter.markProgress, 'function');
  });
});
