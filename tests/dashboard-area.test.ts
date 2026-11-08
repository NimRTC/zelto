// 看板的「按代码区域聚合」—— 回答「哪个模块最烧钱」
//
// 为什么按区域而不仅是按切片：片是偶然的，模块是长期的。
// 「core/gate 这块累计花了 X」比「第 37 片花了 Y」更能指导下一步。
//
// 口径与 dashboard-cost.ts 保持同源：同一份 costMap，聚合方式不同但取数一致。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectCosts } from '../src/cli/commands/dashboard-cost.js';
import { aggregateByArea, type SliceData } from '../src/cli/commands/dashboard.js';

let workdir: string;
let cwd: string;

function writeEvents(sliceId: string, events: Array<Record<string, unknown>>): void {
  const dir = join(workdir, '.zelto', 'events', sliceId);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e, i) =>
    JSON.stringify({
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      runSeq: i + 1,
      slice: sliceId,
      run: null,
      type: e.type,
      actor: e.actor ?? 'zelto',
      payload: e.payload ?? {},
    }),
  );
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

function slice(id: string, area: string): SliceData {
  return {
    id,
    title: id,
    state: 'completed',
    stallClass: null,
    autoResolved: 0,
    writes: [],
    type: 'code',
    area,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    planId: 'p1',
    planTitle: 'p1',
    version: 'v1',
    module: '',
  };
}

beforeEach(() => {
  cwd = process.cwd();
  workdir = mkdtempSync(join(tmpdir(), 'zelto-dashboard-area-'));
  process.chdir(workdir);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(workdir, { recursive: true, force: true });
});

describe('按代码区域聚合', () => {
  it('同一区域的多片合到一起', () => {
    writeEvents('gate-a', [
      { type: 'budget.spent', payload: { amount: 0.3, source: 'agent', inputTokens: 1000, outputTokens: 100 } },
    ]);
    writeEvents('gate-b', [
      { type: 'budget.spent', payload: { amount: 0.2, source: 'agent', inputTokens: 500, outputTokens: 50 } },
    ]);

    const areas = aggregateByArea([slice('gate-a', 'core-gate'), slice('gate-b', 'core-gate')], collectCosts());
    assert.equal(areas.length, 1);
    assert.equal(areas[0].key, 'core-gate');
    assert.equal(areas[0].slices, 2);
    assert.equal(areas[0].measuredSlices, 2);
    assert.equal(areas[0].tokens, 1650);
    assert.ok(Math.abs(areas[0].cost - 0.5) < 1e-9);
  });

  it('按 token 从多到少排 —— 先看到最烧的模块', () => {
    writeEvents('cheap-slice', [
      { type: 'budget.spent', payload: { amount: 0.01, source: 'agent', inputTokens: 10, outputTokens: 1 } },
    ]);
    writeEvents('heavy-slice', [
      { type: 'budget.spent', payload: { amount: 0.9, source: 'agent', inputTokens: 9000, outputTokens: 900 } },
    ]);

    const areas = aggregateByArea(
      [slice('cheap-slice', 'core-policy'), slice('heavy-slice', 'core-gate')],
      collectCosts(),
    );
    assert.equal(areas.length, 2);
    assert.equal(areas[0].key, 'core-gate');
    assert.equal(areas[1].key, 'core-policy');
  });

  it('没测到用量的切片计入片数，但不计入花费', () => {
    writeEvents('measured', [
      { type: 'budget.spent', payload: { amount: 0.4, source: 'agent', inputTokens: 200, outputTokens: 20 } },
    ]);
    writeEvents('unmeasured', [{ type: 'run.started', payload: {} }]);

    const areas = aggregateByArea(
      [slice('measured', 'core-slice'), slice('unmeasured', 'core-slice')],
      collectCosts(),
    );
    assert.equal(areas.length, 1);
    assert.equal(areas[0].slices, 2);
    assert.equal(areas[0].measuredSlices, 1);
    assert.equal(areas[0].tokens, 220);
  });
});
