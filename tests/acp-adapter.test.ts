// ACP 适配器单元测试（ADR-133）
//
// 这个文件钉住四件事：
//
//   1. **版本协商 fail closed** —— protocolVersion 不匹配一律拒绝，
//      **不降级**（ADR-133 已决）。降级 = 把「不确定是否支持的请求」放过去。
//   2. **事件映射** —— `session/update` 的文本与进展信号抽对；
//      不认识的 update 忽略而不崩。
//   3. **用量口径** —— agent 没报 `cost` 就返回 null（= 没测到），
//      不能返回 0（0 的意思是「确实没花钱」）。
//   4. **依赖作用域** —— `@agentclientprotocol/sdk` 只许在 `src/adapters/acp/`
//      里 import（ADR-133 落地要求第 2 条）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isSupportedProtocolVersion,
  protocolVersionError,
  PROTOCOL_VERSION,
} from '../src/adapters/acp/protocol.js';
import {
  extractAcpText,
  extractAcpCost,
  isProgressUpdate,
} from '../src/adapters/acp/events.js';
import { AcpAdapter, DEFAULT_ACP_COMMAND } from '../src/adapters/acp/index.js';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

// 测试跑在 `dist-test/tests/` 下 —— 仓库根要上两级。
// （上两级而不是一级：一级只到 `dist-test/`，那里没有 `.ts` 源文件，
//   依赖作用域断言会**空跑通过** —— 那是最坏的失败形态。）
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('ACP 版本协商 —— 不匹配就拒绝，不降级（ADR-133 已决）', () => {
  it('当前协议版本被支持', () => {
    assert.equal(typeof PROTOCOL_VERSION, 'number');
    assert.ok(isSupportedProtocolVersion(PROTOCOL_VERSION));
  });

  it('版本号不同 → 不支持', () => {
    assert.equal(isSupportedProtocolVersion(PROTOCOL_VERSION + 1), false);
    assert.equal(isSupportedProtocolVersion(PROTOCOL_VERSION - 1), false);
  });

  it('版本不是数字 → 不支持', () => {
    assert.equal(isSupportedProtocolVersion(undefined), false);
    assert.equal(isSupportedProtocolVersion(Number.NaN), false);
    assert.equal(isSupportedProtocolVersion(Number.POSITIVE_INFINITY), false);
  });

  it('错误信息说明了「拒绝、不降级」', () => {
    const msg = protocolVersionError(99);
    assert.match(msg, /99/);
    assert.match(msg, /拒绝|fail closed/);
    assert.match(msg, /不降级/);
  });
});

describe('ACP 事件映射 —— 文本', () => {
  it('agent_message_chunk 的文本被取出', () => {
    const update = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '做完了' },
    } as unknown as SessionUpdate;
    assert.equal(extractAcpText(update), '做完了');
  });

  it('agent_thought_chunk 的文本也被取出', () => {
    const update = {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '想一下' },
    } as unknown as SessionUpdate;
    assert.equal(extractAcpText(update), '想一下');
  });

  it('图像不是文本 → 不进输出缓冲', () => {
    const update = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'base64...' },
    } as unknown as SessionUpdate;
    assert.equal(extractAcpText(update), '');
  });

  it('tool_call 不产出文本', () => {
    const update = {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: '写文件',
      kind: 'edit',
    } as unknown as SessionUpdate;
    assert.equal(extractAcpText(update), '');
  });

  it('不认识的 update → 空串（不崩）', () => {
    const update = { sessionUpdate: 'some_future_thing' } as unknown as SessionUpdate;
    assert.equal(extractAcpText(update), '');
  });

  it('undefined → 空串', () => {
    assert.equal(extractAcpText(undefined), '');
  });
});

describe('ACP 事件映射 —— 进展信号', () => {
  it('tool_call 算进展', () => {
    const update = {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: '写文件',
    } as unknown as SessionUpdate;
    assert.equal(isProgressUpdate(update), true);
  });

  it('tool_call_update 算进展', () => {
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
    } as unknown as SessionUpdate;
    assert.equal(isProgressUpdate(update), true);
  });

  it('plan / notice / mode 变化**不算**进展', () => {
    // 「agent 在推 plan」不等于「agent 在干活」——
    // 把它算成进展会让空转超时永远不触发。
    for (const kind of ['plan', 'plan_update', 'notice', 'current_mode_update', 'usage_update']) {
      const update = { sessionUpdate: kind } as unknown as SessionUpdate;
      assert.equal(isProgressUpdate(update), false, `${kind} 不应算进展`);
    }
  });
});

describe('ACP 事件映射 —— 用量口径（ADR-035）', () => {
  it('agent 报了 cost → 取出', () => {
    const update = {
      sessionUpdate: 'usage_update',
      used: 1000,
      size: 200000,
      cost: { amount: 0.42, currency: 'USD' },
    } as unknown as SessionUpdate;
    assert.equal(extractAcpCost(update), 0.42);
  });

  it('没报 cost → null（不是 0）', () => {
    const update = {
      sessionUpdate: 'usage_update',
      used: 1000,
      size: 200000,
    } as unknown as SessionUpdate;
    assert.equal(extractAcpCost(update), null);
  });

  it('不是 usage_update → null', () => {
    const update = { sessionUpdate: 'tool_call' } as unknown as SessionUpdate;
    assert.equal(extractAcpCost(update), null);
  });

  it('币种不是 USD → null（不折算、不谎报）', () => {
    const update = {
      sessionUpdate: 'usage_update',
      cost: { amount: 1.5, currency: 'CNY' },
    } as unknown as SessionUpdate;
    assert.equal(
      extractAcpCost(update),
      null,
      '拿别的币种当美元报出去比报 null 更坏',
    );
  });

  it('负数 / 非数字 → null', () => {
    const neg = {
      sessionUpdate: 'usage_update',
      cost: { amount: -1, currency: 'USD' },
    } as unknown as SessionUpdate;
    assert.equal(extractAcpCost(neg), null);

    const nan = {
      sessionUpdate: 'usage_update',
      cost: { amount: Number.NaN, currency: 'USD' },
    } as unknown as SessionUpdate;
    assert.equal(extractAcpCost(nan), null);
  });
});

describe('ACP 适配器 —— 元数据', () => {
  it('C9 主判定点是 permission（不是 hook）', () => {
    const adapter = new AcpAdapter();
    assert.equal(adapter.metadata.capabilities.writeGuard, 'permission');
  });

  it('适配器名是 acp', () => {
    assert.equal(new AcpAdapter().name, 'acp');
  });

  it('默认命令存在', () => {
    assert.ok(DEFAULT_ACP_COMMAND.length > 0);
  });
});

describe('ACP 依赖作用域 —— SDK 只许在 src/adapters/acp/ 里（ADR-133 落地要求 2）', () => {
  it('src/ 下只有 src/adapters/acp/ import 了 @agentclientprotocol/sdk', () => {
    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts')) continue;
        const source = readFileSync(full, 'utf-8');
        if (!source.includes('@agentclientprotocol/sdk')) continue;
        const rel = full.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
        if (!rel.startsWith('src/adapters/acp/')) offenders.push(rel);
      }
    }

    walk(join(REPO_ROOT, 'src'));

    assert.deepEqual(
      offenders,
      [],
      `@agentclientprotocol/sdk 只能被 src/adapters/acp/ import（ADR-133 落地要求 2）：${offenders.join(', ')}`,
    );
  });
});
