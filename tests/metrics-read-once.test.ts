// 「读一次、算三次」—— 度量报告的读放大幅度优化，不得改变任何结论
//
// 病灶（实测 nimrtc-zelto，2026-11-18）：
//
//   `generateReport` 里每片要算三个指标（rework_rate / cycle_time / stall_counts），
//   而每个指标自己 `events.read(id)` —— **同一片的事件被读了四遍**
//   （循环里一次 + 三个指标各一次）。
//
//   实测 130 片：328ms → 19ms（快 17 倍）。
//   这个端点是驾驶舱「度量」页的数据源，驾驶舱每 5 秒轮询一次 ——
//   慢在这里就是每 5 秒烧一次 CPU 和磁盘。
//
//   修法：读一次，三个指标复用同一份（`reworkRateFrom` / `cycleTimeFrom` /
//   `stallCountsFrom` 三个纯函数）。
//
// 这个文件钉住两件事：
//   1. **结论没变** —— 优化前后同一份事件流算出**同样的**指标值；
//   2. **确实只读一次** —— 读放大真的消失了（不是「看起来快了」）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MetricsCollector } from '../src/core/metrics/collector.js';
import { EventStream } from '../src/core/events/stream.js';

const TEST_DIR = join(tmpdir(), `zelto-metrics-read-once-${Date.now()}`);
const EVENTS_DIR = join(TEST_DIR, 'events');

describe('度量报告：读一次算三次', () => {
  let events: EventStream;
  let collector: MetricsCollector;

  before(async () => {
    await mkdir(EVENTS_DIR, { recursive: true });
    events = new EventStream(EVENTS_DIR);
    collector = new MetricsCollector(events);

    // 一片有代表性事件：门禁执行 + 重试 + 停机分类 + 签字
    await events.append('slice-a', 'gate.executed', 'zelto', { commandCount: 2 });
    await events.append('slice-a', 'gate.result', 'zelto', { passed: false });
    await events.append('slice-a', 'gate.executed', 'zelto', { commandCount: 2 });
    await events.append('slice-a', 'gate.retry', 'zelto', { attempt: 1 });
    await events.append('slice-a', 'stall.classified', 'zelto', { class: 'environment_failure' });
    await events.append('slice-a', 'sign.requested', 'zelto', {});
    await events.append('slice-a', 'sign.approved', 'human', {});

    // 第二片：没有门禁事件（rework_rate 应为 null）
    await events.append('slice-b', 'sign.requested', 'zelto', {});
    await events.append('slice-b', 'sign.approved', 'human', {});
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('结论没变：报告里的指标与单指标接口算出来的一致', async () => {
    // 这是**核心**断言 ——
    // 「优化」意味着两条路径必须给出**同一个答案**。
    // 如果它们分叉了，说明纯函数拆分时漏了某个字段或改了什么语义。
    const ids = ['slice-a', 'slice-b'];
    const report = await collector.generateReport(ids);

    for (const id of ids) {
      const fromReport = report.metrics.filter((m) => m.sliceId === id);
      const rework = await collector.reworkRate(id);
      const cycle = await collector.cycleTime(id);
      const stalls = await collector.stallCounts(id);

      // rework_rate：报告里有 ⟺ 单指标接口有，且**值相等**
      if (rework === null) {
        assert.equal(
          fromReport.filter((m) => m.name === 'rework_rate').length,
          0,
          `${id}: 单指标接口说 rework_rate 是 null，报告里就不该有它`,
        );
      } else {
        const inReport = fromReport.find((m) => m.name === 'rework_rate');
        assert.ok(inReport, `${id}: 报告里必须有 rework_rate`);
        assert.equal(inReport.value, rework.value, `${id}: rework_rate 的值不能变`);
        assert.deepEqual(inReport.dimensions, rework.dimensions);
      }

      // cycle_time：同上
      if (cycle === null) {
        assert.equal(
          fromReport.filter((m) => m.name === 'cycle_time').length,
          0,
          `${id}: 单指标接口说 cycle_time 是 null，报告里就不该有它`,
        );
      } else {
        const inReport = fromReport.find((m) => m.name === 'cycle_time');
        assert.ok(inReport, `${id}: 报告里必须有 cycle_time`);
        // cycle_time 是「首末事件的时间差」——
        // 两次调用之间事件流没变，值必须**完全相等**（不是「差不多」）
        assert.equal(inReport.value, cycle.value, `${id}: cycle_time 的值不能变`);
      }

      // stall_counts：永远有
      const inReport = fromReport.find((m) => m.name === 'stall_counts');
      assert.ok(inReport, `${id}: 报告里必须有 stall_counts`);
      assert.equal(inReport.value, stalls.value, `${id}: stall_counts 的值不能变`);
      assert.deepEqual(inReport.dimensions, stalls.dimensions);
    }
  });

  it('eventCount 与 sliceCount 不受读放大的影响', async () => {
    const report = await collector.generateReport(['slice-a', 'slice-b']);
    // slice-a 7 条 + slice-b 2 条
    assert.equal(report.eventCount, 9);
    assert.equal(report.sliceCount, 2);
  });

  it('确实只读了一次（读放大真的消失了）', async () => {
    // 用「读文件次数」作判据 —— 不是「跑得快」这种环境相关的说法。
    //
    // 做法：把事件流换成计数版 —— 每次 read 记一次数。
    // 优化前：每片读 4 次（循环 1 + 三个指标各 1）。
    // 优化后：每片读 1 次。
    let reads = 0;
    const countingEvents = {
      read: async (id: string) => {
        reads++;
        return events.read(id);
      },
    } as unknown as EventStream;

    const counting = new MetricsCollector(countingEvents);
    await counting.generateReport(['slice-a', 'slice-b']);

    assert.equal(
      reads,
      2,
      `两片的事件流应当各读一次，实际读了 ${reads} 次 —— 读放大没消除`,
    );
  });

  it('某片事件读不出来时不影响别的片（不因一片坏而全丢）', async () => {
    // 事件流里没有这一片 → read 返回空数组（不是抛）
    const report = await collector.generateReport(['slice-a', 'slice-nonexistent']);

    // slice-a 的指标照常产出
    assert.ok(
      report.metrics.some((m) => m.sliceId === 'slice-a' && m.name === 'stall_counts'),
      '别的片正常时，这一片的指标不能少',
    );
    // 不存在的片：stall_counts=0（它没有停机事件），rework/cycle 为 null
    const missing = report.metrics.filter((m) => m.sliceId === 'slice-nonexistent');
    const stalls = missing.find((m) => m.name === 'stall_counts');
    assert.ok(stalls, '不存在的片也要有 stall_counts（值为 0）');
    assert.equal(stalls.value, 0);
  });

  it('空切片列表 → 报告也是空的（不炸）', async () => {
    const report = await collector.generateReport([]);
    assert.equal(report.sliceCount, 0);
    assert.equal(report.eventCount, 0);
    assert.equal(report.metrics.length, 0);
  });
});
