// 运行期提示的统一口径 —— 三条路径说同一件事时必须说同一句话
//
// 这些文案是人唯一的操作指引：人照着提示做下一步动作。
// 措辞漂移的代价不是"不好看"——人按 A 路径的提示去操作 B 路径的现场，
// 动作对不上。所以这里把每条提示必须包含什么锁死：
//
//   - 越界/审计失败：这一轮不算数、切片没废（退回 frozen）、下一步的具体命令
//   - 审计失败 ≠ 越界：两者的下一步完全不同，不能混着说
//   - 紧凑模式（批量输出）与完整模式（单片）说同一件事，只是排版不同

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  agentFailedMessage,
  auditFailedMessage,
  budgetExhaustedMessage,
  printOutcome,
  writeSetViolationMessage,
} from '../src/cli/commands/run-messages.js';

describe('写集越界的提示', () => {
  it('三件事一件都不能少：不算数、没废、下一步', () => {
    const lines = writeSetViolationMessage({ sliceId: 'slice-a' });
    const text = lines.join('\n');
    assert.ok(text.includes('写集越界'), '要说清是越界');
    assert.ok(text.includes('未进入 gate'), '要说清这一轮不算数');
    assert.ok(text.includes('退回 frozen'), '要说清切片没废');
    assert.ok(text.includes('zelto run slice-a'), '要给下一步的具体命令');
    assert.ok(text.includes('.zelto/events/slice-a/events.jsonl'), '要给事件流位置');
  });

  it('列出越界了哪些文件 —— 人要靠它决定扩写集还是重做规格', () => {
    const lines = writeSetViolationMessage(
      { sliceId: 'slice-a' },
      { violations: ['src/policy/bad.ts'], tampered: ['policy/policy.yaml'] },
    );
    const text = lines.join('\n');
    assert.ok(text.includes('src/policy/bad.ts（不在写集内）'));
    assert.ok(text.includes('policy/policy.yaml（zelto 托管的文件被改动了 —— 门禁可能已被绕过）'));
  });

  it('紧凑模式也是同一件事，只是排版紧凑', () => {
    const compact = writeSetViolationMessage({ sliceId: 'slice-a', compact: true });
    const full = writeSetViolationMessage({ sliceId: 'slice-a' });
    const ct = compact.join('\n');
    const ft = full.join('\n');
    // 两边都必须说清三件事
    for (const key of ['写集越界', '未进入 gate', '退回 frozen', 'zelto run slice-a']) {
      assert.ok(ct.includes(key), `紧凑模式也要说「${key}」`);
      assert.ok(ft.includes(key), `完整模式也要说「${key}」`);
    }
  });
});

describe('写集审计失败的提示', () => {
  it('与越界分开说 —— 越界是扩写集，审计失败是修环境', () => {
    const text = auditFailedMessage({ sliceId: 'slice-a' }, 'git 状态读不到').join('\n');
    assert.ok(text.includes('写集审计失败'), '要说清是审计失败，不是越界');
    assert.ok(text.includes('无法确认边界'), '要说清边界是未知的');
    assert.ok(text.includes('git 状态读不到'), '要带上原因');
    assert.ok(text.includes('退回 frozen'), '要说清切片没废');
    assert.ok(text.includes('zelto run slice-a'), '要给下一步的具体命令');
    assert.ok(!text.includes('越界'), '不能把审计失败说成越界 —— 下一步不一样');
  });

  it('紧凑模式同样不与越界混淆', () => {
    const text = auditFailedMessage({ sliceId: 'slice-a', compact: true }, 'boom').join('\n');
    assert.ok(text.includes('写集审计失败'));
    assert.ok(text.includes('boom'));
    assert.ok(!text.includes('写集越界'));
  });
});

describe('预算耗尽的提示', () => {
  it('说清花了多少、上限多少、这一轮不算数', () => {
    const text = budgetExhaustedMessage({ sliceId: 'slice-a' }, 1.234, 1).join('\n');
    assert.ok(text.includes('$1.23'), '要显示已花金额');
    assert.ok(text.includes('上限 $1.00'), '要显示上限');
    assert.ok(text.includes('未进入 gate'), '要说清这一轮不算数');
    assert.ok(text.includes('slice-a'), '要带上切片 id');
  });

  it('不限预算时不显示上限 —— 显示成 $0.00 看着像「一分钱都不许花」', () => {
    const text = budgetExhaustedMessage({ sliceId: 'slice-a' }, 0.5, Number.POSITIVE_INFINITY).join('\n');
    assert.ok(!text.includes('上限'), '不限时不该出现上限字样');
    assert.ok(text.includes('$0.50'));
  });

  it('紧凑模式说同一件事', () => {
    const text = budgetExhaustedMessage({ sliceId: 'slice-a', compact: true }, 1.234, 1).join('\n');
    assert.ok(text.includes('预算耗尽'));
    assert.ok(text.includes('$1.23'));
    assert.ok(text.includes('未进入 gate'));
  });
});

describe('agent 失败的提示', () => {
  it('带上退出码与耗时', () => {
    const text = agentFailedMessage({ sliceId: 'slice-a' }, 2, 1, 30).join('\n');
    assert.ok(text.includes('退出码 2'));
    assert.ok(text.includes('30s'));
  });

  it('重试多次时说明试了几次', () => {
    const text = agentFailedMessage({ sliceId: 'slice-a' }, 1, 3, 90).join('\n');
    assert.ok(text.includes('after 3 attempt(s)'));
  });

  it('被信号杀掉时退出码显示为 signal，不是 null', () => {
    const text = agentFailedMessage({ sliceId: 'slice-a' }, null, 1, 5).join('\n');
    assert.ok(text.includes('signal'));
    assert.ok(!text.includes('null'));
  });
});

describe('printOutcome', () => {
  it('按顺序逐行打印', () => {
    const original = console.log;
    const printed: string[] = [];
    console.log = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    };
    try {
      printOutcome(['第一行', '第二行']);
    } finally {
      console.log = original;
    }
    assert.deepEqual(printed, ['第一行', '第二行']);
  });
});
